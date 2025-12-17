// Configuration
export {
  KAKAO_PROVIDER_ID,
  KAKAO_DISPLAY_NAME,
  KAKAO_AUTHORIZATION_ENDPOINT,
  KAKAO_TOKEN_ENDPOINT,
  KAKAO_USER_INFO_ENDPOINT,
  KAKAO_LOGOUT_ENDPOINT,
  KAKAO_UNLINK_ENDPOINT,
  KAKAO_DEFAULT_SCOPES,
  type KakaoOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  kakaoUserResponseSchema,
  parseKakaoUserResponse,
  kakaoOAuthProvider,
  createKakaoAuthorizationURL,
  parseKakaoUserFromResponse,
  type KakaoUserResponse,
} from './provider.ts';
