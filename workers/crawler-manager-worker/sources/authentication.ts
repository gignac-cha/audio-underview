import { findAccount } from '@audio-underview/supabase-connector';
import type { SupabaseClient } from '@audio-underview/supabase-connector';

interface GoogleUserInfo {
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

  let userInfo: GoogleUserInfo;
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      return null;
    }

    userInfo = await response.json() as GoogleUserInfo;
  } catch {
    return null;
  }

  if (!userInfo.sub) {
    return null;
  }

  const account = await findAccount(supabaseClient, {
    provider: 'google',
    identifier: userInfo.sub,
  });

  return account?.uuid ?? null;
}
