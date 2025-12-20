import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const NAVER_PROVIDER_ID: OAuthProviderID = 'naver';
export const NAVER_DISPLAY_NAME = 'Naver';

export const NAVER_AUTHORIZATION_ENDPOINT = 'https://nid.naver.com/oauth2.0/authorize';
export const NAVER_TOKEN_ENDPOINT = 'https://nid.naver.com/oauth2.0/token';
export const NAVER_USER_INFO_ENDPOINT = 'https://openapi.naver.com/v1/nid/me';

export const NAVER_DEFAULT_SCOPES = [''];

export interface NaverOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
