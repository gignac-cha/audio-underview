import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  TWITCH_PROVIDER_ID,
  TWITCH_DISPLAY_NAME,
  TWITCH_AUTHORIZATION_ENDPOINT,
  TWITCH_TOKEN_ENDPOINT,
  TWITCH_USER_INFO_ENDPOINT,
  TWITCH_DEFAULT_SCOPES,
} from './configuration.ts';

/**
 * Twitch token response schema (POST /oauth2/token)
 * Twitch returns the granted scopes as an array, not a space-separated string.
 */
export const twitchTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.array(z.string()).optional(),
});

export type TwitchTokenResponse = z.infer<typeof twitchTokenResponseSchema>;

/**
 * One entry of the Helix Get Users `data` array.
 *
 * `email` is only present when the token carries `user:read:email`, and Twitch
 * returns null for an address the user has not verified. An address that does
 * not parse is dropped rather than failing the login, and so is a profile image
 * URL that does not parse — neither identifies the user.
 */
export const twitchUserSchema = z.object({
  id: z.string().min(1),
  login: z.string().min(1),
  display_name: z.string().optional(),
  type: z.string().optional(),
  broadcaster_type: z.string().optional(),
  description: z.string().optional(),
  profile_image_url: z.url().optional().catch(undefined),
  offline_image_url: z.string().optional(),
  view_count: z.number().optional(),
  email: z.email().nullish().catch(undefined),
  created_at: z.string().optional(),
});

export type TwitchUser = z.infer<typeof twitchUserSchema>;

/**
 * Helix Get Users response schema (GET /helix/users)
 * Called with a user access token and no query, `data` holds that one user.
 */
export const twitchUsersResponseSchema = z.object({
  data: z.array(twitchUserSchema),
});

export type TwitchUsersResponse = z.infer<typeof twitchUsersResponseSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
}

/**
 * Treats an empty string like a missing value, so `??` can fall through it.
 */
function nonEmptyString(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

/**
 * Parse Twitch token response
 */
export function parseTwitchTokenResponse(data: unknown): TwitchTokenResponse {
  const result = twitchTokenResponseSchema.safeParse(data);

  if (!result.success) {
    throw new Error(`Invalid Twitch token response: ${formatIssues(result.error)}`);
  }

  return result.data;
}

/**
 * Parse Twitch Get Users response
 */
export function parseTwitchUsersResponse(data: unknown): TwitchUsersResponse {
  const result = twitchUsersResponseSchema.safeParse(data);

  if (!result.success) {
    throw new Error(`Invalid Twitch user response: ${formatIssues(result.error)}`);
  }

  return result.data;
}

/**
 * Twitch OAuth provider implementation
 */
export const twitchOAuthProvider: OAuthProvider = {
  providerID: TWITCH_PROVIDER_ID,
  displayName: TWITCH_DISPLAY_NAME,
  authorizationEndpoint: TWITCH_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: TWITCH_TOKEN_ENDPOINT,
  userInfoEndpoint: TWITCH_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(TWITCH_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('response_type', parameters.responseType);
    url.searchParams.set('scope', parameters.scopes.join(' '));
    url.searchParams.set('state', parameters.state);

    // Add any additional parameters (e.g. force_verify)
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
    const usersResponse = parseTwitchUsersResponse(data);

    // Get Users with a user access token and no query returns that user as the
    // only entry. An empty array means the token resolved to nobody, which is a
    // failed login rather than a user to make up.
    const userData = usersResponse.data[0];

    if (!userData) {
      throw new Error('Invalid Twitch user response: data is empty');
    }

    // Only an address Twitch actually returned is passed on. Without one (no
    // scope, unverified, or empty) the field is omitted — never made up.
    const email = nonEmptyString(userData.email);

    return {
      id: userData.id,
      ...(email ? { email } : {}),
      name: nonEmptyString(userData.display_name) ?? userData.login,
      picture: userData.profile_image_url,
      provider: TWITCH_PROVIDER_ID,
    };
  },
};

/**
 * Create a Twitch authorization URL with default settings
 */
export function createTwitchAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    responseType?: string;
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? TWITCH_DEFAULT_SCOPES,
    state,
  };

  return twitchOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse Twitch user data from the Get Users response
 */
export function parseTwitchUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return twitchOAuthProvider.parseUserData(response);
}
