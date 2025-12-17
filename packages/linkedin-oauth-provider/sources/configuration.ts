import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const LINKEDIN_PROVIDER_ID: OAuthProviderID = 'linkedin';
export const LINKEDIN_DISPLAY_NAME = 'LinkedIn';

export const LINKEDIN_AUTHORIZATION_ENDPOINT = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_TOKEN_ENDPOINT = 'https://www.linkedin.com/oauth/v2/accessToken';
export const LINKEDIN_USER_INFO_ENDPOINT = 'https://api.linkedin.com/v2/userinfo';

export const LINKEDIN_DEFAULT_SCOPES = ['openid', 'profile', 'email'];

export interface LinkedInOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
