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
import {
  type BaseEnvironment,
  createOAuthWorkerHandler,
  validateCallbackParameters,
  verifyState,
  redirectToFrontendWithError,
} from '@audio-underview/worker-tools';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'github-oauth-provider-worker',
  },
});

interface Environment extends BaseEnvironment {
  // OAuth
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
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

  const validation = validateCallbackParameters(url, environment.FRONTEND_URL, 'GitHub', logger);
  if (!validation.success) return validation.response;
  const { code, state } = validation.parameters;

  const stateResult = await verifyState(state, environment.AUDIO_UNDERVIEW_OAUTH_STATE, environment.FRONTEND_URL, logger);
  if (!stateResult.success) return stateResult.response;
  const storedRedirectURI = stateResult.storedValue;

  try {
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
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens');
    }

    const tokens: TokenResponse = await tokenResponse.json();

    // Check for error in token response (GitHub returns 200 with error in body)
    if ('error' in tokens) {
      logger.error('Token response contains error', new Error((tokens as { error: string }).error), {
        function: 'handleCallback',
        metadata: { errorDescription: (tokens as { error_description?: string }).error_description },
      });
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        (tokens as { error: string }).error,
        (tokens as { error_description?: string }).error_description ?? 'Token exchange failed'
      );
    }

    logger.info('Token exchange successful', { tokenType: tokens.token_type, scope: tokens.scope }, { function: 'handleCallback' });

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
      return redirectToFrontendWithError(
        environment.FRONTEND_URL,
        'user_info_failed',
        `GitHub API error: ${userInfoResponse.status} - ${errorData.substring(0, 100)}`
      );
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

    const frontendURL = new URL(storedRedirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);

    // Include user UUID from Supabase
    frontendURL.searchParams.set('uuid', socialLoginResult.userUUID);

    return Response.redirect(frontendURL.toString(), 302);
  } catch (error) {
    logger.error('Unexpected callback error', error, { function: 'handleCallback' });
    return redirectToFrontendWithError(environment.FRONTEND_URL, 'server_error', 'An unexpected error occurred');
  }
}

const handler = createOAuthWorkerHandler<Environment>({
  provider: 'github',
  logger,
  handlers: { handleAuthorize, handleCallback },
});

export default instrumentWorker(handler, (environment) => ({
  token: environment.AXIOM_API_TOKEN,
  dataset: environment.AXIOM_DATASET,
  serviceName: 'github-oauth-provider-worker',
}));
