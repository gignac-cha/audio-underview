import {
  APPLE_AUTHORIZATION_ENDPOINT,
  APPLE_TOKEN_ENDPOINT,
  APPLE_DEFAULT_SCOPES,
} from '@audio-underview/apple-oauth-provider';
import {
  generateState,
  generateNonce,
  jwtDecode,
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
    module: 'apple-oauth-provider-worker',
  },
});

const PROVIDER = 'apple' as const;

/**
 * The account routes accept an Authorization header and a DELETE, neither of
 * which the shared OAuth preflight (worker-tools) knows about.
 */
const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';

/**
 * Display name for an Apple account that shared neither a name (sent on the
 * first sign-in only) nor an email address. `OAuthUser.name` cannot be empty.
 */
const FALLBACK_DISPLAY_NAME = 'Apple User';

interface Environment extends BaseEnvironment {
  // OAuth
  APPLE_CLIENT_ID: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
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

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
}

interface AppleIDTokenPayload {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
  real_user_status?: number;
}

/** Posted by the browser, not signed by Apple, so every field is unverified. */
interface AppleUserName {
  firstName?: unknown;
  lastName?: unknown;
  middleName?: unknown;
}

/**
 * What `/authorize` stores under the CSRF state key. A link flow carries the
 * ticket that stands in for the caller's session JWT; `nonce` is the OpenID
 * Connect nonce sent to Apple alongside the state.
 */
interface AuthorizationState {
  redirectURI: string;
  nonce?: string;
  linkTicket?: string;
}

