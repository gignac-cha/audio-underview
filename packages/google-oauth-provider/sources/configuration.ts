import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const GOOGLE_PROVIDER_ID: OAuthProviderID = 'google';
export const GOOGLE_DISPLAY_NAME = 'Google';

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USER_INFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export const GOOGLE_DEFAULT_SCOPES = ['openid', 'email', 'profile'];

export interface GoogleOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
