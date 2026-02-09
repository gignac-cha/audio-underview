import {
  DISCORD_AUTHORIZATION_ENDPOINT,
  DISCORD_TOKEN_ENDPOINT,
  DISCORD_USER_INFO_ENDPOINT,
  DISCORD_DEFAULT_SCOPES,
} from '@audio-underview/discord-oauth-provider';
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
    module: 'discord-oauth-provider-worker',
  },
});

interface Environment extends BaseEnvironment {
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface DiscordUserInfo {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string | null;
  avatar?: string | null;
  email?: string;
  verified?: boolean;
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

  const authorizationURL = new URL(DISCORD_AUTHORIZATION_ENDPOINT);
  authorizationURL.searchParams.set('client_id', environment.DISCORD_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('scope', DISCORD_DEFAULT_SCOPES.join(' '));
  authorizationURL.searchParams.set('state', state);
  authorizationURL.searchParams.set('prompt', 'consent');

  logger.info('Redirecting to Discord authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
    scopes: DISCORD_DEFAULT_SCOPES,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();

  logger.info('Callback received from Discord', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  const validation = validateCallbackParameters(url, environment.FRONTEND_URL, 'Discord', logger);
  if (!validation.success) return validation.response;
  const { code, state } = validation.parameters;

  const stateResult = await verifyState(state, environment.AUDIO_UNDERVIEW_OAUTH_STATE, environment.FRONTEND_URL, logger);
  if (!stateResult.success) return stateResult.response;
  const storedRedirectURI = stateResult.storedValue;

  try {
    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: DISCORD_TOKEN_ENDPOINT,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(DISCORD_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: environment.DISCORD_CLIENT_ID,
        client_secret: environment.DISCORD_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${url.origin}/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'POST', url: DISCORD_TOKEN_ENDPOINT },
        { status: tokenResponse.status, statusText: tokenResponse.statusText, body: errorData },
        new Error('Token exchange failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens', logger);
    }

    const tokens: TokenResponse = await tokenResponse.json();

    logger.info('Token exchange successful', { tokenType: tokens.token_type, scope: tokens.scope }, { function: 'handleCallback' });

    logger.logRequest('User info request', {
      method: 'GET',
      url: DISCORD_USER_INFO_ENDPOINT,
      headers: { Authorization: 'Bearer [REDACTED]' },
    }, { function: 'handleCallback' });

    const userInfoResponse = await fetch(DISCORD_USER_INFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });

    if (!userInfoResponse.ok) {
      const errorData = await userInfoResponse.text();
      logger.logAPIError(
        'User info fetch failed',
        { method: 'GET', url: DISCORD_USER_INFO_ENDPOINT },
        { status: userInfoResponse.status, statusText: userInfoResponse.statusText, body: errorData.substring(0, 200) },
        new Error('User info fetch failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'user_info_failed', 'Failed to fetch user information', logger);
    }

    const userInfo: DiscordUserInfo = await userInfoResponse.json();

    logger.info('User info fetched successfully', {
      userID: userInfo.id,
      username: userInfo.username,
      hasEmail: !!userInfo.email,
    }, { function: 'handleCallback' });

    let pictureURL: string | undefined;
    if (userInfo.avatar) {
      pictureURL = `https://cdn.discordapp.com/avatars/${userInfo.id}/${userInfo.avatar}.png`;
    }

    const displayName = userInfo.global_name ?? userInfo.username;

    if (!userInfo.email) {
      logger.error('Discord email is required but not available', undefined, {
        function: 'handleCallback',
        metadata: { userID: userInfo.id, username: userInfo.username },
      });
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'email_required', 'Discord email is required but not available', logger);
    }

    const user: OAuthUser = {
      id: userInfo.id,
      email: userInfo.email,
      name: displayName,
      picture: pictureURL,
      provider: 'discord',
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
  provider: 'discord',
  logger,
  handlers: { handleAuthorize, handleCallback },
});
