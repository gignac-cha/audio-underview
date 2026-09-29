import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const X_PROVIDER_ID: OAuthProviderID = 'x';
export const X_DISPLAY_NAME = 'X';

// X OAuth 2.0 endpoints (authorization code flow with PKCE)
export const X_AUTHORIZATION_ENDPOINT = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_ENDPOINT = 'https://api.x.com/2/oauth2/token';
export const X_REVOKE_ENDPOINT = 'https://api.x.com/2/oauth2/revoke';
export const X_USER_INFO_ENDPOINT = 'https://api.x.com/2/users/me';

// X OAuth 2.0 requires PKCE. `users.email` unlocks the `confirmed_email` user
// field; `offline.access` (refresh tokens) is left out because a login never
// refreshes.
export const X_DEFAULT_SCOPES = ['users.read', 'tweet.read', 'users.email'];

// User fields requested from /2/users/me on top of the default id, name and
// username.
export const X_USER_FIELDS = ['profile_image_url', 'confirmed_email'];

export interface XOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
