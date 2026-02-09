import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USER_INFO_ENDPOINT,
  GOOGLE_DEFAULT_SCOPES,
} from '@audio-underview/google-oauth-provider';
import {
  generateState,
  jwtDecode,
  type OAuthUser,
} from '@audio-underview/sign-provider';
import { createWorkerLogger } from '@audio-underview/logger';
import { instrumentWorker } from '@audio-underview/axiom-logger';
import {
  createSupabaseClient,
  handleSocialLogin,
} from '@audio-underview/supabase-connector';
import {
  type BaseEnvironment,
  createOAuthWorkerHandler,
  validateCallbackParameters,
  verifyState,
  redirectToFrontendWithError,
} from '@audio-underview/worker-tools';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'google-oauth-provider-worker',
  },
});

interface Environment extends BaseEnvironment {
  // OAuth
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  // Axiom
  AXIOM_API_TOKEN: string;
  AXIOM_DATASET: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
}

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

  const state = generateState();

  logger.debug('Generated state for CSRF protection', { statePrefix: state.substring(0, 8) }, { function: 'handleAuthorize' });

  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, redirectURI, { expirationTtl: 300 });

  logger.debug('State stored in KV', undefined, { function: 'handleAuthorize' });

  const authorizationURL = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.GOOGLE_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('scope', GOOGLE_DEFAULT_SCOPES.join(' '));
  authorizationURL.searchParams.set('state', state);
  authorizationURL.searchParams.set('access_type', 'online');
  authorizationURL.searchParams.set('prompt', 'select_account');

  logger.info('Redirecting to Google authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
    scopes: GOOGLE_DEFAULT_SCOPES,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();

  logger.info('Callback received from Google', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  const validation = validateCallbackParameters(url, environment.FRONTEND_URL, 'Google', logger);
  if (!validation.success) return validation.response;
  const { code, state } = validation.parameters;

  const stateResult = await verifyState(state, environment.AUDIO_UNDERVIEW_OAUTH_STATE, environment.FRONTEND_URL, logger);
  if (!stateResult.success) return stateResult.response;
  const storedRedirectURI = stateResult.storedValue;

  try {
    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: GOOGLE_TOKEN_ENDPOINT,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: environment.GOOGLE_CLIENT_ID,
        client_secret: environment.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${url.origin}/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'POST', url: GOOGLE_TOKEN_ENDPOINT },
        { status: tokenResponse.status, statusText: tokenResponse.statusText, body: errorData },
        new Error('Token exchange failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens');
    }

    const tokens: TokenResponse = await tokenResponse.json();

    logger.info('Token exchange successful', {
      tokenType: tokens.token_type,
      scope: tokens.scope,
      hasIDToken: !!tokens.id_token,
      expiresIn: tokens.expires_in,
    }, { function: 'handleCallback' });

    // Get user info
    let userID: string;
    let user: OAuthUser;

    if (tokens.id_token) {
      logger.debug('Decoding ID token for user info', undefined, { function: 'handleCallback' });

      const decoded = jwtDecode<GoogleUserInfo>(tokens.id_token);

      logger.info('User info decoded from ID token', {
        userID: decoded.sub,
        email: decoded.email,
        emailVerified: decoded.email_verified,
      }, { function: 'handleCallback' });

      userID = decoded.sub;
      user = {
        id: decoded.sub,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
        provider: 'google',
      };
    } else {
      logger.debug('No ID token, fetching user info from endpoint', undefined, { function: 'handleCallback' });

      logger.logRequest('User info request', {
        method: 'GET',
        url: GOOGLE_USER_INFO_ENDPOINT,
        headers: { Authorization: 'Bearer [REDACTED]' },
      }, { function: 'handleCallback' });

      const userInfoResponse = await fetch(GOOGLE_USER_INFO_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });

      if (!userInfoResponse.ok) {
        const errorData = await userInfoResponse.text();
        logger.logAPIError(
          'User info fetch failed',
          { method: 'GET', url: GOOGLE_USER_INFO_ENDPOINT },
          { status: userInfoResponse.status, statusText: userInfoResponse.statusText, body: errorData.substring(0, 200) },
          new Error('User info fetch failed'),
          { function: 'handleCallback' }
        );
        return redirectToFrontendWithError(environment.FRONTEND_URL, 'user_info_failed', 'Failed to fetch user information');
      }

      const userInfo: GoogleUserInfo = await userInfoResponse.json();

      logger.info('User info fetched successfully', {
        userID: userInfo.sub,
        email: userInfo.email,
        emailVerified: userInfo.email_verified,
      }, { function: 'handleCallback' });

      userID = userInfo.sub;
      user = {
        id: userInfo.sub,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        provider: 'google',
      };
    }

    // Handle social login with Supabase
    const supabase = createSupabaseClient({
      supabaseURL: environment.SUPABASE_URL,
      supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    });

    const socialLoginResult = await handleSocialLogin(supabase, {
      provider: 'google',
      identifier: userID,
    });

    logger.info('Social login handled', {
      userUUID: socialLoginResult.userUUID,
      isNewUser: socialLoginResult.isNewUser,
      isNewAccount: socialLoginResult.isNewAccount,
    }, { function: 'handleCallback' });

    const durationMilliseconds = timer();

    logger.info('OAuth flow completed successfully', {
      userID: user.id,
      email: user.email,
      durationMilliseconds,
    }, { function: 'handleCallback' });

    const frontendURL = new URL(storedRedirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);
    if (tokens.id_token) {
      frontendURL.searchParams.set('id_token', tokens.id_token);
    }

    // Include user UUID from Supabase
    frontendURL.searchParams.set('uuid', socialLoginResult.userUUID);

    return Response.redirect(frontendURL.toString(), 302);
  } catch (error) {
    logger.error('Unexpected callback error', error, { function: 'handleCallback' });
    return redirectToFrontendWithError(environment.FRONTEND_URL, 'server_error', 'An unexpected error occurred');
  }
}

const handler = createOAuthWorkerHandler<Environment>({
  provider: 'google',
  logger,
  handlers: { handleAuthorize, handleCallback },
});

export default instrumentWorker(handler, (environment) => ({
  token: environment.AXIOM_API_TOKEN,
  dataset: environment.AXIOM_DATASET,
  serviceName: 'google-oauth-provider-worker',
}));
