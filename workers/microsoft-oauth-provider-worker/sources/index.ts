import {
  getMicrosoftAuthorizationEndpoint,
  getMicrosoftTokenEndpoint,
  MICROSOFT_USER_INFO_ENDPOINT,
  MICROSOFT_DEFAULT_SCOPES,
} from '@audio-underview/microsoft-oauth-provider';
import {
  generateState,
  generateNonce,
  jwtDecode,
  type OAuthUser,
} from '@audio-underview/sign-provider';
import { createWorkerLogger } from '@audio-underview/logger';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'microsoft-oauth-provider-worker',
  },
});

interface Environment {
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_TENANT: string;
  FRONTEND_URL: string;
  ALLOWED_ORIGINS: string;
  AUDIO_UNDERVIEW_OAUTH_STATE: KVNamespace;
}

interface OAuthErrorResponse {
  error: string;
  errorDescription?: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

interface MicrosoftIDTokenPayload {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  oid?: string;
  tid?: string;
}

interface MicrosoftUserInfo {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  mail?: string;
  userPrincipalName?: string;
}

interface StateData {
  redirectURI: string;
  nonce: string;
}

/**
 * Create CORS headers for the response
 * Only sets full CORS headers when origin is in the allowed list
 */
function createCORSHeaders(origin: string, allowedOrigins: string): Headers {
  const headers = new Headers();
  const origins = allowedOrigins.split(',').map((o) => o.trim());
  const isAllowed = origins.includes(origin) || origins.includes('*');

  if (!isAllowed) {
    logger.debug('Origin not in allowed list', { origin, allowedOrigins }, { function: 'createCORSHeaders' });
    return headers;
  }

  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Allow-Credentials', 'true');

  return headers;
}

/**
 * Create JSON response with CORS headers
 */
function jsonResponse(
  data: unknown,
  status: number,
  origin: string,
  allowedOrigins: string
): Response {
  const headers = createCORSHeaders(origin, allowedOrigins);
  headers.set('Content-Type', 'application/json');

  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * Create error response
 */
function errorResponse(
  error: string,
  errorDescription: string,
  status: number,
  origin: string,
  allowedOrigins: string
): Response {
  logger.error('Error response', new Error(errorDescription), {
    function: 'errorResponse',
    metadata: { error, status },
  });
  return jsonResponse(
    { error, errorDescription } satisfies OAuthErrorResponse,
    status,
    origin,
    allowedOrigins
  );
}

/**
 * Handle OAuth authorization start
 */
async function handleAuthorize(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const redirectURI = url.searchParams.get('redirect_uri');
  const tenant = url.searchParams.get('tenant') ?? environment.MICROSOFT_TENANT;

  logger.info('Authorization request received', { redirectURI, tenant }, { function: 'handleAuthorize' });

  if (!redirectURI) {
    logger.warn('Missing redirect_uri parameter', undefined, { function: 'handleAuthorize' });
    return new Response('Missing redirect_uri parameter', { status: 400 });
  }

  // Generate state and nonce
  const state = generateState();
  const nonce = generateNonce();

  logger.debug('Generated state and nonce for CSRF protection', {
    statePrefix: state.substring(0, 8),
    noncePrefix: nonce.substring(0, 8),
  }, { function: 'handleAuthorize' });

  // Store state data temporarily (5 minutes TTL)
  const stateData: StateData = { redirectURI, nonce };
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, JSON.stringify(stateData), { expirationTtl: 300 });

  logger.debug('State stored in KV', undefined, { function: 'handleAuthorize' });

  // Build authorization URL
  const authorizationEndpoint = getMicrosoftAuthorizationEndpoint(tenant);
  const authorizationURL = new URL(authorizationEndpoint);
  authorizationURL.searchParams.set('client_id', environment.MICROSOFT_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('scope', MICROSOFT_DEFAULT_SCOPES.join(' '));
  authorizationURL.searchParams.set('state', state);
  authorizationURL.searchParams.set('nonce', nonce);
  authorizationURL.searchParams.set('prompt', 'select_account');

  logger.info('Redirecting to Microsoft authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
    tenant,
    scopes: MICROSOFT_DEFAULT_SCOPES,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

/**
 * Handle OAuth callback from Microsoft
 */
async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();

  logger.info('Callback received from Microsoft', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  // Check for error from provider
  const error = url.searchParams.get('error');
  if (error) {
    const errorDescription = url.searchParams.get('error_description') ?? 'Unknown error';
    logger.error('Microsoft returned error', new Error(error), {
      function: 'handleCallback',
      metadata: { error, errorDescription },
    });
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', error);
    frontendURL.searchParams.set('error_description', errorDescription);
    return Response.redirect(frontendURL.toString(), 302);
  }

  // Get authorization code and state
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    logger.error('Missing code or state parameter', undefined, {
      function: 'handleCallback',
      metadata: { hasCode: !!code, hasState: !!state },
    });
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', 'invalid_request');
    frontendURL.searchParams.set('error_description', 'Missing code or state parameter');
    return Response.redirect(frontendURL.toString(), 302);
  }

  // Verify state (CSRF protection)
  const storedStateDataJSON = await environment.AUDIO_UNDERVIEW_OAUTH_STATE.get(state);
  if (!storedStateDataJSON) {
    logger.error('Invalid or expired state parameter', undefined, {
      function: 'handleCallback',
      metadata: { statePrefix: state.substring(0, 8) },
    });
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', 'invalid_state');
    frontendURL.searchParams.set('error_description', 'Invalid or expired state parameter');
    return Response.redirect(frontendURL.toString(), 302);
  }

  const stateData: StateData = JSON.parse(storedStateDataJSON);

  logger.debug('State verified successfully', undefined, { function: 'handleCallback' });

  // Delete used state
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.delete(state);

  try {
    // Exchange code for tokens
    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

    const tokenEndpoint = getMicrosoftTokenEndpoint(environment.MICROSOFT_TENANT);

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: tokenEndpoint,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: environment.MICROSOFT_CLIENT_ID,
        client_secret: environment.MICROSOFT_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${url.origin}/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'POST', url: tokenEndpoint },
        { status: tokenResponse.status, statusText: tokenResponse.statusText, body: errorData },
        new Error('Token exchange failed'),
        { function: 'handleCallback' }
      );
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', 'token_exchange_failed');
      frontendURL.searchParams.set('error_description', 'Failed to exchange authorization code for tokens');
      return Response.redirect(frontendURL.toString(), 302);
    }

    const tokens: TokenResponse = await tokenResponse.json();

    logger.info('Token exchange successful', {
      tokenType: tokens.token_type,
      hasIDToken: !!tokens.id_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
    }, { function: 'handleCallback' });

    // Get user info
    let user: OAuthUser;

    if (tokens.id_token) {
      // Decode ID token to get user info
      logger.info('Decoding ID token to get user info', undefined, { function: 'handleCallback' });

      const decoded = jwtDecode<MicrosoftIDTokenPayload>(tokens.id_token);
      const email = decoded.email ?? decoded.preferred_username ?? '';
      const name = decoded.name ?? decoded.given_name ?? email.split('@')[0] ?? '';

      logger.info('ID token decoded successfully', {
        userID: decoded.sub,
        email,
        hasName: !!decoded.name,
        oid: decoded.oid,
        tid: decoded.tid,
      }, { function: 'handleCallback' });

      user = {
        id: decoded.sub,
        email,
        name,
        provider: 'microsoft',
      };
    } else {
      // Fallback: fetch user info from Microsoft Graph API
      logger.info('ID token not available, fetching user info from Graph API', undefined, { function: 'handleCallback' });

      logger.logRequest('User info request', {
        method: 'GET',
        url: MICROSOFT_USER_INFO_ENDPOINT,
        headers: { Authorization: 'Bearer [REDACTED]' },
      }, { function: 'handleCallback' });

      const userInfoResponse = await fetch(MICROSOFT_USER_INFO_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });

      if (!userInfoResponse.ok) {
        const errorData = await userInfoResponse.text();
        logger.logAPIError(
          'User info fetch failed',
          { method: 'GET', url: MICROSOFT_USER_INFO_ENDPOINT },
          { status: userInfoResponse.status, statusText: userInfoResponse.statusText, body: errorData.substring(0, 200) },
          new Error('User info fetch failed'),
          { function: 'handleCallback' }
        );
        const frontendURL = new URL(environment.FRONTEND_URL);
        frontendURL.searchParams.set('error', 'user_info_failed');
        frontendURL.searchParams.set('error_description', 'Failed to fetch user information');
        return Response.redirect(frontendURL.toString(), 302);
      }

      const userInfo: MicrosoftUserInfo = await userInfoResponse.json();
      const email = userInfo.mail ?? userInfo.userPrincipalName ?? '';
      const name = userInfo.displayName ?? [userInfo.givenName, userInfo.surname].filter(Boolean).join(' ') ?? '';

      logger.info('User info fetched successfully', {
        userID: userInfo.id,
        email,
        hasDisplayName: !!userInfo.displayName,
      }, { function: 'handleCallback' });

      user = {
        id: userInfo.id,
        email,
        name,
        provider: 'microsoft',
      };
    }

