import {
  NAVER_AUTHORIZATION_ENDPOINT,
  NAVER_TOKEN_ENDPOINT,
  NAVER_USER_INFO_ENDPOINT,
} from '@audio-underview/naver-oauth-provider';
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
    module: 'naver-oauth-provider-worker',
  },
});

interface Environment extends BaseEnvironment {
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface NaverUserResponse {
  resultcode: string;
  message: string;
  response: {
    id: string;
    email?: string;
    name?: string;
    nickname?: string;
    profile_image?: string;
    age?: string;
    gender?: 'M' | 'F' | 'U';
    birthday?: string;
    birthyear?: string;
    mobile?: string;
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

  // Naver doesn't use scopes in the authorization URL
  // Scopes are configured in the Naver Developers application settings
  const authorizationURL = new URL(NAVER_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.NAVER_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('state', state);

  logger.info('Redirecting to Naver authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();

  logger.info('Callback received from Naver', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  const validation = validateCallbackParameters(url, environment.FRONTEND_URL, 'Naver', logger);
  if (!validation.success) return validation.response;
  const { code, state } = validation.parameters;

  const stateResult = await verifyState(state, environment.AUDIO_UNDERVIEW_OAUTH_STATE, environment.FRONTEND_URL, logger);
  if (!stateResult.success) return stateResult.response;
  const storedRedirectURI = stateResult.storedValue;

  try {
    // Naver uses query parameters for token request
    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

    const tokenURL = new URL(NAVER_TOKEN_ENDPOINT);
    tokenURL.searchParams.set('client_id', environment.NAVER_CLIENT_ID);
    tokenURL.searchParams.set('client_secret', environment.NAVER_CLIENT_SECRET);
    tokenURL.searchParams.set('code', code);
    tokenURL.searchParams.set('grant_type', 'authorization_code');
    tokenURL.searchParams.set('state', state);

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: NAVER_TOKEN_ENDPOINT,
      headers: {},
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(tokenURL.toString(), {
      method: 'POST',
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'POST', url: NAVER_TOKEN_ENDPOINT },
        { status: tokenResponse.status, statusText: tokenResponse.statusText, body: errorData },
        new Error('Token exchange failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens', logger);
    }

    const tokens: TokenResponse = await tokenResponse.json();

    // Check for error in token response
    if (tokens.error) {
      logger.error('Token response contains error', new Error(tokens.error), {
        function: 'handleCallback',
        metadata: { errorDescription: tokens.error_description },
      });
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        tokens.error,
        tokens.error_description ?? 'Token exchange failed',
        logger
      );
    }

    logger.info('Token exchange successful', { tokenType: tokens.token_type, expiresIn: tokens.expires_in }, { function: 'handleCallback' });

    logger.logRequest('User info request', {
      method: 'GET',
      url: NAVER_USER_INFO_ENDPOINT,
      headers: { Authorization: 'Bearer [REDACTED]' },
    }, { function: 'handleCallback' });

    const userInfoResponse = await fetch(NAVER_USER_INFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });

    if (!userInfoResponse.ok) {
      const errorData = await userInfoResponse.text();
      logger.logAPIError(
        'User info fetch failed',
        { method: 'GET', url: NAVER_USER_INFO_ENDPOINT },
        { status: userInfoResponse.status, statusText: userInfoResponse.statusText, body: errorData.substring(0, 200) },
        new Error('User info fetch failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'user_info_failed', 'Failed to fetch user information', logger);
    }

    const userInfoWrapper: NaverUserResponse = await userInfoResponse.json();

    // Check for API error
    if (userInfoWrapper.resultcode !== '00') {
      logger.error('Naver API returned error', new Error(userInfoWrapper.message), {
        function: 'handleCallback',
        metadata: { resultcode: userInfoWrapper.resultcode, message: userInfoWrapper.message },
      });
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'user_info_failed', 'Failed to fetch user information from Naver', logger);
    }

    // Naver user data is nested under "response" key
    const userInfo = userInfoWrapper.response;

    logger.info('User info fetched successfully', {
      userID: userInfo.id,
      hasEmail: !!userInfo.email,
      hasName: !!userInfo.name,
      hasNickname: !!userInfo.nickname,
    }, { function: 'handleCallback' });

    const user: OAuthUser = {
      id: userInfo.id,
      email: userInfo.email ?? '',
      name: userInfo.name ?? userInfo.nickname ?? '',
      picture: userInfo.profile_image,
      provider: 'naver',
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
    return redirectToFrontendWithError(environment.FRONTEND_URL, 'server_error', 'An unexpected error occurred', logger);
  }
}

export default createOAuthWorkerHandler<Environment>({
  provider: 'naver',
  logger,
  handlers: { handleAuthorize, handleCallback },
});
