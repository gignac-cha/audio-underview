import {
  getMicrosoftAuthorizationEndpoint,
  getMicrosoftTokenEndpoint,
  MICROSOFT_USER_INFO_ENDPOINT,
  MICROSOFT_DEFAULT_SCOPES,
} from '@audio-underview/microsoft-oauth-provider';
import {
  generateState,
  generateNonce,
  jwtDecode,
  type OAuthUser,
} from '@audio-underview/sign-provider';
import { createWorkerLogger } from '@audio-underview/logger';
import { instrumentWorker } from '@audio-underview/axiom-logger';
import {
  type BaseEnvironment,
  createOAuthWorkerHandler,
  validateCallbackParameters,
  redirectToFrontendWithError,
} from '@audio-underview/worker-tools';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'microsoft-oauth-provider-worker',
  },
});

interface Environment extends BaseEnvironment {
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_TENANT: string;
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

interface MicrosoftIDTokenPayload {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  oid?: string;
  tid?: string;
}

interface MicrosoftUserInfo {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  mail?: string;
  userPrincipalName?: string;
}

interface StateData {
  redirectURI: string;
  nonce: string;
}

async function handleAuthorize(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const redirectURI = url.searchParams.get('redirect_uri');
  const tenant = url.searchParams.get('tenant') ?? environment.MICROSOFT_TENANT;

  logger.info('Authorization request received', { redirectURI, tenant }, { function: 'handleAuthorize' });

  if (!redirectURI) {
    logger.warn('Missing redirect_uri parameter', undefined, { function: 'handleAuthorize' });
    return new Response('Missing redirect_uri parameter', { status: 400 });
  }

  // Generate state and nonce
  const state = generateState();
  const nonce = generateNonce();

  logger.debug('Generated state and nonce for CSRF protection', {
    statePrefix: state.substring(0, 8),
    noncePrefix: nonce.substring(0, 8),
  }, { function: 'handleAuthorize' });

  // Store state data temporarily (5 minutes TTL)
  const stateData: StateData = { redirectURI, nonce };
  await environment.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, JSON.stringify(stateData), { expirationTtl: 300 });

  logger.debug('State stored in KV', undefined, { function: 'handleAuthorize' });

  const authorizationEndpoint = getMicrosoftAuthorizationEndpoint(tenant);
  const authorizationURL = new URL(authorizationEndpoint);
  authorizationURL.searchParams.set('client_id', environment.MICROSOFT_CLIENT_ID);
  authorizationURL.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authorizationURL.searchParams.set('response_type', 'code');
  authorizationURL.searchParams.set('scope', MICROSOFT_DEFAULT_SCOPES.join(' '));
  authorizationURL.searchParams.set('state', state);
  authorizationURL.searchParams.set('nonce', nonce);
  authorizationURL.searchParams.set('prompt', 'select_account');

  logger.info('Redirecting to Microsoft authorization', {
    authorizationURL: authorizationURL.origin + authorizationURL.pathname,
    tenant,
    scopes: MICROSOFT_DEFAULT_SCOPES,
  }, { function: 'handleAuthorize' });

  return Response.redirect(authorizationURL.toString(), 302);
}

