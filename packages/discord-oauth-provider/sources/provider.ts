import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  DISCORD_PROVIDER_ID,
  DISCORD_DISPLAY_NAME,
  DISCORD_AUTHORIZATION_ENDPOINT,
  DISCORD_TOKEN_ENDPOINT,
  DISCORD_USER_INFO_ENDPOINT,
} from './configuration.ts';

/**
 * Discord user data schema
 */
export const discordUserDataSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  discriminator: z.string(),
  global_name: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  email: z.string().email().optional(),
  verified: z.boolean().optional(),
  locale: z.string().optional(),
  mfa_enabled: z.boolean().optional(),
  premium_type: z.number().optional(),
  public_flags: z.number().optional(),
});

export type DiscordUserData = z.infer<typeof discordUserDataSchema>;

/**
 * Parse Discord user data response
 */
export function parseDiscordUserData(data: unknown): DiscordUserData {
  const result = discordUserDataSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Discord user data: ${errors}`);
  }

  return result.data;
}

/**
 * Discord OAuth provider implementation
 */
export const discordOAuthProvider: OAuthProvider = {
  providerID: DISCORD_PROVIDER_ID,
  displayName: DISCORD_DISPLAY_NAME,
  authorizationEndpoint: DISCORD_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: DISCORD_TOKEN_ENDPOINT,
  userInfoEndpoint: DISCORD_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(DISCORD_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('response_type', parameters.responseType);
    url.searchParams.set('scope', parameters.scopes.join(' '));
    url.searchParams.set('state', parameters.state);

    if (parameters.codeChallenge) {
      url.searchParams.set('code_challenge', parameters.codeChallenge);
      url.searchParams.set('code_challenge_method', parameters.codeChallengeMethod ?? 'S256');
    }

    // Add any additional parameters
    if (parameters.additionalParameters) {
      for (const [key, value] of Object.entries(parameters.additionalParameters)) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  },

  parseCallbackParameters(url: string | URL): OAuthCallbackParameters {
    const parsedURL = typeof url === 'string' ? new URL(url) : url;
    const queryParameters = parsedURL.searchParams;

    return {
      code: queryParameters.get('code') ?? undefined,
      state: queryParameters.get('state') ?? undefined,
      error: queryParameters.get('error') ?? undefined,
      errorDescription: queryParameters.get('error_description') ?? undefined,
    };
  },

  parseUserData(data: Record<string, unknown>): OAuthUser {
    const userData = parseDiscordUserData(data);

    // Discord email may not be available if not requested in scopes
    if (!userData.email) {
      throw new Error('Discord user email is required but not available. Ensure "email" scope is requested.');
    }

    // Build avatar URL if avatar hash is present
    let pictureURL: string | undefined;
    if (userData.avatar) {
      pictureURL = `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`;
    }

    // Use global_name if available, otherwise use username
    const displayName = userData.global_name ?? userData.username;

    return {
      id: userData.id,
      email: userData.email,
      name: displayName,
      picture: pictureURL,
      provider: DISCORD_PROVIDER_ID,
    };
  },
};

/**
 * Create a Discord authorization URL with default settings
 */
export function createDiscordAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    responseType?: string;
    prompt?: 'none' | 'consent';
    guildID?: string;
    disableGuildSelect?: boolean;
    permissions?: string;
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? ['identify', 'email'],
    state,
  };

  const additionalParameters: Record<string, string> = {};

  if (options?.prompt) {
    additionalParameters['prompt'] = options.prompt;
  }

  if (options?.guildID) {
    additionalParameters['guild_id'] = options.guildID;
  }

  if (options?.disableGuildSelect) {
    additionalParameters['disable_guild_select'] = 'true';
  }

  if (options?.permissions) {
    additionalParameters['permissions'] = options.permissions;
  }

  if (Object.keys(additionalParameters).length > 0) {
    parameters.additionalParameters = additionalParameters;
  }

  return discordOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse Discord user data from API response
 */
export function parseDiscordUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return discordOAuthProvider.parseUserData(response);
}
