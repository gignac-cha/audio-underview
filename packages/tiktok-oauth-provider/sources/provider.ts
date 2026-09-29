import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  TIKTOK_PROVIDER_ID,
  TIKTOK_DISPLAY_NAME,
  TIKTOK_AUTHORIZATION_ENDPOINT,
  TIKTOK_TOKEN_ENDPOINT,
  TIKTOK_USER_INFO_ENDPOINT,
  TIKTOK_DEFAULT_SCOPES,
  TIKTOK_SCOPE_SEPARATOR,
  TIKTOK_USER_INFO_FIELDS,
} from './configuration.ts';

/**
 * TikTok user info response schema
 * TikTok returns user data nested under "data.user", next to an "error" object
 * whose code is "ok" when the call succeeded
 */
export const tiktokUserResponseSchema = z.object({
  data: z.object({
    user: z.object({
      open_id: z.string().min(1),
      union_id: z.string().optional(),
      avatar_url: z.url().optional(),
      display_name: z.string().optional(),
    }),
  }),
  error: z
    .object({
      code: z.string(),
      message: z.string().optional(),
      log_id: z.string().optional(),
    })
    .optional(),
});

export type TikTokUserResponse = z.infer<typeof tiktokUserResponseSchema>;

/**
 * Parse TikTok user info response
 */
export function parseTikTokUserResponse(data: unknown): TikTokUserResponse {
  const result = tiktokUserResponseSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid TikTok user response: ${errors}`);
  }

  // TikTok reports a failed call through error.code; anything but "ok" means
  // the user data cannot be trusted even when it is present.
  if (result.data.error && result.data.error.code !== 'ok') {
    throw new Error(`TikTok user info request failed: ${result.data.error.code}`);
  }

  return result.data;
}

/**
 * TikTok OAuth provider implementation
 */
export const tiktokOAuthProvider: OAuthProvider = {
  providerID: TIKTOK_PROVIDER_ID,
  displayName: TIKTOK_DISPLAY_NAME,
  authorizationEndpoint: TIKTOK_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: TIKTOK_TOKEN_ENDPOINT,
  userInfoEndpoint: TIKTOK_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(TIKTOK_AUTHORIZATION_ENDPOINT);

    // TikTok names the client identifier "client_key", not "client_id"
    url.searchParams.set('client_key', parameters.clientID);
    url.searchParams.set('scope', parameters.scopes.join(TIKTOK_SCOPE_SEPARATOR));
    url.searchParams.set('response_type', parameters.responseType);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('state', parameters.state);

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
    const userResponse = parseTikTokUserResponse(data);

    // TikTok user data is nested under "data.user"
    const userData = userResponse.data.user;

    // TikTok does not expose an email address to Login Kit, so the field is
    // left out rather than filled with an invented address.
    return {
      id: userData.open_id,
      name: userData.display_name ?? '',
      picture: userData.avatar_url,
      provider: TIKTOK_PROVIDER_ID,
    };
  },
};

/**
 * Create a TikTok authorization URL with default settings
 */
export function createTikTokAuthorizationURL(
  clientKey: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    responseType?: string;
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID: clientKey,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? TIKTOK_DEFAULT_SCOPES,
    state,
  };

  return tiktokOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Create the TikTok user info URL that requests the given fields
 */
export function createTikTokUserInfoURL(fields: string[] = TIKTOK_USER_INFO_FIELDS): string {
  const url = new URL(TIKTOK_USER_INFO_ENDPOINT);
  url.searchParams.set('fields', fields.join(','));
  return url.toString();
}

/**
 * Parse TikTok user data from API response
 */
export function parseTikTokUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return tiktokOAuthProvider.parseUserData(response);
}
