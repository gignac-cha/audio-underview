import {
  BLUESKY_CALLBACK_PATH,
  BLUESKY_CLIENT_METADATA_PATH,
  BLUESKY_DEFAULT_SCOPES,
  BLUESKY_JWKS_PATH,
  BLUESKY_USER_INFO_PATH,
  createBlueskyAuthorizationURL,
  createBlueskyClientMetadata,
  normalizeBlueskyHandle,
  parseBlueskyCallbackParameters,
  parseBlueskyUserFromResponse,
} from '@audio-underview/bluesky-oauth-provider';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  type OAuthUser,
} from '@audio-underview/sign-provider';
import { createWorkerLogger } from '@audio-underview/logger';
import { instrumentWorker } from '@audio-underview/axiom-logger';
import {
  accountRouteRequiresBody,
  consumeLinkTicket,
  createSessionTokenPayload,
  createSupabaseClient,
  handleAccountRoute,
  isAllowedRedirectURI,
  isValidOAuthState,
  parseAllowedOrigins,
  resolveLoginAccount,
  stashLinkCode,
} from '@audio-underview/supabase-connector';
import {
  type BaseEnvironment,
  type ResponseContext,
  createCORSHeaders,
  createOAuthWorkerHandler,
  errorResponse,
  jsonResponse,
  validateCallbackParameters,
  verifyState,
  redirectToFrontendWithError,
  signJWT,
  verifyJWT,
} from '@audio-underview/worker-tools';
import {
  BlueskyFlowError,
  discoverAuthorizationServer,
  exchangeAuthorizationCode,
  fetchAuthorizationServerMetadata,
  fetchSession,
  generateDPoPKey,
  importClientSigningKey,
  isDPoPPrivateJWK,
  pushAuthorizationRequest,
  resolveIdentity,
  restoreDPoPKey,
  type DPoPPrivateJWK,
} from './atproto-oauth.ts';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'bluesky-oauth-provider-worker',
  },
});

const PROVIDER = 'bluesky' as const;

/**
 * The account routes accept an Authorization header and a DELETE, neither of
 * which the shared OAuth preflight (worker-tools) knows about.
 */
const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';

interface Environment extends BaseEnvironment {
  // OAuth — ES256 private JWK (with kid) that signs client assertions. There
  // is no client id secret: the client id is this worker's metadata URL.
  BLUESKY_CLIENT_PRIVATE_JWK: string;
  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  // Axiom
  AXIOM_API_TOKEN: string;
  AXIOM_DATASET: string;
  // Session tokens — optional so the worker keeps working (minus session
  // tokens) until the operator sets the same JWT_SECRET as the pipeline.
  JWT_SECRET?: string;
}

/**
 * What `/authorize` stores under the CSRF state key. Besides the redirect
 * target and the optional link ticket, an AT Protocol login has to carry its
 * PKCE verifier, its DPoP key and the identity it was started for across the
 * browser round trip, so the callback can finish the flow with the same key
 * and refuse any other account or server.
 */
interface AuthorizationState {
  redirectURI: string;
  linkTicket?: string;
  codeVerifier: string;
  dpopPrivateJWK: DPoPPrivateJWK;
  /** Account DID resolved from the handle; the token `sub` must match it. */
  did: string;
  pdsURL: string;
  /** Authorization server issuer; the callback `iss` must match it. */
  issuer: string;
  /** Last `DPoP-Nonce` the authorization server handed out. */
  dpopNonce?: string;
}

/**
 * Decodes a stored state. This worker has never written anything but the
 * JSON shape above, so any other value is treated as an invalid state.
 */
