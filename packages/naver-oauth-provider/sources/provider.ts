import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  NAVER_PROVIDER_ID,
  NAVER_DISPLAY_NAME,
  NAVER_AUTHORIZATION_ENDPOINT,
  NAVER_TOKEN_ENDPOINT,
  NAVER_USER_INFO_ENDPOINT,
} from './configuration.ts';

/**
 * Naver user response schema
 * Naver returns user data nested under a "response" key
 */
export const naverUserResponseSchema = z.object({
  resultcode: z.string(),
  message: z.string(),
  response: z.object({
    id: z.string().min(1),
    email: z.string().email().optional(),
    name: z.string().optional(),
    nickname: z.string().optional(),
    profile_image: z.string().url().optional(),
    age: z.string().optional(),
    gender: z.enum(['M', 'F', 'U']).optional(),
    birthday: z.string().optional(),
    birthyear: z.string().optional(),
    mobile: z.string().optional(),
  }),
});

export type NaverUserResponse = z.infer<typeof naverUserResponseSchema>;

/**
 * Parse Naver user response
 */
export function parseNaverUserResponse(data: unknown): NaverUserResponse {
  const result = naverUserResponseSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Naver user response: ${errors}`);
  }

  return result.data;
}

/**
 * Naver OAuth provider implementation
 */
export const naverOAuthProvider: OAuthProvider = {
  providerID: NAVER_PROVIDER_ID,
  displayName: NAVER_DISPLAY_NAME,
  authorizationEndpoint: NAVER_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: NAVER_TOKEN_ENDPOINT,
  userInfoEndpoint: NAVER_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(NAVER_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('response_type', parameters.responseType);
    url.searchParams.set('state', parameters.state);

    // Naver doesn't use scopes in the same way as other OAuth providers
    // Scopes are configured in the Naver Developers application settings

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
    const userResponse = parseNaverUserResponse(data);

    // Naver user data is nested under "response" key
    const userData = userResponse.response;

    return {
      id: userData.id,
      email: userData.email ?? '',
      name: userData.name ?? userData.nickname ?? '',
      picture: userData.profile_image,
      provider: NAVER_PROVIDER_ID,
    };
  },
};

/**
 * Create a Naver authorization URL with default settings
 */
export function createNaverAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    responseType?: string;
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: [], // Naver doesn't use scopes in the authorization URL
    state,
  };

  return naverOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse Naver user data from API response
 */
export function parseNaverUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return naverOAuthProvider.parseUserData(response);
}
