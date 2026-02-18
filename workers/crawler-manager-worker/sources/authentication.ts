import { findAccount } from '@audio-underview/supabase-connector';
import type { SupabaseClient } from '@audio-underview/supabase-connector';
import { createWorkerLogger } from '@audio-underview/logger';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'crawler-manager-worker',
  },
});

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

/**
 * Authenticates a request by verifying the OAuth access token
 * against supported providers (Google, GitHub) in parallel,
 * then resolving the user UUID from the database.
 *
 * @param request - Incoming request with Authorization header
 * @param supabaseClient - Supabase client for account lookup
 * @returns User UUID if authenticated, null otherwise
 */
export async function authenticateRequest(
  request: Request,
  supabaseClient: SupabaseClient
): Promise<string | null> {
  const authorizationHeader = request.headers.get('Authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }

  const accessToken = authorizationHeader.slice('Bearer '.length);
  if (!accessToken) {
    return null;
  }

  const results = await Promise.all([
    resolveGoogleUser(accessToken),
    resolveGitHubUser(accessToken),
  ]);

  const userInformation = results.find((result) => result !== null) ?? null;
  if (!userInformation) {
    logger.error('No provider could authenticate the token', undefined, { function: 'authenticateRequest' });
    return null;
  }

  try {
    const account = await findAccount(supabaseClient, {
      provider: userInformation.provider,
      identifier: userInformation.identifier,
    });

    return account?.uuid ?? null;
  } catch (error) {
    logger.error('Failed to find account', error, { function: 'authenticateRequest' });
    return null;
  }
}
