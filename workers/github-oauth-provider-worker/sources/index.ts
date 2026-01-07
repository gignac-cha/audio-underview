import {
  GITHUB_AUTHORIZATION_ENDPOINT,
  GITHUB_TOKEN_ENDPOINT,
  GITHUB_USER_INFO_ENDPOINT,
  GITHUB_DEFAULT_SCOPES,
} from '@audio-underview/github-oauth-provider';
import {
  generateState,
  type OAuthUser,
} from '@audio-underview/sign-provider';
import { createWorkerLogger } from '@audio-underview/logger';
import { instrumentWorker } from '@audio-underview/axiom-logger';
import {
  createSupabaseClient,
  handleSocialLogin,
} from '@audio-underview/supabase-connector';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'github-oauth-provider-worker',
  },
});

interface Environment {
  // OAuth
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  FRONTEND_URL: string;
  ALLOWED_ORIGINS: string;
  AUDIO_UNDERVIEW_OAUTH_STATE: KVNamespace;
  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  // Axiom
  AXIOM_API_TOKEN: string;
  AXIOM_DATASET: string;
}

interface OAuthErrorResponse {
  error: string;
  errorDescription?: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope?: string;
}

interface GitHubUserInfo {
  id: number;
  login: string;
  email?: string | null;
  name?: string | null;
  avatar_url?: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility?: string | null;
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
  const authorizationURL = new URL(GITHUB_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.GITHUB_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('scope', GITHUB_DEFAULT_SCOPES.join(' '));
  authorizationURL.searchParams.set('state', state);

  logger.info('Redirecting to GitHub authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
    scopes: GITHUB_DEFAULT_SCOPES,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

/**
 * Handle OAuth callback from GitHub
 */
async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();

  logger.info('Callback received from GitHub', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  // Check for error from provider
  const error = url.searchParams.get('error');
  if (error) {
    const errorDescription = url.searchParams.get('error_description') ?? 'Unknown error';
    logger.error('GitHub returned error', new Error(error), {
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

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: GITHUB_TOKEN_ENDPOINT,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(GITHUB_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: environment.GITHUB_CLIENT_ID,
        client_secret: environment.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'POST', url: GITHUB_TOKEN_ENDPOINT },
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

    // Check for error in token response (GitHub returns 200 with error in body)
    if ('error' in tokens) {
      logger.error('Token response contains error', new Error((tokens as { error: string }).error), {
        function: 'handleCallback',
        metadata: { errorDescription: (tokens as { error_description?: string }).error_description },
      });
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', (tokens as { error: string }).error);
      frontendURL.searchParams.set('error_description', (tokens as { error_description?: string }).error_description ?? 'Token exchange failed');
      return Response.redirect(frontendURL.toString(), 302);
    }

    logger.info('Token exchange successful', { tokenType: tokens.token_type, scope: tokens.scope }, { function: 'handleCallback' });

    // Fetch user info from GitHub API
    logger.logRequest('User info request', {
      method: 'GET',
      url: GITHUB_USER_INFO_ENDPOINT,
      headers: { Authorization: 'Bearer [REDACTED]', Accept: 'application/vnd.github+json' },
    }, { function: 'handleCallback' });

    const userInfoResponse = await fetch(GITHUB_USER_INFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'audio-underview-oauth-worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!userInfoResponse.ok) {
      const errorData = await userInfoResponse.text();
      logger.logAPIError(
        'User info fetch failed',
        { method: 'GET', url: GITHUB_USER_INFO_ENDPOINT },
        { status: userInfoResponse.status, statusText: userInfoResponse.statusText, body: errorData.substring(0, 200) },
        new Error('User info fetch failed'),
        { function: 'handleCallback' }
      );
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', 'user_info_failed');
      frontendURL.searchParams.set('error_description', `GitHub API error: ${userInfoResponse.status} - ${errorData.substring(0, 100)}`);
      return Response.redirect(frontendURL.toString(), 302);
    }

    const userInfo: GitHubUserInfo = await userInfoResponse.json();

    logger.info('User info fetched successfully', {
      userID: userInfo.id,
      login: userInfo.login,
      hasEmail: !!userInfo.email,
    }, { function: 'handleCallback' });

    // If email is not in profile, try to get it from emails endpoint
    let email = userInfo.email;
    if (!email) {
      logger.debug('Email not in profile, fetching from emails endpoint', undefined, { function: 'handleCallback' });
      try {
        const emailsResponse = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'audio-underview-oauth-worker',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });

        if (emailsResponse.ok) {
          const emails: GitHubEmail[] = await emailsResponse.json();
          const primaryEmail = emails.find((e) => e.primary && e.verified);
          email = primaryEmail?.email ?? emails[0]?.email ?? null;
          logger.debug('Email fetched from emails endpoint', { hasEmail: !!email }, { function: 'handleCallback' });
        } else {
          logger.warn('Failed to fetch emails from endpoint', { status: emailsResponse.status }, { function: 'handleCallback' });
        }
      } catch (emailError) {
        logger.warn('Error fetching emails', emailError, { function: 'handleCallback' });
      }
    }

    // Handle social login with Supabase
    const supabase = createSupabaseClient({
      supabaseURL: environment.SUPABASE_URL,
      supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    });

    const socialLoginResult = await handleSocialLogin(supabase, {
      provider: 'github',
      identifier: userInfo.id.toString(),
    });

    logger.info('Social login handled', {
      userUUID: socialLoginResult.userUUID,
      isNewUser: socialLoginResult.isNewUser,
      isNewAccount: socialLoginResult.isNewAccount,
    }, { function: 'handleCallback' });

    // Build user object
    const user: OAuthUser = {
      id: userInfo.id.toString(),
      email: email ?? `${userInfo.login}@users.noreply.github.com`,
      name: userInfo.name ?? userInfo.login,
      picture: userInfo.avatar_url,
      provider: 'github',
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

    // Include user UUID from Supabase
    frontendURL.searchParams.set('uuid', socialLoginResult.userUUID);

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

const handler: ExportedHandler<Environment> = {
  async fetch(request, environment): Promise<Response> {
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
          return jsonResponse({ status: 'healthy', provider: 'github' }, 200, origin, environment.ALLOWED_ORIGINS);

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

export default instrumentWorker(handler, (environment) => ({
  token: environment.AXIOM_API_TOKEN,
  dataset: environment.AXIOM_DATASET,
  serviceName: 'github-oauth-provider-worker',
}));
