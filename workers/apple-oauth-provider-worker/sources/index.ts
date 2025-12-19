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

interface Environment {
  APPLE_CLIENT_ID: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
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
}

interface AppleIDTokenPayload {
  sub: string;
  email: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
  real_user_status?: number;
}

interface AppleUserName {
  firstName?: string;
  lastName?: string;
  middleName?: string;
}

interface StateData {
  redirectURI: string;
  nonce: string;
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
 * Generate Apple Client Secret JWT
 * Apple requires a JWT signed with ES256 as the client secret
 */
async function generateAppleClientSecret(environment: Environment): Promise<string> {
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

  return `${dataToSign}.${signatureBase64URL}`;
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

  // Generate state and nonce
  const state = generateState();
  const nonce = generateNonce();

  // Store state and nonce temporarily (5 minutes TTL)
  const stateData: StateData = { redirectURI, nonce };
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, JSON.stringify(stateData), { expirationTtl: 300 });

  // Build authorization URL
  const authorizationURL = new URL(APPLE_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.APPLE_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('scope', APPLE_DEFAULT_SCOPES.join(' '));
  authorizationURL.searchParams.set('state', state);
  authorizationURL.searchParams.set('nonce', nonce);
  authorizationURL.searchParams.set('response_mode', 'query');

  return Response.redirect(authorizationURL.toString(), 302);
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

  // Parse parameters from either GET query or POST body
  let code: string | null = null;
  let state: string | null = null;
  let error: string | null = null;
  let errorDescription: string | null = null;
  let userJSON: string | null = null;

  if (request.method === 'POST') {
    const formData = await request.formData();
    code = formData.get('code') as string | null;
    state = formData.get('state') as string | null;
    error = formData.get('error') as string | null;
    errorDescription = formData.get('error_description') as string | null;
    userJSON = formData.get('user') as string | null;
  } else {
    code = url.searchParams.get('code');
    state = url.searchParams.get('state');
    error = url.searchParams.get('error');
    errorDescription = url.searchParams.get('error_description');
    userJSON = url.searchParams.get('user');
  }

  // Check for error from provider
  if (error) {
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', error);
    frontendURL.searchParams.set('error_description', errorDescription ?? 'Unknown error');
    return Response.redirect(frontendURL.toString(), 302);
  }

  if (!code || !state) {
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', 'invalid_request');
    frontendURL.searchParams.set('error_description', 'Missing code or state parameter');
    return Response.redirect(frontendURL.toString(), 302);
  }

  // Verify state (CSRF protection)
  const storedStateDataJSON = await environment.AUDIO_UNDERVIEW_OAUTH_STATE.get(state);
  if (!storedStateDataJSON) {
    const frontendURL = new URL(environment.FRONTEND_URL);
    frontendURL.searchParams.set('error', 'invalid_state');
    frontendURL.searchParams.set('error_description', 'Invalid or expired state parameter');
    return Response.redirect(frontendURL.toString(), 302);
  }

  const stateData: StateData = JSON.parse(storedStateDataJSON);

  // Delete used state
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.delete(state);

  try {
    // Generate client secret JWT
    const clientSecret = await generateAppleClientSecret(environment);

    // Exchange code for tokens
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
      console.error('Token exchange failed:', errorData);
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', 'token_exchange_failed');
      frontendURL.searchParams.set('error_description', 'Failed to exchange authorization code for tokens');
      return Response.redirect(frontendURL.toString(), 302);
    }

    const tokens: TokenResponse = await tokenResponse.json();

    if (!tokens.id_token) {
      const frontendURL = new URL(environment.FRONTEND_URL);
      frontendURL.searchParams.set('error', 'missing_id_token');
      frontendURL.searchParams.set('error_description', 'Apple did not return an ID token');
      return Response.redirect(frontendURL.toString(), 302);
    }

    // Decode ID token
    const decoded = jwtDecode<AppleIDTokenPayload>(tokens.id_token);

    // Parse user name if provided (only on first sign-in)
    let userName: AppleUserName | null = null;
    if (userJSON) {
      try {
        const userData = JSON.parse(userJSON);
        userName = userData.name as AppleUserName;
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Build user object
    const nameParts = userName
      ? [userName.firstName, userName.middleName, userName.lastName].filter(Boolean)
      : [];
    const name = nameParts.length > 0 ? nameParts.join(' ') : decoded.email.split('@')[0];

    const user: OAuthUser = {
      id: decoded.sub,
      email: decoded.email,
      name,
      provider: 'apple',
    };

    // Redirect to frontend with user data
    const frontendURL = new URL(stateData.redirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);
    frontendURL.searchParams.set('id_token', tokens.id_token);

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
          return jsonResponse({ status: 'healthy', provider: 'apple' }, 200, origin, environment.ALLOWED_ORIGINS);

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
