import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const GITHUB_PROVIDER_ID: OAuthProviderID = 'github';
export const GITHUB_DISPLAY_NAME = 'GitHub';

export const GITHUB_AUTHORIZATION_ENDPOINT = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_INFO_ENDPOINT = 'https://api.github.com/user';

export const GITHUB_DEFAULT_SCOPES = ['user:email'];

export interface GitHubOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