function decodeAuthorizationState(storedValue: string): AuthorizationState {
  try {
    const parsed = JSON.parse(storedValue) as Partial<AuthorizationState> | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.redirectURI === 'string') {
      return {
        redirectURI: parsed.redirectURI,
        nonce: typeof parsed.nonce === 'string' ? parsed.nonce : undefined,
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
 * Generate Apple Client Secret JWT
 * Apple requires a JWT signed with ES256 as the client secret
 */
async function generateAppleClientSecret(environment: Environment): Promise<string> {
  logger.debug('Generating Apple client secret JWT', undefined, { function: 'generateAppleClientSecret' });

  const header = {
    alg: 'ES256',
    kid: environment.APPLE_KEY_ID,
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: environment.APPLE_TEAM_ID,
    iat: now,
    exp: now + 15777000, // 6 months (Apple's max)
    aud: 'https://appleid.apple.com',
    sub: environment.APPLE_CLIENT_ID,
  };

  // Base64URL encode
  const base64URLEncode = (data: string): string => {
    return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const encodedHeader = base64URLEncode(JSON.stringify(header));
  const encodedPayload = base64URLEncode(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  // Import private key
  const pemKey = environment.APPLE_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(pemKey), (c) => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  // Sign the data
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(dataToSign)
  );

  // Convert signature to base64URL
  const signatureArray = new Uint8Array(signature);
  const signatureBase64URL = base64URLEncode(String.fromCharCode(...signatureArray));

  logger.info('Client secret generated successfully', { expiresIn: 15777000 }, { function: 'generateAppleClientSecret' });

  return `${dataToSign}.${signatureBase64URL}`;
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

  // The callback delivers `user`, `access_token`, `id_token`, `uuid` and a
  // 24-hour session JWT to this URI. Anything but an operator-listed origin
  // would be handed a full account credential, so an unlisted target is refused
  // before the flow starts rather than at the end.
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
  const nonce = generateNonce();

  logger.debug('Generated state and nonce for CSRF protection', { statePrefix: state.substring(0, 8) }, { function: 'handleAuthorize' });

  const authorizationState: AuthorizationState = { redirectURI, nonce, linkTicket };
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, JSON.stringify(authorizationState), { expirationTtl: 300 });

  logger.debug('State and nonce stored in KV', undefined, { function: 'handleAuthorize' });

  const authorizationURL = new URL(APPLE_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.APPLE_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('scope', APPLE_DEFAULT_SCOPES.join(' '));
  authorizationURL.searchParams.set('state', state);
  authorizationURL.searchParams.set('nonce', nonce);

  // Apple only releases `name` and `email` through `response_mode=form_post`,
  // which turns the callback into a cross-site POST instead of a GET.
  const requiresFormPost = APPLE_DEFAULT_SCOPES.some((scope) => scope === 'name' || scope === 'email');
  authorizationURL.searchParams.set('response_mode', requiresFormPost ? 'form_post' : 'query');

  logger.info('Redirecting to Apple authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
    scopes: APPLE_DEFAULT_SCOPES,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

/**
 * Link flow, callback half: park what this round trip proved and hand the
 * browser a link code. **Nothing is linked here.**
 *
 * `/authorize` takes no session, so an attacker could mint a ticket for their
 * own account, start the flow server side, and send the victim the provider
 * URL — linking straight from the callback would land the victim's Apple
 * account on the attacker's account. The callback cannot tell those two
 * browsers apart, so it does not decide. It stashes
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

/**
 * Apple answers with `response_mode=form_post`, so the callback parameters
 * usually arrive as a POST form body; a query (GET) callback is still read.
 * Either way they are folded into one URL so the shared
 * `validateCallbackParameters` reads them the same way. A POST body that is
 * not a form carries no parameters and is then refused as `invalid_request`.
 */
async function readCallbackURL(request: Request): Promise<URL> {
  const url = new URL(request.url);

  if (request.method !== 'POST') {
    return url;
  }

  const callbackURL = new URL(url.pathname, url.origin);

  try {
    const formData = await request.formData();
    formData.forEach((value, key) => {
      if (typeof value === 'string') {
        callbackURL.searchParams.append(key, value);
      }
    });
  } catch (formError) {
    logger.warn('Callback POST body is not a form', formError, { function: 'handleCallback' });
  }

  return callbackURL;
}

/**
 * Reads the `user` field Apple posts on the first sign-in only
 * (`{"name":{"firstName":…,"lastName":…}}`). Later sign-ins carry none.
 */
function readAppleUserName(userJSON: string | null): AppleUserName | undefined {
  if (!userJSON) {
    return undefined;
  }

  try {
    const userData = JSON.parse(userJSON) as { name?: unknown } | null;
    const name = userData && typeof userData === 'object' ? userData.name : undefined;
    return name && typeof name === 'object' ? (name as AppleUserName) : undefined;
  } catch (userParseError) {
    logger.warn('Failed to parse user JSON', userParseError, { function: 'handleCallback' });
    return undefined;
  }
}

/** First-sign-in name, else the email local part, else a generic label. */
function resolveDisplayName(userName: AppleUserName | undefined, email: string | undefined): string {
  const nameParts = userName
    ? [userName.firstName, userName.middleName, userName.lastName].filter(
        (part): part is string => typeof part === 'string' && part.trim().length > 0
      )
    : [];

  if (nameParts.length > 0) {
    return nameParts.join(' ');
  }

  const emailLocalPart = email?.split('@')[0];
  if (emailLocalPart) {
    return emailLocalPart;
  }

  return FALLBACK_DISPLAY_NAME;
}

/**
 * Handle OAuth callback from Apple
 * Apple can send callbacks via POST (form_post) or GET (query)
 */
async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();
  const callbackURL = await readCallbackURL(request);

  logger.info('Callback received from Apple', {
    method: request.method,
    hasCode: callbackURL.searchParams.has('code'),
    hasState: callbackURL.searchParams.has('state'),
    hasError: callbackURL.searchParams.has('error'),
    hasUser: callbackURL.searchParams.has('user'),
  }, { function: 'handleCallback' });

  const validation = validateCallbackParameters(callbackURL, environment.FRONTEND_URL, 'Apple', logger);
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
    // Generate client secret JWT
    const clientSecret = await generateAppleClientSecret(environment);

    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: APPLE_TOKEN_ENDPOINT,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(APPLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: environment.APPLE_CLIENT_ID,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${url.origin}/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'POST', url: APPLE_TOKEN_ENDPOINT },
        { status: tokenResponse.status, statusText: tokenResponse.statusText, body: errorData },
        new Error('Token exchange failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens', logger);
    }

    const tokens: TokenResponse = await tokenResponse.json();

    logger.info('Token exchange successful', { tokenType: tokens.token_type, hasIDToken: !!tokens.id_token }, { function: 'handleCallback' });

    if (!tokens.id_token) {
      logger.error('Missing ID token in response', undefined, { function: 'handleCallback' });
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'missing_id_token', 'Apple did not return an ID token', logger);
    }

    // Apple has no user info endpoint: the identity is the ID token, which
    // came straight from the token endpoint over TLS.
    logger.debug('Decoding ID token', undefined, { function: 'handleCallback' });
    const decoded = jwtDecode<AppleIDTokenPayload>(tokens.id_token);

    logger.info('ID token decoded successfully', {
      userID: decoded.sub,
      hasEmail: !!decoded.email,
      isPrivateEmail: decoded.is_private_email,
    }, { function: 'handleCallback' });

    // The subject is the account key; without one every such login would
    // collapse onto a single `account/apple/…` entry.
    if (typeof decoded.sub !== 'string' || decoded.sub.length === 0) {
      logger.error('ID token carries no subject', undefined, { function: 'handleCallback' });
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'invalid_id_token', 'Apple returned an ID token without a subject', logger);
    }

    const identifier = decoded.sub;

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

    // Parse user name if provided (only on first sign-in)
    const userName = readAppleUserName(callbackURL.searchParams.get('user'));
    logger.debug('User name data parsed', { hasUserName: !!userName }, { function: 'handleCallback' });

    // Only the address Apple put in the ID token; none is ever made up.
    const email = typeof decoded.email === 'string' && decoded.email.length > 0 ? decoded.email : undefined;

    // Resolve the account UUID. Supabase is authoritative; the KV read-through
    // cache covers a paused/unreachable project for accounts that have logged
    // in before. A brand new account fails closed rather than being handed an
    // invented identity.
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

    const user: OAuthUser = {
      id: identifier,
      email,
      name: resolveDisplayName(userName, email),
      provider: PROVIDER,
    };

    const durationMilliseconds = timer();

    logger.info('OAuth flow completed successfully', {
      userID: user.id,
      email: user.email,
      hasSessionToken: !!sessionToken,
      durationMilliseconds,
    }, { function: 'handleCallback' });

    const frontendURL = new URL(authorizationState.redirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);
    frontendURL.searchParams.set('id_token', tokens.id_token);

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
 *
 * Apple's form_post `POST /callback` falls through untouched: the account
 * routes only claim `/accounts`, `/accounts/…` and `/link-tickets`, and only
 * `POST /accounts/link-confirm` has its body read here, so the callback form
 * body is still unread when `handleCallback` gets it.
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
  serviceName: 'apple-oauth-provider-worker',
}));
