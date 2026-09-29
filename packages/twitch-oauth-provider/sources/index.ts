// Configuration
export {
  TWITCH_PROVIDER_ID,
  TWITCH_DISPLAY_NAME,
  TWITCH_AUTHORIZATION_ENDPOINT,
  TWITCH_TOKEN_ENDPOINT,
  TWITCH_USER_INFO_ENDPOINT,
  TWITCH_DEFAULT_SCOPES,
  type TwitchOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  twitchTokenResponseSchema,
  twitchUserSchema,
  twitchUsersResponseSchema,
  parseTwitchTokenResponse,
  parseTwitchUsersResponse,
  twitchOAuthProvider,
  createTwitchAuthorizationURL,
  parseTwitchUserFromResponse,
  type TwitchTokenResponse,
  type TwitchUser,
  type TwitchUsersResponse,
} from './provider.ts';
