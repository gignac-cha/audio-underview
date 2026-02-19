import { createWorkerLogger } from '@audio-underview/logger';
import {
  type ResponseContext,
  signJWT,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import { findAccount } from '@audio-underview/supabase-connector';
import type { SupabaseClient } from '@audio-underview/supabase-connector';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'crawler-manager-worker',
  },
});

interface TokenExchangeRequestBody {
  provider: 'google' | 'github';
  access_token: string;
}

interface ProviderUserInformation {
  provider: 'google' | 'github';
  identifier: string;
}

interface GoogleUserInformation {
  sub: string;
}

interface GitHubUserInformation {
  id: number;
}

const TOKEN_EXPIRY_SECONDS = 86400; // 24 hours

async function resolveProviderUser(
  accessToken: string,
  provider: 'google' | 'github',
): Promise<ProviderUserInformation | null> {
  if (provider === 'google') {
    return resolveGoogleUser(accessToken);
  }
  return resolveGitHubUser(accessToken);
}

async function resolveGoogleUser(accessToken: string): Promise<ProviderUserInformation | null> {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    const userInformation = await response.json() as GoogleUserInformation;
    if (!userInformation.sub) {
      return null;
    }

    return { provider: 'google', identifier: userInformation.sub };
  } catch {
    return null;
  }
}

async function resolveGitHubUser(accessToken: string): Promise<ProviderUserInformation | null> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'audio-underview-crawler-manager-worker',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    const userInformation = await response.json() as GitHubUserInformation;
    if (!userInformation.id) {
      return null;
    }

    return { provider: 'github', identifier: String(userInformation.id) };
  } catch {
    return null;
  }
}

export async function handleTokenExchange(
  request: Request,
  supabaseClient: SupabaseClient,
  jwtSecret: string,
  context: ResponseContext,
): Promise<Response> {
  let body: TokenExchangeRequestBody;
  try {
    body = await request.json() as TokenExchangeRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (!body || typeof body !== 'object') {
    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
  }

  if (!body.provider || !['google', 'github'].includes(body.provider)) {
    return errorResponse('invalid_request', "Field 'provider' must be 'google' or 'github'", 400, context);
  }

  if (typeof body.access_token !== 'string' || !body.access_token) {
    return errorResponse('invalid_request', "Field 'access_token' is required", 400, context);
  }

  const userInformation = await resolveProviderUser(body.access_token, body.provider);
  if (!userInformation) {
    logger.error('Provider could not authenticate the token', undefined, {
      function: 'handleTokenExchange',
      metadata: { provider: body.provider },
    });
    return errorResponse('unauthorized', 'Invalid access token for the specified provider', 401, context);
  }

  try {
    const account = await findAccount(supabaseClient, {
      provider: userInformation.provider,
      identifier: userInformation.identifier,
    });

    if (!account) {
      logger.error('No account found for provider user', undefined, {
        function: 'handleTokenExchange',
        metadata: { provider: userInformation.provider },
      });
      return errorResponse('unauthorized', 'No account found for this user', 401, context);
    }

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT(
      { sub: account.uuid, iat: now, exp: now + TOKEN_EXPIRY_SECONDS },
      jwtSecret,
    );

    return jsonResponse({
      token,
      token_type: 'Bearer',
      expires_in: TOKEN_EXPIRY_SECONDS,
    }, 200, context);
  } catch (error) {
    logger.error('Failed to exchange token', error, { function: 'handleTokenExchange' });
    return errorResponse('server_error', 'An unexpected error occurred during token exchange', 500, context);
  }
}
