import { findAccount } from '@audio-underview/supabase-connector';
import type { SupabaseClient } from '@audio-underview/supabase-connector';
import { createWorkerLogger } from '@audio-underview/logger';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'crawler-manager-worker',
  },
});

interface GoogleUserInformation {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

/**
 * Authenticates a request by verifying the Google access token
 * and resolving the user UUID from the database.
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

  let userInformation: GoogleUserInformation;
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.error('Google userinfo responded with non-OK status', undefined, { function: 'authenticateRequest', status: response.status });
      return null;
    }

    userInformation = await response.json() as GoogleUserInformation;
  } catch (error) {
    logger.error('Failed to fetch Google userinfo', error, { function: 'authenticateRequest' });
    return null;
  }

  if (!userInformation.sub) {
    return null;
  }

  try {
    const account = await findAccount(supabaseClient, {
      provider: 'google',
      identifier: userInformation.sub,
    });

    return account?.uuid ?? null;
  } catch (error) {
    logger.error('Failed to find account', error, { function: 'authenticateRequest' });
    return null;
  }
}
