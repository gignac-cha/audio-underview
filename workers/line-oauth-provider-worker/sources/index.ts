import {
  LINE_TOKEN_ENDPOINT,
  LINE_USER_INFO_ENDPOINT,
  LINE_ID_TOKEN_VERIFICATION_ENDPOINT,
  LINE_DEFAULT_SCOPES,
  createLINEAuthorizationURL,
  lineIDTokenVerificationResponseSchema,
  lineTokenResponseSchema,
  parseLINEUserFromResponse,
} from '@audio-underview/line-oauth-provider';
import {
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

const logger = createWorkerLogger({
  defaultContext: {
    module: 'line-oauth-provider-worker',
  },
});

const PROVIDER = 'line' as const;

/**
 * The account routes accept an Authorization header and a DELETE, neither of
 * which the shared OAuth preflight (worker-tools) knows about.
 */
const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';

interface Environment extends BaseEnvironment {
  // OAuth (LINE Login channel)
  LINE_CHANNEL_ID: string;
  LINE_CHANNEL_SECRET: string;
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
 * What `/authorize` stores under the CSRF state key. A link flow carries the
 * ticket that stands in for the caller's session JWT.
 */
interface AuthorizationState {
  redirectURI: string;
  linkTicket?: string;
}

/**
 * Outcome of reading the email out of the LINE ID token. `accepted: false`
 * means LINE verified a token issued to a different user than the profile the
 * access token returned, and the login must stop. Every other problem only
 * costs the email.
 */
type VerifiedEmailResult =
  | { accepted: true; email?: string }
  | { accepted: false; subject: string };

function decodeAuthorizationState(storedValue: string): AuthorizationState {
  try {
    const parsed = JSON.parse(storedValue) as Partial<AuthorizationState> | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.redirectURI === 'string') {
      return {
        redirectURI: parsed.redirectURI,
        linkTicket: typeof parsed.linkTicket === 'string' ? parsed.linkTicket : undefined,
      };
    }
  } catch {
    // States written before link tickets existed hold the bare redirect URI.
  }

  return { redirectURI: storedValue };
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

/**
 * LINE keeps the email out of the profile API. It is only in the ID token,
 * which LINE's verify endpoint checks (signature, audience = this channel,
 * expiry) and decodes. The email is optional twice over — the channel needs
 * LINE's approval for the permission and the user may decline it — so a failed
 * verification or a missing address only drops the email. The one thing that
 * stops the login is a verified token whose `sub` is not the user the access
 * token belongs to.
 */
async function readVerifiedEmail(
  environment: Environment,
  idToken: string | undefined,
  userID: string
): Promise<VerifiedEmailResult> {
  if (!idToken) {
    logger.warn('Token response carried no ID token — continuing without email', undefined, {
      function: 'readVerifiedEmail',
    });
    return { accepted: true };
  }

  logger.logRequest('ID token verification request', {
    method: 'POST',
    url: LINE_ID_TOKEN_VERIFICATION_ENDPOINT,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, { function: 'readVerifiedEmail' });

  try {
    const verificationResponse = await fetch(LINE_ID_TOKEN_VERIFICATION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: idToken,
        client_id: environment.LINE_CHANNEL_ID,
      }),
    });

    if (!verificationResponse.ok) {
      const errorData = await verificationResponse.text();
      logger.warn('ID token verification failed — continuing without email', {
        status: verificationResponse.status,
        body: errorData.substring(0, 200),
      }, { function: 'readVerifiedEmail' });
      return { accepted: true };
    }

    const verification = lineIDTokenVerificationResponseSchema.safeParse(await verificationResponse.json());

    if (!verification.success) {
      logger.warn('ID token verification response was malformed — continuing without email', {
        issues: verification.error.issues.map((issue) => issue.path.join('.')),
      }, { function: 'readVerifiedEmail' });
      return { accepted: true };
    }

    if (verification.data.sub !== userID) {
      return { accepted: false, subject: verification.data.sub };
    }

    logger.debug('ID token verified', { hasEmail: !!verification.data.email }, { function: 'readVerifiedEmail' });

    return { accepted: true, email: verification.data.email };
  } catch (verificationError) {
    logger.warn('Error verifying ID token — continuing without email', verificationError, {
      function: 'readVerifiedEmail',
    });
    return { accepted: true };
  }
}

