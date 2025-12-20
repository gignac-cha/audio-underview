import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const DISCORD_PROVIDER_ID: OAuthProviderID = 'discord';
export const DISCORD_DISPLAY_NAME = 'Discord';

export const DISCORD_AUTHORIZATION_ENDPOINT = 'https://discord.com/api/oauth2/authorize';
export const DISCORD_TOKEN_ENDPOINT = 'https://discord.com/api/oauth2/token';
export const DISCORD_USER_INFO_ENDPOINT = 'https://discord.com/api/users/@me';
export const DISCORD_REVOKE_ENDPOINT = 'https://discord.com/api/oauth2/token/revoke';

export const DISCORD_DEFAULT_SCOPES = ['identify', 'email'];

export interface DiscordOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