function decodeAuthorizationState(storedValue: string): AuthorizationState | undefined {
  let parsed: Partial<AuthorizationState> | null;
  try {
    parsed = JSON.parse(storedValue) as Partial<AuthorizationState> | null;
  } catch {
    return undefined;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.redirectURI !== 'string' ||
    typeof parsed.codeVerifier !== 'string' ||
    !isDPoPPrivateJWK(parsed.dpopPrivateJWK) ||
    typeof parsed.did !== 'string' ||
    typeof parsed.pdsURL !== 'string' ||
    typeof parsed.issuer !== 'string'
  ) {
    return undefined;
  }

  return {
    redirectURI: parsed.redirectURI,
    linkTicket: typeof parsed.linkTicket === 'string' ? parsed.linkTicket : undefined,
    codeVerifier: parsed.codeVerifier,
    dpopPrivateJWK: parsed.dpopPrivateJWK,
    did: parsed.did,
    pdsURL: parsed.pdsURL,
    issuer: parsed.issuer,
    dpopNonce: typeof parsed.dpopNonce === 'string' ? parsed.dpopNonce : undefined,
  };
}

function createConnectorClient(environment: Environment) {
  return createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });
}

function createSessionTokenVerifier(environment: Environment) {
  const secret = environment.JWT_SECRET;
  if (!secret) {
    return undefined;
  }

  return (token: string) => verifyJWT(token, secret);
}

/**
 * Mints the session JWT the SPA will use as its credential. Returns undefined
 * when JWT_SECRET is unset — login then degrades to the previous behaviour
 * (raw provider token only) instead of failing.
 */
async function issueSessionToken(
  environment: Environment,
  userUUID: string
): Promise<string | undefined> {
  const secret = environment.JWT_SECRET;

  if (!secret) {
    logger.warn('JWT_SECRET is not configured — issuing no session token', undefined, {
      function: 'issueSessionToken',
    });
    return undefined;
  }

  return signJWT(
    createSessionTokenPayload({ userUUID, provider: PROVIDER }),
    secret
  );
}

/** Origins the operator trusts to start a flow and to receive its result. */
function trustedOrigins(environment: Environment): Set<string> {
  return parseAllowedOrigins(environment.ALLOWED_ORIGINS, environment.FRONTEND_URL);
}

/** The client id is the URL of this worker's own client metadata document. */
function clientIDFor(origin: string): string {
  return `${origin}${BLUESKY_CLIENT_METADATA_PATH}`;
}

function redirectURIFor(origin: string): string {
  return `${origin}${BLUESKY_CALLBACK_PATH}`;
}

function redirectWithFlowError(environment: Environment, error: BlueskyFlowError, functionName: string): Response {
  logger.warn('Bluesky flow step failed', {
    code: error.code,
    description: error.message,
    details: error.details,
  }, { function: functionName });

  return redirectToFrontendWithError(environment.FRONTEND_URL, error.code, error.message, logger);
}

