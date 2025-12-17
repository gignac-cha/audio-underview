import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const X_PROVIDER_ID: OAuthProviderID = 'x';
export const X_DISPLAY_NAME = 'X';

// X (Twitter) OAuth 2.0 endpoints
export const X_AUTHORIZATION_ENDPOINT = 'https://twitter.com/i/oauth2/authorize';
export const X_TOKEN_ENDPOINT = 'https://api.twitter.com/2/oauth2/token';
export const X_REVOKE_ENDPOINT = 'https://api.twitter.com/2/oauth2/revoke';
export const X_USER_INFO_ENDPOINT = 'https://api.twitter.com/2/users/me';

// X OAuth 2.0 requires PKCE
export const X_DEFAULT_SCOPES = ['users.read', 'tweet.read'];

export interface XOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
