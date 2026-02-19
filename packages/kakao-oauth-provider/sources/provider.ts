import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  KAKAO_PROVIDER_ID,
  KAKAO_DISPLAY_NAME,
  KAKAO_AUTHORIZATION_ENDPOINT,
  KAKAO_TOKEN_ENDPOINT,
  KAKAO_USER_INFO_ENDPOINT,
} from './configuration.ts';

/**
 * Kakao user response schema
 */
export const kakaoUserResponseSchema = z.object({
  id: z.number(),
  connected_at: z.string().optional(),
  properties: z
    .object({
      nickname: z.string().optional(),
      profile_image: z.string().url().optional(),
      thumbnail_image: z.string().url().optional(),
    })
    .optional(),
  kakao_account: z
    .object({
      profile_needs_agreement: z.boolean().optional(),
      profile_nickname_needs_agreement: z.boolean().optional(),
      profile_image_needs_agreement: z.boolean().optional(),
      profile: z
        .object({
          nickname: z.string().optional(),
          thumbnail_image_url: z.string().url().optional(),
          profile_image_url: z.string().url().optional(),
          is_default_image: z.boolean().optional(),
          is_default_nickname: z.boolean().optional(),
        })
        .optional(),
      email_needs_agreement: z.boolean().optional(),
      is_email_valid: z.boolean().optional(),
      is_email_verified: z.boolean().optional(),
      email: z.string().email().optional(),
      name_needs_agreement: z.boolean().optional(),
      name: z.string().optional(),
    })
    .optional(),
});

export type KakaoUserResponse = z.infer<typeof kakaoUserResponseSchema>;

/**
 * Parse Kakao user response
 */
export function parseKakaoUserResponse(data: unknown): KakaoUserResponse {
  const result = kakaoUserResponseSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Kakao user response: ${errors}`);
  }

  return result.data;
}

/**
 * Kakao OAuth provider implementation
 */
export const kakaoOAuthProvider: OAuthProvider = {
  providerID: KAKAO_PROVIDER_ID,
  displayName: KAKAO_DISPLAY_NAME,
  authorizationEndpoint: KAKAO_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: KAKAO_TOKEN_ENDPOINT,
  userInfoEndpoint: KAKAO_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(KAKAO_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('response_type', parameters.responseType);
    url.searchParams.set('state', parameters.state);

    // Kakao uses comma-separated scopes
    if (parameters.scopes.length > 0) {
      url.searchParams.set('scope', parameters.scopes.join(','));
    }

    if (parameters.nonce) {
      url.searchParams.set('nonce', parameters.nonce);
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
    const userResponse = parseKakaoUserResponse(data);

    const kakaoAccount = userResponse.kakao_account;
    const kakaoProfile = kakaoAccount?.profile;
    const properties = userResponse.properties;

    const email = kakaoAccount?.email ?? `${userResponse.id}@kakao.com`;
    const name = kakaoAccount?.name ?? kakaoProfile?.nickname ?? properties?.nickname ?? `KakaoUser${userResponse.id}`;
    const picture = kakaoProfile?.profile_image_url ?? properties?.profile_image;

    return {
      id: userResponse.id.toString(),
      email,
      name,
      picture,
      provider: KAKAO_PROVIDER_ID,
    };
  },
};

/**
 * Create a Kakao authorization URL with default settings
 */
export function createKakaoAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    nonce?: string;
    responseType?: string;
    prompt?: 'login' | 'none' | 'consent' | 'select_account';
    serviceTerms?: string;
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? ['profile_nickname', 'profile_image', 'account_email'],
    state,
    nonce: options?.nonce,
  };

  const additionalParameters: Record<string, string> = {};

  if (options?.prompt) {
    additionalParameters['prompt'] = options.prompt;
  }

  if (options?.serviceTerms) {
    additionalParameters['service_terms'] = options.serviceTerms;
  }

  if (Object.keys(additionalParameters).length > 0) {
    parameters.additionalParameters = additionalParameters;
  }

  return kakaoOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse Kakao user data from API response
 */
export function parseKakaoUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return kakaoOAuthProvider.parseUserData(response);
}
