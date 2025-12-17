import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const KAKAO_PROVIDER_ID: OAuthProviderID = 'kakao';
export const KAKAO_DISPLAY_NAME = 'Kakao';

export const KAKAO_AUTHORIZATION_ENDPOINT = 'https://kauth.kakao.com/oauth/authorize';
export const KAKAO_TOKEN_ENDPOINT = 'https://kauth.kakao.com/oauth/token';
export const KAKAO_USER_INFO_ENDPOINT = 'https://kapi.kakao.com/v2/user/me';
export const KAKAO_LOGOUT_ENDPOINT = 'https://kapi.kakao.com/v1/user/logout';
export const KAKAO_UNLINK_ENDPOINT = 'https://kapi.kakao.com/v1/user/unlink';

export const KAKAO_DEFAULT_SCOPES = ['profile_nickname', 'profile_image', 'account_email'];

export interface KakaoOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
