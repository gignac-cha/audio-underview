import {
  FACEBOOK_AUTHORIZATION_ENDPOINT,
  FACEBOOK_TOKEN_ENDPOINT,
  FACEBOOK_USER_INFO_ENDPOINT,
  FACEBOOK_DEFAULT_SCOPES,
} from '@audio-underview/facebook-oauth-provider';
import {
  generateState,
  type OAuthUser,
} from '@audio-underview/sign-provider';
import { createWorkerLogger } from '@audio-underview/logger';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'facebook-oauth-provider-worker',
  },
});

interface Environment {
  FACEBOOK_CLIENT_ID: string;
  FACEBOOK_CLIENT_SECRET: string;
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
}

interface FacebookUserInfo {
  id: string;
  email?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  picture?: {
    data: {
      url: string;
      width?: number;
      height?: number;
      is_silhouette?: boolean;
    };
  };
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

  logger.info('Authorization request received', { redirectURI }, { function: 'handleAuthorize' });

  if (!redirectURI) {
    logger.warn('Missing redirect_uri parameter', undefined, { function: 'handleAuthorize' });
    return new Response('Missing redirect_uri parameter', { status: 400 });
  }

  // Generate state for CSRF protection
  const state = generateState();

  logger.debug('Generated state for CSRF protection', { statePrefix: state.substring(0, 8) }, { function: 'handleAuthorize' });

  // Store state temporarily (5 minutes TTL)
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, redirectURI, { expirationTtl: 300 });

  logger.debug('State stored in KV', undefined, { function: 'handleAuthorize' });

  // Build authorization URL
  // Facebook uses comma-separated scopes
  const authorizationURL = new URL(FACEBOOK_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.FACEBOOK_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('scope', FACEBOOK_DEFAULT_SCOPES.join(','));
  authorizationURL.searchParams.set('state', state);

  logger.info('Redirecting to Facebook authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
    scopes: FACEBOOK_DEFAULT_SCOPES,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

/**
 * Handle OAuth callback from Facebook
 */
async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();

  logger.info('Callback received from Facebook', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  // Check for error from provider
  const error = url.searchParams.get('error');
  if (error) {
    const errorDescription = url.searchParams.get('error_description') ?? 'Unknown error';
    logger.error('Facebook returned error', new Error(error), {
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
  const storedRedirectURI = await environment.AUDIO_UNDERVIEW_OAUTH_STATE.get(state);
  if (!storedRedirectURI) {
    logger.error('Invalid or expired state parameter', undefined, {
      function: 'handleCallback',
      metadata: { statePrefix: state.substring(0, 8) },
    });
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', 'invalid_state');
    frontendURL.searchParams.set('error_description', 'Invalid or expired state parameter');
    return Response.redirect(frontendURL.toString(), 302);
  }

  logger.debug('State verified successfully', undefined, { function: 'handleCallback' });

  // Delete used state
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.delete(state);

  try {
    // Exchange code for tokens
    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

    const tokenURL = new URL(FACEBOOK_TOKEN_ENDPOINT);
    tokenURL.searchParams.set('client_id', environment.FACEBOOK_CLIENT_ID);
    tokenURL.searchParams.set('client_secret', environment.FACEBOOK_CLIENT_SECRET);
    tokenURL.searchParams.set('code', code);
    tokenURL.searchParams.set('redirect_uri', `${url.origin}/callback`);

    logger.logRequest('Token exchange request', {
      method: 'GET',
      url: FACEBOOK_TOKEN_ENDPOINT,
      headers: {},
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(tokenURL.toString(), {
      method: 'GET',
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'GET', url: FACEBOOK_TOKEN_ENDPOINT },
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

    logger.info('Token exchange successful', { tokenType: tokens.token_type, expiresIn: tokens.expires_in }, { function: 'handleCallback' });

    // Fetch user info from Facebook Graph API
    const userInfoURL = new URL(FACEBOOK_USER_INFO_ENDPOINT);
    userInfoURL.searchParams.set('fields', 'id,email,name,first_name,last_name,picture');
    userInfoURL.searchParams.set('access_token', tokens.access_token);

    logger.logRequest('User info request', {
      method: 'GET',
      url: FACEBOOK_USER_INFO_ENDPOINT,
      headers: {},
    }, { function: 'handleCallback' });

    const userInfoResponse = await fetch(userInfoURL.toString());

    if (!userInfoResponse.ok) {
      const errorData = await userInfoResponse.text();
      logger.logAPIError(
        'User info fetch failed',
        { method: 'GET', url: FACEBOOK_USER_INFO_ENDPOINT },
        { status: userInfoResponse.status, statusText: userInfoResponse.statusText, body: errorData.substring(0, 200) },
        new Error('User info fetch failed'),
        { function: 'handleCallback' }
      );
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', 'user_info_failed');
      frontendURL.searchParams.set('error_description', 'Failed to fetch user information');
      return Response.redirect(frontendURL.toString(), 302);
    }

    const userInfo: FacebookUserInfo = await userInfoResponse.json();

    logger.info('User info fetched successfully', {
      userID: userInfo.id,
      hasEmail: !!userInfo.email,
      hasName: !!userInfo.name,
    }, { function: 'handleCallback' });

    // Build user object
    const email = userInfo.email ?? `${userInfo.id}@facebook.com`;
    const name = userInfo.name ?? [userInfo.first_name, userInfo.last_name].filter(Boolean).join(' ') ?? userInfo.id;
    const picture = userInfo.picture?.data?.url;

    const user: OAuthUser = {
      id: userInfo.id,
      email,
      name,
      picture,
      provider: 'facebook',
    };

    const durationMilliseconds = timer();

    logger.info('OAuth flow completed successfully', {
      userID: user.id,
      email: user.email,
      durationMilliseconds,
    }, { function: 'handleCallback' });

    // Redirect to frontend with user data
    const frontendURL = new URL(storedRedirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);

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
          return jsonResponse({ status: 'healthy', provider: 'facebook' }, 200, origin, environment.ALLOWED_ORIGINS);

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