async function handleAuthorize(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const redirectURI = url.searchParams.get('redirect_uri');
  const linkTicket = url.searchParams.get('link_ticket') ?? undefined;
  const handleParameter = url.searchParams.get('handle');

  logger.info('Authorization request received', {
    redirectURI,
    isLink: !!linkTicket,
    hasHandle: !!handleParameter,
  }, { function: 'handleAuthorize' });

  if (!redirectURI) {
    logger.warn('Missing redirect_uri parameter', undefined, { function: 'handleAuthorize' });
    return new Response('Missing redirect_uri parameter', { status: 400 });
  }

  const allowedOrigins = trustedOrigins(environment);

  // The callback delivers `user`, `access_token`, `uuid` and a 24-hour session
  // JWT to this URI. Anything but an operator-listed origin would be handed a
  // full account credential, so an unlisted target is refused before the flow
  // starts rather than at the end.
  if (!isAllowedRedirectURI(redirectURI, allowedOrigins)) {
    logger.warn('redirect_uri is not an allowed origin', { redirectURI }, { function: 'handleAuthorize' });
    return new Response('redirect_uri is not an allowed origin', { status: 400 });
  }

  // AT Protocol has no central authorization server: the handle decides which
  // PDS (and so which authorization server) the login goes to.
  if (!handleParameter) {
    logger.warn('Missing handle parameter', undefined, { function: 'handleAuthorize' });
    return new Response('Missing handle parameter', { status: 400 });
  }

  const handle = normalizeBlueskyHandle(handleParameter);
  if (!handle) {
    logger.warn('handle is not a valid Bluesky handle', { handle: handleParameter }, { function: 'handleAuthorize' });
    return new Response('Invalid handle parameter', { status: 400 });
  }

  try {
    // Checked before any outbound request so a misconfigured worker fails fast.
    const clientKey = await importClientSigningKey(environment.BLUESKY_CLIENT_PRIVATE_JWK);

    const identity = await resolveIdentity(handle);
    logger.debug('Handle resolved', { handle, did: identity.did, pdsURL: identity.pdsURL }, { function: 'handleAuthorize' });

    const metadata = await discoverAuthorizationServer(identity.pdsURL);
    logger.debug('Authorization server discovered', { issuer: metadata.issuer }, { function: 'handleAuthorize' });

    // Link mode carries the ticket into the state and nothing more. It is
    // deliberately NOT gated on a `Referer` here: this endpoint is a cookie-less
    // GET, so an attacker can call it server side with any header they like. The
    // binding that actually holds is checked later, at
    // `POST /accounts/link-confirm` (see `completeLinkCallback`).
    const state = generateState();

    logger.debug('Generated state for CSRF protection', { statePrefix: state.substring(0, 8) }, { function: 'handleAuthorize' });

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const dpop = await generateDPoPKey();
    const clientID = clientIDFor(url.origin);

    const pushedRequest = await pushAuthorizationRequest({
      metadata,
      clientKey,
      clientID,
      redirectURI: redirectURIFor(url.origin),
      scope: BLUESKY_DEFAULT_SCOPES.join(' '),
      state,
      codeChallenge,
      loginHint: handle,
      dpopKey: dpop.key,
    });

    const authorizationState: AuthorizationState = {
      redirectURI,
      linkTicket,
      codeVerifier,
      dpopPrivateJWK: dpop.privateJWK,
      did: identity.did,
      pdsURL: identity.pdsURL,
      issuer: metadata.issuer,
      dpopNonce: pushedRequest.nonce,
    };
    await environment.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, JSON.stringify(authorizationState), { expirationTtl: 300 });

    logger.debug('State stored in KV', undefined, { function: 'handleAuthorize' });

    const authorizationURL = createBlueskyAuthorizationURL(clientID, pushedRequest.requestURI, {
      authorizationEndpoint: metadata.authorization_endpoint,
    });

    logger.info('Redirecting to Bluesky authorization', {
      authorizationEndpoint: metadata.authorization_endpoint,
      scopes: BLUESKY_DEFAULT_SCOPES,
    }, { function: 'handleAuthorize' });

    return Response.redirect(authorizationURL, 302);
  } catch (error) {
    if (error instanceof BlueskyFlowError) {
      return redirectWithFlowError(environment, error, 'handleAuthorize');
    }
    throw error;
  }
}

/**
 * Link flow, callback half: park what this round trip proved and hand the
 * browser a link code. **Nothing is linked here.**
 *
 * `/authorize` takes no session, so an attacker could mint a ticket for their
 * own account, start the flow server side, and send the victim the provider
 * URL — linking here would put the victim's Bluesky account on the attacker's
 * account. The callback cannot tell those two browsers apart, so it does not
 * decide. It stashes `{uuid, provider, identifier, nonce}` under a 120-second
 * link code and lets the authenticated `POST /accounts/link-confirm` require
 * the nonce (only the initiating browser has it) alongside the code (only this
 * browser has it) and the session JWT.
 *
 * No session token, no raw provider token and no uuid go into the redirect —
 * linking is not a login, and the URL is the one thing the attacker may see.
 */
async function completeLinkCallback(
  environment: Environment,
  redirectURI: string,
  linkTicket: string,
  identifier: string
): Promise<Response> {
  const linkURL = new URL(redirectURI);
  linkURL.searchParams.set('provider', PROVIDER);

  const binding = await consumeLinkTicket(environment.AUDIO_UNDERVIEW_OAUTH_STATE, linkTicket);

  if (!binding) {
    logger.warn('Link ticket was missing, expired or already used', undefined, { function: 'completeLinkCallback' });
    linkURL.searchParams.set('link_result', 'expired');
    return Response.redirect(linkURL.toString(), 302);
  }

  try {
    const linkCode = await stashLinkCode(environment.AUDIO_UNDERVIEW_OAUTH_STATE, {
      userUUID: binding.userUUID,
      provider: PROVIDER,
      identifier,
      nonce: binding.nonce,
    });

    logger.info('Provider identity stashed for confirmation', undefined, { function: 'completeLinkCallback' });
    linkURL.searchParams.set('link_code', linkCode);
  } catch (stashError) {
    logger.error('Could not stash the provider identity', stashError, { function: 'completeLinkCallback' });
    linkURL.searchParams.set('link_result', 'failed');
  }

  return Response.redirect(linkURL.toString(), 302);
}