async function handleCallback(
  request: Request,
  environment: Environment
): Promise<Response> {
  const url = new URL(request.url);
  const timer = logger.startTimer();

  logger.info('Callback received from Microsoft', {
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasError: url.searchParams.has('error'),
  }, { function: 'handleCallback' });

  const validation = validateCallbackParameters(url, environment.FRONTEND_URL, 'Microsoft', logger);
  if (!validation.success) return validation.response;
  const { code, state } = validation.parameters;

  // Microsoft stores JSON in state (includes nonce), so we verify manually
  const storedStateDataJSON = await environment.AUDIO_UNDERVIEW_OAUTH_STATE.get(state);
  if (!storedStateDataJSON) {
    logger.error('Invalid or expired state parameter', undefined, {
      function: 'handleCallback',
      metadata: { statePrefix: state.substring(0, 8) },
    });
    return redirectToFrontendWithError(environment.FRONTEND_URL, 'invalid_state', 'Invalid or expired state parameter', logger);
  }

  let stateData: StateData;
  try {
    stateData = JSON.parse(storedStateDataJSON);
  } catch (parseError) {
    logger.error('Failed to parse state data from KV', parseError, {
      function: 'handleCallback',
      metadata: { statePrefix: state.substring(0, 8) },
    });
    await environment.AUDIO_UNDERVIEW_OAUTH_STATE.delete(state);
    return redirectToFrontendWithError(environment.FRONTEND_URL, 'invalid_state', 'Corrupted state data', logger);
  }

  logger.debug('State verified successfully', undefined, { function: 'handleCallback' });

  try {
    await environment.AUDIO_UNDERVIEW_OAUTH_STATE.delete(state);
  } catch (deleteError) {
    logger.error('Failed to delete state from KV', deleteError, {
      function: 'handleCallback',
      metadata: { statePrefix: state.substring(0, 8) },
    });
  }

  try {
    logger.info('Exchanging code for tokens', undefined, { function: 'handleCallback' });

    const tokenEndpoint = getMicrosoftTokenEndpoint(environment.MICROSOFT_TENANT);

    logger.logRequest('Token exchange request', {
      method: 'POST',
      url: tokenEndpoint,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, { function: 'handleCallback' });

    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: environment.MICROSOFT_CLIENT_ID,
        client_secret: environment.MICROSOFT_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${url.origin}/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      logger.logAPIError(
        'Token exchange failed',
        { method: 'POST', url: tokenEndpoint },
        { status: tokenResponse.status, statusText: tokenResponse.statusText, body: errorData },
        new Error('Token exchange failed'),
        { function: 'handleCallback' }
      );
      return redirectToFrontendWithError(environment.FRONTEND_URL, 'token_exchange_failed', 'Failed to exchange authorization code for tokens', logger);
    }

    const tokens: TokenResponse = await tokenResponse.json();

    logger.info('Token exchange successful', {
      tokenType: tokens.token_type,
      hasIDToken: !!tokens.id_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
    }, { function: 'handleCallback' });

    let user: OAuthUser;

    if (tokens.id_token) {
      logger.info('Decoding ID token to get user info', undefined, { function: 'handleCallback' });

      const decoded = jwtDecode<MicrosoftIDTokenPayload>(tokens.id_token);
      const email = decoded.email ?? decoded.preferred_username ?? '';
      const name = decoded.name ?? decoded.given_name ?? email.split('@')[0] ?? '';

      logger.info('ID token decoded successfully', {
        userID: decoded.sub,
        email,
        hasName: !!decoded.name,
        oid: decoded.oid,
        tid: decoded.tid,
      }, { function: 'handleCallback' });

      user = {
        id: decoded.sub,
        email,
        name,
        provider: 'microsoft',
      };
    } else {
      logger.info('ID token not available, fetching user info from Graph API', undefined, { function: 'handleCallback' });

      logger.logRequest('User info request', {
        method: 'GET',
        url: MICROSOFT_USER_INFO_ENDPOINT,
        headers: { Authorization: 'Bearer [REDACTED]' },
      }, { function: 'handleCallback' });

      const userInfoResponse = await fetch(MICROSOFT_USER_INFO_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });

      if (!userInfoResponse.ok) {
        const errorData = await userInfoResponse.text();
        logger.logAPIError(
          'User info fetch failed',
          { method: 'GET', url: MICROSOFT_USER_INFO_ENDPOINT },
          { status: userInfoResponse.status, statusText: userInfoResponse.statusText, body: errorData.substring(0, 200) },
          new Error('User info fetch failed'),
          { function: 'handleCallback' }
        );
        return redirectToFrontendWithError(environment.FRONTEND_URL, 'user_info_failed', 'Failed to fetch user information', logger);
      }

      const userInfo: MicrosoftUserInfo = await userInfoResponse.json();
      const email = userInfo.mail ?? userInfo.userPrincipalName ?? '';
      const name = userInfo.displayName ?? [userInfo.givenName, userInfo.surname].filter(Boolean).join(' ') ?? '';

      logger.info('User info fetched successfully', {
        userID: userInfo.id,
        email,
        hasDisplayName: !!userInfo.displayName,
      }, { function: 'handleCallback' });

      user = {
        id: userInfo.id,
        email,
        name,
        provider: 'microsoft',
      };
    }

    const durationMilliseconds = timer();

    logger.info('OAuth flow completed successfully', {
      userID: user.id,
      email: user.email,
      durationMilliseconds,
    }, { function: 'handleCallback' });

    const frontendURL = new URL(stateData.redirectURI);
    frontendURL.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    frontendURL.searchParams.set('access_token', tokens.access_token);
    if (tokens.id_token) {
      frontendURL.searchParams.set('id_token', tokens.id_token);
    }

    return Response.redirect(frontendURL.toString(), 302);
  } catch (error) {
    logger.error('Unexpected callback error', error, { function: 'handleCallback' });
    return redirectToFrontendWithError(environment.FRONTEND_URL, 'server_error', 'An unexpected error occurred', logger);
  }
}

const handler = createOAuthWorkerHandler<Environment>({
  provider: 'microsoft',
  logger,
  handlers: { handleAuthorize, handleCallback },
});

export default instrumentWorker(handler, (environment) => ({
  token: environment.AXIOM_API_TOKEN,
  dataset: environment.AXIOM_DATASET,
  serviceName: 'microsoft-oauth-provider-worker',
}));
