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
import {
  type BaseEnvironment,
  createOAuthWorkerHandler,
  validateCallbackParameters,
  verifyState,
  redirectToFrontendWithError,
} from '@audio-underview/worker-tools';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'facebook-oauth-provider-worker',
  },
});

interface Environment extends BaseEnvironment {
  FACEBOOK_CLIENT_ID: string;
  FACEBOOK_CLIENT_SECRET: string;
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

  const validation = validateCallbackParameters(url, environment.FRONTEND_URL, 'Facebook', logger);
  if (!validation.success) return validation.response;
  const { code, state } = validation.parameters;

  const stateResult = await verifyState(state, environment.AUDIO_UNDERVIEW_OAUTH_STATE, environment.FRONTEND_URL, logger);
  if (!stateResult.success) return stateResult.response;
  const storedRedirectURI = stateResult.storedValue;

  try {
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
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens');
    }

    const tokens: TokenResponse = await tokenResponse.json();

    logger.info('Token exchange successful', { tokenType: tokens.token_type, expiresIn: tokens.expires_in }, { function: 'handleCallback' });

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
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'user_info_failed', 'Failed to fetch user information');
    }

    const userInfo: FacebookUserInfo = await userInfoResponse.json();

    logger.info('User info fetched successfully', {
      userID: userInfo.id,
      hasEmail: !!userInfo.email,
      hasName: !!userInfo.name,
    }, { function: 'handleCallback' });

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

    const frontendURL = new URL(storedRedirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);

    return Response.redirect(frontendURL.toString(), 302);
  } catch (error) {
    logger.error('Unexpected callback error', error, { function: 'handleCallback' });
    return redirectToFrontendWithError(environment.FRONTEND_URL, 'server_error', 'An unexpected error occurred');
  }
}

export default createOAuthWorkerHandler<Environment>({
  provider: 'facebook',
  logger,
  handlers: { handleAuthorize, handleCallback },
});
