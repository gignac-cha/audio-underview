import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  X_PROVIDER_ID,
  X_DISPLAY_NAME,
  X_AUTHORIZATION_ENDPOINT,
  X_TOKEN_ENDPOINT,
  X_USER_INFO_ENDPOINT,
} from './configuration.ts';

/**
 * X (Twitter) user data schema from /2/users/me endpoint
 */
export const xUserDataSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    username: z.string().min(1),
    name: z.string().min(1),
    profile_image_url: z.string().url().optional(),
    description: z.string().optional(),
    created_at: z.string().optional(),
    verified: z.boolean().optional(),
    public_metrics: z
      .object({
        followers_count: z.number().optional(),
        following_count: z.number().optional(),
        tweet_count: z.number().optional(),
        listed_count: z.number().optional(),
      })
      .optional(),
  }),
});

export type XUserData = z.infer<typeof xUserDataSchema>;

/**
 * Parse X user data from API response
 */
export function parseXUserData(data: unknown): XUserData {
  const result = xUserDataSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid X user data: ${errors}`);
  }

  return result.data;
}

/**
 * X OAuth provider implementation
 * Note: X OAuth 2.0 requires PKCE (code_challenge and code_verifier)
 */
export const xOAuthProvider: OAuthProvider = {
  providerID: X_PROVIDER_ID,
  displayName: X_DISPLAY_NAME,
  authorizationEndpoint: X_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: X_TOKEN_ENDPOINT,
  userInfoEndpoint: X_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    // X requires PKCE - validate that codeChallenge is provided
    if (!parameters.codeChallenge) {
      throw new Error('X (Twitter) OAuth requires PKCE. Please provide a codeChallenge parameter.');
    }

    const url = new URL(X_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('response_type', parameters.responseType);
    url.searchParams.set('scope', parameters.scopes.join(' '));
    url.searchParams.set('state', parameters.state);

    // Set PKCE parameters
    url.searchParams.set('code_challenge', parameters.codeChallenge);
    url.searchParams.set('code_challenge_method', parameters.codeChallengeMethod ?? 'S256');

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
    const userData = parseXUserData(data);

    // X doesn't provide email through the basic users.read scope
    // Email requires special approval from X
    const user = userData.data;

    return {
      id: user.id,
      email: null, // X doesn't provide email by default
      name: user.name,
      picture: user.profile_image_url,
      provider: X_PROVIDER_ID,
    };
  },
};

/**
 * Create an X authorization URL with default settings
 * Note: X requires PKCE, so codeChallenge is mandatory
 */
export function createXAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  codeChallenge: string,
  options?: {
    scopes?: string[];
    responseType?: string;
    codeChallengeMethod?: 'S256' | 'plain';
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? ['users.read', 'tweet.read'],
    state,
    codeChallenge,
    codeChallengeMethod: options?.codeChallengeMethod ?? 'S256',
  };

  return xOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse X user data from API response
 */
export function parseXUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return xOAuthProvider.parseUserData(response);
}
