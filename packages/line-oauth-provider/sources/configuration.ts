import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const LINE_PROVIDER_ID: OAuthProviderID = 'line';
export const LINE_DISPLAY_NAME = 'LINE';

export const LINE_AUTHORIZATION_ENDPOINT = 'https://access.line.me/oauth2/v2.1/authorize';
export const LINE_TOKEN_ENDPOINT = 'https://api.line.me/oauth2/v2.1/token';
export const LINE_USER_INFO_ENDPOINT = 'https://api.line.me/v2/profile';

/**
 * LINE has no email in the profile. The address only travels inside the ID
 * token, which this endpoint verifies and decodes for the channel.
 */
export const LINE_ID_TOKEN_VERIFICATION_ENDPOINT = 'https://api.line.me/oauth2/v2.1/verify';

/**
 * `openid` makes the token endpoint return an ID token, and `email` puts the
 * address into it — the latter only once the channel's email permission has
 * been approved in the LINE Developers Console.
 */
export const LINE_DEFAULT_SCOPES = ['profile', 'openid', 'email'];

export interface LINEOAuthConfiguration {
  /** LINE Login channel ID */
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
