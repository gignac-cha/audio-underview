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
    module: 'kakao-oauth-provider-worker',
  },
});

interface Environment extends BaseEnvironment {
  KAKAO_CLIENT_ID: string;
  KAKAO_CLIENT_SECRET?: string;
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

  // Kakao uses comma-separated scopes
  const authorizationURL = new URL(KAKAO_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.KAKAO_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('scope', KAKAO_DEFAULT_SCOPES.join(','));
  authorizationURL.searchParams.set('state', state);

  logger.info('Redirecting to Kakao authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
    scopes: KAKAO_DEFAULT_SCOPES,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();

  logger.info('Callback received from Kakao', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  const validation = validateCallbackParameters(url, environment.FRONTEND_URL, 'Kakao', logger);
  if (!validation.success) return validation.response;
  const { code, state } = validation.parameters;

  const stateResult = await verifyState(state, environment.AUDIO_UNDERVIEW_OAUTH_STATE, environment.FRONTEND_URL, logger);
  if (!stateResult.success) return stateResult.response;
  const storedRedirectURI = stateResult.storedValue;

  try {
    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

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

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: KAKAO_TOKEN_ENDPOINT,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(KAKAO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(tokenParams),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'POST', url: KAKAO_TOKEN_ENDPOINT },
        { status: tokenResponse.status, statusText: tokenResponse.statusText, body: errorData },
        new Error('Token exchange failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens', logger);
    }

    const tokens: TokenResponse = await tokenResponse.json();

    logger.info('Token exchange successful', {
      tokenType: tokens.token_type,
      scope: tokens.scope,
      expiresIn: tokens.expires_in,
      hasRefreshToken: !!tokens.refresh_token,
    }, { function: 'handleCallback' });

    logger.logRequest('User info request', {
      method: 'GET',
      url: KAKAO_USER_INFO_ENDPOINT,
      headers: { Authorization: 'Bearer [REDACTED]', 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    }, { function: 'handleCallback' });

    const userInfoResponse = await fetch(KAKAO_USER_INFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
    });

    if (!userInfoResponse.ok) {
      const errorData = await userInfoResponse.text();
      logger.logAPIError(
        'User info fetch failed',
        { method: 'GET', url: KAKAO_USER_INFO_ENDPOINT },
        { status: userInfoResponse.status, statusText: userInfoResponse.statusText, body: errorData.substring(0, 200) },
        new Error('User info fetch failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        'user_info_failed',
        'Failed to fetch user information from Kakao',
        logger
      );
    }

    const userInfo: KakaoUserResponse = await userInfoResponse.json();

    logger.info('User info fetched successfully', {
      userID: userInfo.id,
      hasEmail: !!userInfo.kakao_account?.email,
      hasName: !!(userInfo.kakao_account?.name ?? userInfo.kakao_account?.profile?.nickname ?? userInfo.properties?.nickname),
    }, { function: 'handleCallback' });

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
  provider: 'kakao',
  logger,
  handlers: { handleAuthorize, handleCallback },
});
