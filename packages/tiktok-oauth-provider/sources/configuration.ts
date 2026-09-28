import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const TIKTOK_PROVIDER_ID: OAuthProviderID = 'tiktok';
export const TIKTOK_DISPLAY_NAME = 'TikTok';

export const TIKTOK_AUTHORIZATION_ENDPOINT = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_ENDPOINT = 'https://open.tiktokapis.com/v2/oauth/token/';
export const TIKTOK_USER_INFO_ENDPOINT = 'https://open.tiktokapis.com/v2/user/info/';

export const TIKTOK_DEFAULT_SCOPES = ['user.info.basic'];

/**
 * TikTok joins scopes with a comma, not the space most OAuth providers use.
 */
export const TIKTOK_SCOPE_SEPARATOR = ',';

/**
 * User info fields to request. All of them are covered by `user.info.basic`,
 * and TikTok returns only the fields named in the `fields` query parameter.
 */
export const TIKTOK_USER_INFO_FIELDS = ['open_id', 'union_id', 'avatar_url', 'display_name'];

export interface TikTokOAuthConfiguration {
  /** TikTok calls its client identifier the client key */
  clientKey: string;
  redirectURI?: string;
  scopes?: string[];
}
