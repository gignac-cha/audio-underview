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

interface Environment {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
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
 */
function createCORSHeaders(origin: string, allowedOrigins: string): Headers {
  const headers = new Headers();
  const origins = allowedOrigins.split(',').map((o) => o.trim());

  if (origins.includes(origin) || origins.includes('*')) {
    headers.set('Access-Control-Allow-Origin', origin);
  }

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

  if (!redirectURI) {
    return new Response('Missing redirect_uri parameter', { status: 400 });
  }

  // Generate state for CSRF protection
  const state = generateState();

  // Store state temporarily (5 minutes TTL)
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, redirectURI, { expirationTtl: 300 });

  // Build authorization URL
  const authorizationURL = new URL(GITHUB_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.GITHUB_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('scope', GITHUB_DEFAULT_SCOPES.join(' '));
  authorizationURL.searchParams.set('state', state);

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

  // Check for error from provider
  const error = url.searchParams.get('error');
  if (error) {
    const errorDescription = url.searchParams.get('error_description') ?? 'Unknown error';
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', error);
    frontendURL.searchParams.set('error_description', errorDescription);
    return Response.redirect(frontendURL.toString(), 302);
  }

  // Get authorization code and state
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', 'invalid_request');
    frontendURL.searchParams.set('error_description', 'Missing code or state parameter');
    return Response.redirect(frontendURL.toString(), 302);
  }

  // Verify state (CSRF protection)
  const storedRedirectURI = await environment.AUDIO_UNDERVIEW_OAUTH_STATE.get(state);
  if (!storedRedirectURI) {
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', 'invalid_state');
    frontendURL.searchParams.set('error_description', 'Invalid or expired state parameter');
    return Response.redirect(frontendURL.toString(), 302);
  }

  // Delete used state
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.delete(state);

  try {
    // Exchange code for tokens
    // GitHub requires Accept header for JSON response
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
      console.error('Token exchange failed:', errorData);
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', 'token_exchange_failed');
      frontendURL.searchParams.set('error_description', 'Failed to exchange authorization code for tokens');
      return Response.redirect(frontendURL.toString(), 302);
    }

    const tokens: TokenResponse = await tokenResponse.json();

    // Check for error in token response (GitHub returns 200 with error in body)
    if ('error' in tokens) {
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', (tokens as { error: string }).error);
      frontendURL.searchParams.set('error_description', (tokens as { error_description?: string }).error_description ?? 'Token exchange failed');
      return Response.redirect(frontendURL.toString(), 302);
    }

    // Fetch user info from GitHub API
    const userInfoResponse = await fetch(GITHUB_USER_INFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'audio-underview-oauth-worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!userInfoResponse.ok) {
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', 'user_info_failed');
      frontendURL.searchParams.set('error_description', 'Failed to fetch user information');
      return Response.redirect(frontendURL.toString(), 302);
    }

    const userInfo: GitHubUserInfo = await userInfoResponse.json();

    // If email is not in profile, try to get it from emails endpoint
    let email = userInfo.email;
    if (!email) {
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
        }
      } catch {
        // Ignore email fetch errors
      }
    }

    // Build user object
    const user: OAuthUser = {
      id: userInfo.id.toString(),
      email: email ?? `${userInfo.login}@users.noreply.github.com`,
      name: userInfo.name ?? userInfo.login,
      picture: userInfo.avatar_url,
      provider: 'github',
    };

    // Redirect to frontend with user data
    const frontendURL = new URL(storedRedirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);

    return Response.redirect(frontendURL.toString(), 302);
  } catch (error) {
    console.error('Callback error:', error);
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
  const headers = createCORSHeaders(origin, environment.ALLOWED_ORIGINS);
  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? environment.FRONTEND_URL;

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
          return jsonResponse({ status: 'healthy', provider: 'github' }, 200, origin, environment.ALLOWED_ORIGINS);

        default:
          return errorResponse('not_found', 'Endpoint not found', 404, origin, environment.ALLOWED_ORIGINS);
      }
    } catch (error) {
      console.error('Worker error:', error);
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
