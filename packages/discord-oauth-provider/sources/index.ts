// Configuration
export {
  DISCORD_PROVIDER_ID,
  DISCORD_DISPLAY_NAME,
  DISCORD_AUTHORIZATION_ENDPOINT,
  DISCORD_TOKEN_ENDPOINT,
  DISCORD_USER_INFO_ENDPOINT,
  DISCORD_REVOKE_ENDPOINT,
  DISCORD_DEFAULT_SCOPES,
  type DiscordOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  discordUserDataSchema,
  parseDiscordUserData,
  discordOAuthProvider,
  createDiscordAuthorizationURL,
  parseDiscordUserFromResponse,
  type DiscordUserData,
} from './provider.ts';
