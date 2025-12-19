import {
  KAKAO_AUTHORIZATION_ENDPOINT,
  KAKAO_TOKEN_ENDPOINT,
  KAKAO_USER_INFO_ENDPOINT,
  KAKAO_DEFAULT_SCOPES,
} from '@audio-underview/kakao-oauth-provider';
import {
  generateState,
  type OAuthUser,
} from '@audio-underview/sign-provider';

interface Environment {
  KAKAO_CLIENT_ID: string;
  KAKAO_CLIENT_SECRET?: string;
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
  refresh_token_expires_in?: number;
  scope?: string;
}

interface KakaoUserResponse {
  id: number;
  connected_at?: string;
  properties?: {
    nickname?: string;
    profile_image?: string;
    thumbnail_image?: string;
  };
  kakao_account?: {
    profile_needs_agreement?: boolean;
    profile_nickname_needs_agreement?: boolean;
    profile_image_needs_agreement?: boolean;
    profile?: {
      nickname?: string;
      thumbnail_image_url?: string;
      profile_image_url?: string;
      is_default_image?: boolean;
      is_default_nickname?: boolean;
    };
    email_needs_agreement?: boolean;
    is_email_valid?: boolean;
    is_email_verified?: boolean;
    email?: string;
    name_needs_agreement?: boolean;
    name?: string;
  };
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
  // Kakao uses comma-separated scopes
  const authorizationURL = new URL(KAKAO_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.KAKAO_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('scope', KAKAO_DEFAULT_SCOPES.join(','));
  authorizationURL.searchParams.set('state', state);

  return Response.redirect(authorizationURL.toString(), 302);
}

/**
 * Handle OAuth callback from Kakao
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
    const tokenParams: Record<string, string> = {
      client_id: environment.KAKAO_CLIENT_ID,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${url.origin}/callback`,
    };

    // Client secret is optional for Kakao but recommended
    if (environment.KAKAO_CLIENT_SECRET) {
      tokenParams['client_secret'] = environment.KAKAO_CLIENT_SECRET;
    }

    const tokenResponse = await fetch(KAKAO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(tokenParams),
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

    // Fetch user info from Kakao API
    const userInfoResponse = await fetch(KAKAO_USER_INFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
    });

    if (!userInfoResponse.ok) {
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', 'user_info_failed');
      frontendURL.searchParams.set('error_description', 'Failed to fetch user information');
      return Response.redirect(frontendURL.toString(), 302);
    }

    const userInfo: KakaoUserResponse = await userInfoResponse.json();

    // Extract user data from Kakao response
    const kakaoAccount = userInfo.kakao_account;
    const kakaoProfile = kakaoAccount?.profile;
    const properties = userInfo.properties;

    const email = kakaoAccount?.email ?? `${userInfo.id}@kakao.com`;
    const name = kakaoAccount?.name ?? kakaoProfile?.nickname ?? properties?.nickname ?? `KakaoUser${userInfo.id}`;
    const picture = kakaoProfile?.profile_image_url ?? properties?.profile_image;

    const user: OAuthUser = {
      id: userInfo.id.toString(),
      email,
      name,
      picture,
      provider: 'kakao',
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
          return jsonResponse({ status: 'healthy', provider: 'kakao' }, 200, origin, environment.ALLOWED_ORIGINS);

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