async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();

  logger.info('Callback received from Bluesky', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasIssuer: url.searchParams.has('iss'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  const validation = validateCallbackParameters(url, environment.FRONTEND_URL, 'Bluesky', logger);
  if (!validation.success) return validation.response;
  const { code, state } = validation.parameters;

  // The shared verifyState reads and then DELETES whatever KV key it is given,
  // and this namespace also holds `account/{provider}/{identifier}` cache
  // entries. Refusing every state that is not generateState()'s exact shape
  // keeps an unauthenticated caller from naming one of those keys and wiping
  // the Supabase-outage fallback for an account of their choosing.
  if (!isValidOAuthState(state)) {
    logger.warn('State parameter is not the expected shape', {
      statePrefix: state.substring(0, 8),
    }, { function: 'handleCallback' });
    return redirectToFrontendWithError(
      environment.FRONTEND_URL,
      'invalid_state',
      'Invalid or expired state parameter',
      logger
    );
  }

  const stateResult = await verifyState(state, environment.AUDIO_UNDERVIEW_OAUTH_STATE, environment.FRONTEND_URL, logger);
  if (!stateResult.success) return stateResult.response;
  const authorizationState = decodeAuthorizationState(stateResult.storedValue);

  if (!authorizationState) {
    logger.warn('Stored state is not a Bluesky authorization state', undefined, { function: 'handleCallback' });
    return redirectToFrontendWithError(
      environment.FRONTEND_URL,
      'invalid_state',
      'Invalid or expired state parameter',
      logger
    );
  }

  // Defence in depth against a state written before /authorize validated the
  // target: nothing leaves this worker toward an unlisted origin.
  if (!isAllowedRedirectURI(authorizationState.redirectURI, trustedOrigins(environment))) {
    logger.warn('Stored redirect_uri is not an allowed origin', {
      redirectURI: authorizationState.redirectURI,
    }, { function: 'handleCallback' });
    return redirectToFrontendWithError(
      environment.FRONTEND_URL,
      'invalid_redirect_uri',
      'redirect_uri is not an allowed origin',
      logger
    );
  }

  // RFC 9207: the authorization server names itself in `iss`. A response from
  // any server other than the one this login was pushed to is refused before
  // the code goes anywhere (authorization server mix-up).
  const { issuer } = parseBlueskyCallbackParameters(url);
  if (issuer !== authorizationState.issuer) {
    logger.warn('Callback issuer does not match the authorization server', {
      expected: authorizationState.issuer,
      actual: issuer,
    }, { function: 'handleCallback' });
    return redirectToFrontendWithError(
      environment.FRONTEND_URL,
      'issuer_mismatch',
      'The authorization response came from an unexpected server',
      logger
    );
  }

  try {
    const clientKey = await importClientSigningKey(environment.BLUESKY_CLIENT_PRIVATE_JWK);
    const dpopKey = await restoreDPoPKey(authorizationState.dpopPrivateJWK);
    const metadata = await fetchAuthorizationServerMetadata(authorizationState.issuer);

    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: metadata.token_endpoint,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: '[REDACTED]' },
    }, { function: 'handleCallback' });

    const exchange = await exchangeAuthorizationCode({
      metadata,
      clientKey,
      clientID: clientIDFor(url.origin),
      redirectURI: redirectURIFor(url.origin),
      code,
      codeVerifier: authorizationState.codeVerifier,
      dpopKey,
      nonce: authorizationState.dpopNonce,
    });
    const { tokens } = exchange;

    logger.info('Token exchange successful', { tokenType: tokens.token_type, scope: tokens.scope }, { function: 'handleCallback' });

    // The token response is only trustworthy for the account this login was
    // resolved to: the authorization server was verified as authoritative for
    // that DID, not for whatever `sub` it returns.
    if (tokens.sub !== authorizationState.did) {
      logger.warn('Token subject does not match the resolved DID', {
        expected: authorizationState.did,
        actual: tokens.sub,
      }, { function: 'handleCallback' });
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        'subject_mismatch',
        'The authorization server returned a different account',
        logger
      );
    }

    const identifier = tokens.sub;

    // Link flow — stash this provider identity for confirmation and stop. No
    // account row is written here, and the caller keeps the session it had.
    if (authorizationState.linkTicket) {
      return await completeLinkCallback(
        environment,
        authorizationState.redirectURI,
        authorizationState.linkTicket,
        identifier
      );
    }

    logger.logRequest('User info request', {
      method: 'GET',
      url: `${authorizationState.pdsURL}${BLUESKY_USER_INFO_PATH}`,
      headers: { Authorization: 'DPoP [REDACTED]', DPoP: '[REDACTED]' },
    }, { function: 'handleCallback' });

    // Nonces are tracked per server: the authorization server's nonce is only
    // worth sending to the PDS when they are the same server.
    const session = await fetchSession({
      pdsURL: authorizationState.pdsURL,
      accessToken: tokens.access_token,
      dpopKey,
      nonce: authorizationState.pdsURL === authorizationState.issuer ? exchange.nonce : undefined,
    });

    if (session.did !== identifier) {
      logger.warn('Session DID does not match the token subject', undefined, { function: 'handleCallback' });
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        'subject_mismatch',
        'The authorization server returned a different account',
        logger
      );
    }

    logger.info('User info fetched successfully', {
      did: session.did,
      handle: session.handle,
      hasEmail: !!session.email,
    }, { function: 'handleCallback' });

    // Resolve the account UUID. Supabase is authoritative; the KV read-through
    // cache covers a paused/unreachable project for accounts that have logged
    // in before. A brand new account fails closed.
    const resolution = await resolveLoginAccount({
      storage: environment.AUDIO_UNDERVIEW_OAUTH_STATE,
      createClient: () => createConnectorClient(environment),
      input: { provider: PROVIDER, identifier },
      onSupabaseError: (supabaseError) => {
        logger.warn('Supabase social login unavailable — trying the account cache', {
          userID: identifier,
          reason: supabaseError instanceof Error ? supabaseError.message : String(supabaseError),
        }, { function: 'handleCallback' });
      },
    });

    if (!resolution.resolved) {
      logger.error('Could not resolve an account UUID', new Error('account_unavailable'), {
        function: 'handleCallback',
        metadata: { userID: identifier },
      });
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        'account_unavailable',
        'Account service is temporarily unavailable. Please try again shortly.',
        logger
      );
    }

    logger.info('Social login handled', {
      userUUID: resolution.userUUID,
      source: resolution.source,
      isNewUser: resolution.isNewUser,
      isNewAccount: resolution.isNewAccount,
    }, { function: 'handleCallback' });

    const sessionToken = await issueSessionToken(environment, resolution.userUUID);

    // DID as id, handle as name, no picture, and the email only when the PDS
    // returned one (it does so under `transition:email`).
    const user: OAuthUser = parseBlueskyUserFromResponse(session);

    const durationMilliseconds = timer();

    logger.info('OAuth flow completed successfully', {
      userID: user.id,
      hasEmail: !!user.email,
      hasSessionToken: !!sessionToken,
      durationMilliseconds,
    }, { function: 'handleCallback' });

    const frontendURL = new URL(authorizationState.redirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);

    // Resolved Supabase account UUID (also the `sub` of the session token).
    frontendURL.searchParams.set('uuid', resolution.userUUID);

    if (sessionToken) {
      frontendURL.searchParams.set('session_token', sessionToken);
    }

    return Response.redirect(frontendURL.toString(), 302);
  } catch (error) {
    if (error instanceof BlueskyFlowError) {
      return redirectWithFlowError(environment, error, 'handleCallback');
    }
    logger.error('Unexpected callback error', error, { function: 'handleCallback' });
    return redirectToFrontendWithError(environment.FRONTEND_URL, 'server_error', 'An unexpected error occurred', logger);
  }
}

