// Configuration
export {
  TIKTOK_PROVIDER_ID,
  TIKTOK_DISPLAY_NAME,
  TIKTOK_AUTHORIZATION_ENDPOINT,
  TIKTOK_TOKEN_ENDPOINT,
  TIKTOK_USER_INFO_ENDPOINT,
  TIKTOK_DEFAULT_SCOPES,
  TIKTOK_SCOPE_SEPARATOR,
  TIKTOK_USER_INFO_FIELDS,
  type TikTokOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  tiktokUserResponseSchema,
  parseTikTokUserResponse,
  tiktokOAuthProvider,
  createTikTokAuthorizationURL,
  createTikTokUserInfoURL,
  parseTikTokUserFromResponse,
  type TikTokUserResponse,
} from './provider.ts';
