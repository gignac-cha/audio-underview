import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const TWITCH_PROVIDER_ID: OAuthProviderID = 'twitch';
export const TWITCH_DISPLAY_NAME = 'Twitch';

export const TWITCH_AUTHORIZATION_ENDPOINT = 'https://id.twitch.tv/oauth2/authorize';
export const TWITCH_TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';

/**
 * Helix Get Users. Called with no `id` or `login` query it returns the user the
 * access token belongs to. Every Helix request needs a `Client-Id` header next
 * to the Bearer token, and the ID must be the one the token was issued to.
 */
export const TWITCH_USER_INFO_ENDPOINT = 'https://api.twitch.tv/helix/users';

/**
 * `user:read:email` adds the user's email to the Get Users response. Without it
 * the field is left out; with it an unverified address still comes back null.
 */
export const TWITCH_DEFAULT_SCOPES = ['user:read:email'];

export interface TwitchOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
