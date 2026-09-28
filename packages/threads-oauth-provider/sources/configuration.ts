import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const THREADS_PROVIDER_ID: OAuthProviderID = 'threads';
export const THREADS_DISPLAY_NAME = 'Threads';

// Hosts as Meta documents them today: the authorization window and the token
// exchange moved to threads.com (developers.facebook.com/docs/threads/get-started/
// get-access-tokens-and-permissions), while the profile reference
// (developers.facebook.com/docs/threads/threads-profiles) still names
// graph.threads.net.
export const THREADS_AUTHORIZATION_ENDPOINT = 'https://threads.com/oauth/authorize';
export const THREADS_TOKEN_ENDPOINT = 'https://graph.threads.com/oauth/access_token';
export const THREADS_USER_INFO_ENDPOINT = 'https://graph.threads.net/v1.0/me';

/**
 * Profile fields requested from `/me`. Threads exposes no email address, so
 * none is asked for.
 */
export const THREADS_USER_INFO_FIELDS = ['id', 'username', 'name', 'threads_profile_picture_url'];

export const THREADS_DEFAULT_SCOPES = ['threads_basic'];

export interface ThreadsOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