/**
 * `/jwks.json` — the public half of `BLUESKY_CLIENT_PRIVATE_JWK`, which
 * authorization servers use to verify this client's assertions.
 */
async function handleJWKS(environment: Environment, context: ResponseContext): Promise<Response> {
  try {
    const clientKey = await importClientSigningKey(environment.BLUESKY_CLIENT_PRIVATE_JWK);
    return jsonResponse({ keys: [clientKey.publicJWK] }, 200, context);
  } catch (error) {
    if (error instanceof BlueskyFlowError) {
      return errorResponse(error.code, error.message, 503, context);
    }
    throw error;
  }
}

/**
 * Reads the JSON body for the one account route that takes one
 * (`POST /accounts/link-confirm`). A body that will not parse is passed on as
 * undefined, which the route answers exactly like a missing `link_code`.
 */
async function readAccountRouteBody(request: Request, pathname: string): Promise<unknown> {
  if (!accountRouteRequiresBody(request.method, pathname)) {
    return undefined;
  }

  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

const oauthHandler = createOAuthWorkerHandler<Environment>({
  provider: PROVIDER,
  logger,
  handlers: { handleAuthorize, handleCallback },
});

/**
 * Thin mount of the client metadata documents and the shared account
 * management routes in front of the standard OAuth handler. worker-tools is
 * shared with every other OAuth worker and must not change, so the extra
 * routing and the widened CORS preflight live here.
 */
const handler = {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? environment.FRONTEND_URL;
    const context: ResponseContext = {
      origin,
      allowedOrigins: environment.ALLOWED_ORIGINS,
      logger,
    };

    if (request.method === 'OPTIONS') {
      const headers = createCORSHeaders(
        request.headers.get('Origin') ?? '',
        environment.ALLOWED_ORIGINS,
        logger
      );

      if (headers.has('Access-Control-Allow-Origin')) {
        headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
        headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        headers.set('Access-Control-Max-Age', '86400');
      }

      return new Response(null, { status: 204, headers });
    }

    // Client ID metadata document: authorization servers fetch it to register
    // this worker as a confidential client. Its URL is the client id.
    if (request.method === 'GET' && url.pathname === BLUESKY_CLIENT_METADATA_PATH) {
      return jsonResponse(createBlueskyClientMetadata(url.origin), 200, context);
    }

    if (request.method === 'GET' && url.pathname === BLUESKY_JWKS_PATH) {
      try {
        return await handleJWKS(environment, context);
      } catch (error) {
        logger.error('Unhandled JWKS error', error, { function: 'fetch' });
        return errorResponse('server_error', 'An unexpected error occurred', 500, context);
      }
    }

    try {
      const accountRouteResult = await handleAccountRoute(
        {
          method: request.method,
          pathname: url.pathname,
          authorizationHeader: request.headers.get('Authorization'),
          body: await readAccountRouteBody(request, url.pathname),
        },
        {
          verifyToken: createSessionTokenVerifier(environment),
          storage: environment.AUDIO_UNDERVIEW_OAUTH_STATE,
          createClient: () => createConnectorClient(environment),
          onError: (error, errorContext) => {
            logger.error('Account route failed', error, {
              function: 'fetch',
              metadata: errorContext,
            });
          },
        }
      );

      if (accountRouteResult) {
        return jsonResponse(accountRouteResult.body, accountRouteResult.status, context);
      }
    } catch (error) {
      logger.error('Unhandled account route error', error, { function: 'fetch' });
      return errorResponse('server_error', 'An unexpected error occurred', 500, context);
    }

    return oauthHandler.fetch(request, environment);
  },
};

export default instrumentWorker(handler, (environment) => ({
  token: environment.AXIOM_API_TOKEN,
  dataset: environment.AXIOM_DATASET,
  serviceName: 'bluesky-oauth-provider-worker',
}));