    const durationMilliseconds = timer();

    logger.info('OAuth flow completed successfully', {
      userID: user.id,
      email: user.email,
      durationMilliseconds,
    }, { function: 'handleCallback' });

    // Redirect to frontend with user data
    const frontendURL = new URL(stateData.redirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);
    if (tokens.id_token) {
      frontendURL.searchParams.set('id_token', tokens.id_token);
    }

    return Response.redirect(frontendURL.toString(), 302);
  } catch (error) {
    logger.error('Unexpected callback error', error, { function: 'handleCallback' });
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', 'server_error');
    frontendURL.searchParams.set('error_description', 'An unexpected error occurred');
    return Response.redirect(frontendURL.toString(), 302);
  }
}

/**
 * Handle CORS preflight requests
 */
function handleOptions(request: Request, environment: Environment): Response {
  const origin = request.headers.get('Origin') ?? '';
  logger.debug('CORS preflight request', { origin }, { function: 'handleOptions' });
  const headers = createCORSHeaders(origin, environment.ALLOWED_ORIGINS);
  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? environment.FRONTEND_URL;

    logger.info('Request received', {
      method: request.method,
      pathname: url.pathname,
      origin,
    }, { function: 'fetch' });

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions(request, environment);
    }

    try {
      switch (url.pathname) {
        case '/authorize':
          return handleAuthorize(request, environment);

        case '/callback':
          return handleCallback(request, environment);

        case '/health':
          logger.debug('Health check requested', undefined, { function: 'fetch' });
          return jsonResponse({ status: 'healthy', provider: 'microsoft' }, 200, origin, environment.ALLOWED_ORIGINS);

        default:
          logger.warn('Unknown endpoint requested', { pathname: url.pathname }, { function: 'fetch' });
          return errorResponse('not_found', 'Endpoint not found', 404, origin, environment.ALLOWED_ORIGINS);
      }
    } catch (error) {
      logger.error('Unhandled worker error', error, { function: 'fetch' });
      return errorResponse(
        'server_error',
        'An unexpected error occurred',
        500,
        origin,
        environment.ALLOWED_ORIGINS
      );
    }
  },
};