async function handleAuthorize(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const redirectURI = url.searchParams.get('redirect_uri');
  const linkTicket = url.searchParams.get('link_ticket') ?? undefined;

  logger.info('Authorization request received', { redirectURI, isLink: !!linkTicket }, { function: 'handleAuthorize' });

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

  // Link mode carries the ticket into the state and nothing more. It is
  // deliberately NOT gated on a `Referer` here: this endpoint is a cookie-less
  // GET, so an attacker can call it server side with any header they like. The
  // binding that actually holds is checked later, at
  // `POST /accounts/link-confirm` (see `completeLinkCallback`).
  const state = generateState();

  logger.debug('Generated state for CSRF protection', { statePrefix: state.substring(0, 8) }, { function: 'handleAuthorize' });

  const authorizationState: AuthorizationState = { redirectURI, linkTicket };
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, JSON.stringify(authorizationState), { expirationTtl: 300 });

  logger.debug('State stored in KV', undefined, { function: 'handleAuthorize' });

  const authorizationURL = new URL(createLINEAuthorizationURL(
    environment.LINE_CHANNEL_ID,
    `${url.origin}/callback`,
    state,
    { scopes: LINE_DEFAULT_SCOPES }
  ));

  logger.info('Redirecting to LINE authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
    scopes: LINE_DEFAULT_SCOPES,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

/**
 * Link flow, callback half: park what this round trip proved and hand the
 * browser a link code. **Nothing is linked here.**
 *
 * The callback cannot tell the browser that started the flow from one an
 * attacker sent the provider URL to — `/authorize` takes no session, so an
 * attacker could mint a ticket for their own account, start the flow server
 * side, and let the victim finish it. Linking here would put the victim's LINE
 * account on the attacker's account. So it stashes
 * `{uuid, provider, identifier, nonce}` under a 120-second link code and lets
 * the authenticated `POST /accounts/link-confirm` require the nonce (only the
 * initiating browser has it) alongside the code (only this browser has it) and
 * the session JWT.
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

  logger.info('Callback received from LINE', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  const validation = validateCallbackParameters(url, environment.FRONTEND_URL, 'LINE', logger);
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

  // Defence in depth against a state written before /authorize validated the
  // target (a state still in flight across a deploy, or a legacy bare-URI
  // entry): nothing leaves this worker toward an unlisted origin.
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

  try {
    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: LINE_TOKEN_ENDPOINT,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(LINE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${url.origin}/callback`,
        client_id: environment.LINE_CHANNEL_ID,
        client_secret: environment.LINE_CHANNEL_SECRET,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'POST', url: LINE_TOKEN_ENDPOINT },
        { status: tokenResponse.status, statusText: tokenResponse.statusText, body: errorData },
        new Error('Token exchange failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens', logger);
    }

    // LINE answers a failed exchange with a 4xx, so a 200 without an access
    // token is a malformed response rather than a provider error to relay.
    const tokenResult = lineTokenResponseSchema.safeParse(await tokenResponse.json());

    if (!tokenResult.success) {
      logger.error('Token response is missing required fields', new Error('Invalid token response'), {
        function: 'handleCallback',
        metadata: { issues: tokenResult.error.issues.map((issue) => issue.path.join('.')) },
      });
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens', logger);
    }

    const tokens = tokenResult.data;

    logger.info('Token exchange successful', {
      tokenType: tokens.token_type,
      scope: tokens.scope,
      hasIDToken: !!tokens.id_token,
    }, { function: 'handleCallback' });

    logger.logRequest('User info request', {
      method: 'GET',
      url: LINE_USER_INFO_ENDPOINT,
      headers: { Authorization: 'Bearer [REDACTED]' },
    }, { function: 'handleCallback' });

    const userInfoResponse = await fetch(LINE_USER_INFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });

    if (!userInfoResponse.ok) {
      const errorData = await userInfoResponse.text();
      logger.logAPIError(
        'User info fetch failed',
        { method: 'GET', url: LINE_USER_INFO_ENDPOINT },
        { status: userInfoResponse.status, statusText: userInfoResponse.statusText, body: errorData.substring(0, 200) },
        new Error('User info fetch failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        'user_info_failed',
        'Failed to fetch user information from LINE',
        logger
      );
    }

    let profileUser: OAuthUser;
    try {
      profileUser = parseLINEUserFromResponse(await userInfoResponse.json() as Record<string, unknown>);
    } catch (parseError) {
      logger.error('User info response is malformed', parseError, { function: 'handleCallback' });
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        'user_info_failed',
        'Failed to fetch user information from LINE',
        logger
      );
    }

    logger.info('User info fetched successfully', {
      userID: profileUser.id,
      hasPicture: !!profileUser.picture,
    }, { function: 'handleCallback' });

    const identifier = profileUser.id;

    // Link flow — stash this provider identity for confirmation and stop. No
    // account row is written here, and the caller keeps the session it had.
    // The identity comes from the profile the access token returned, so the ID
    // token (only needed for the email) is not consulted.
    if (authorizationState.linkTicket) {
      return await completeLinkCallback(
        environment,
        authorizationState.redirectURI,
        authorizationState.linkTicket,
        identifier
      );
    }

    const verifiedEmail = await readVerifiedEmail(environment, tokens.id_token, identifier);

    if (!verifiedEmail.accepted) {
      logger.error('ID token subject does not match the profile user', new Error('id_token_mismatch'), {
        function: 'handleCallback',
        metadata: { userID: identifier, subject: verifiedEmail.subject },
      });
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        'id_token_mismatch',
        'LINE ID token does not belong to the signed-in user',
        logger
      );
    }

    // Resolve the account UUID. Supabase is authoritative; the KV read-through
    // cache covers a paused/unreachable project for accounts that have logged
    // in before. A brand new account fails closed — there is deliberately no
    // deterministic-UUID fallback, because that fallback split one person's
    // jobs, keys and trials across two identities.
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

    // Only an address LINE put in the verified ID token is passed on. Without
    // one the field is omitted — never filled with a made-up address.
    const user: OAuthUser = verifiedEmail.email
      ? { ...profileUser, email: verifiedEmail.email }
      : profileUser;

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
    logger.error('Unexpected callback error', error, { function: 'handleCallback' });
    return redirectToFrontendWithError(environment.FRONTEND_URL, 'server_error', 'An unexpected error occurred', logger);
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
 * Thin mount of the shared account management routes in front of the standard
 * OAuth handler. worker-tools is shared with every other OAuth worker and must
 * not change, so the extra routing and the widened CORS preflight live here.
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
  serviceName: 'line-oauth-provider-worker',
}));
