import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  THREADS_PROVIDER_ID,
  THREADS_DISPLAY_NAME,
  THREADS_AUTHORIZATION_ENDPOINT,
  THREADS_TOKEN_ENDPOINT,
  THREADS_USER_INFO_ENDPOINT,
  THREADS_DEFAULT_SCOPES,
} from './configuration.ts';

/**
 * Threads token exchange response schema
 * `user_id` is documented as a JSON number wider than 2^53, so it is accepted
 * but never used as an identifier — `/me` returns the same id as a string.
 */
export const threadsTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  user_id: z.union([z.number(), z.string()]).optional(),
});

export type ThreadsTokenResponse = z.infer<typeof threadsTokenResponseSchema>;

/**
 * Parse Threads token exchange response
 */
export function parseThreadsTokenResponse(data: unknown): ThreadsTokenResponse {
  const result = threadsTokenResponseSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Threads token response: ${errors}`);
  }

  return result.data;
}

/**
 * Threads user response schema (`GET /v1.0/me`)
 * Threads has no email field; `username` is always present, `name` may not be.
 */
export const threadsUserResponseSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  name: z.string().optional(),
  threads_profile_picture_url: z.string().url().optional(),
  threads_biography: z.string().optional(),
  is_verified: z.boolean().optional(),
});

export type ThreadsUserResponse = z.infer<typeof threadsUserResponseSchema>;

/**
 * Parse Threads user response
 */
export function parseThreadsUserResponse(data: unknown): ThreadsUserResponse {
  const result = threadsUserResponseSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Threads user response: ${errors}`);
  }

  return result.data;
}

/**
 * Threads OAuth provider implementation
 */
export const threadsOAuthProvider: OAuthProvider = {
  providerID: THREADS_PROVIDER_ID,
  displayName: THREADS_DISPLAY_NAME,
  authorizationEndpoint: THREADS_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: THREADS_TOKEN_ENDPOINT,
  userInfoEndpoint: THREADS_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(THREADS_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    // Threads accepts comma or space separated scopes; its own samples use commas
    url.searchParams.set('scope', parameters.scopes.join(','));
    url.searchParams.set('response_type', parameters.responseType);
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
    const userData = parseThreadsUserResponse(data);

    // Threads grants no email scope. The field is left out rather than filled
    // with an invented address.
    return {
      id: userData.id,
      name: userData.name ?? userData.username,
      picture: userData.threads_profile_picture_url,
      provider: THREADS_PROVIDER_ID,
    };
  },
};

/**
 * Create a Threads authorization URL with default settings
 */
export function createThreadsAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: 'code',
    scopes: options?.scopes ?? THREADS_DEFAULT_SCOPES,
    state,
  };

  return threadsOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse Threads user data from API response
 */
export function parseThreadsUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return threadsOAuthProvider.parseUserData(response);
}
