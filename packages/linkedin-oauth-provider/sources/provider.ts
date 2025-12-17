import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  LINKEDIN_PROVIDER_ID,
  LINKEDIN_DISPLAY_NAME,
  LINKEDIN_AUTHORIZATION_ENDPOINT,
  LINKEDIN_TOKEN_ENDPOINT,
  LINKEDIN_USER_INFO_ENDPOINT,
} from './configuration.ts';

/**
 * LinkedIn user info response schema (OpenID Connect UserInfo endpoint)
 */
export const linkedInUserInfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().min(1).optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  picture: z.string().url().optional(),
  locale: z.string().optional(),
});

export type LinkedInUserInfo = z.infer<typeof linkedInUserInfoSchema>;

/**
 * Parse LinkedIn user info response
 */
export function parseLinkedInUserInfo(data: unknown): LinkedInUserInfo {
  const result = linkedInUserInfoSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid LinkedIn user info response: ${errors}`);
  }

  return result.data;
}

/**
 * LinkedIn OAuth provider implementation
 */
export const linkedInOAuthProvider: OAuthProvider = {
  providerID: LINKEDIN_PROVIDER_ID,
  displayName: LINKEDIN_DISPLAY_NAME,
  authorizationEndpoint: LINKEDIN_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: LINKEDIN_TOKEN_ENDPOINT,
  userInfoEndpoint: LINKEDIN_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(LINKEDIN_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('response_type', parameters.responseType);
    url.searchParams.set('scope', parameters.scopes.join(' '));
    url.searchParams.set('state', parameters.state);

    if (parameters.nonce) {
      url.searchParams.set('nonce', parameters.nonce);
    }

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

    // Check URL fragment for implicit flow responses
    const hashParameters = new URLSearchParams(parsedURL.hash.slice(1));
    const queryParameters = parsedURL.searchParams;

    return {
      code: queryParameters.get('code') ?? undefined,
      state: queryParameters.get('state') ?? hashParameters.get('state') ?? undefined,
      error: queryParameters.get('error') ?? hashParameters.get('error') ?? undefined,
      errorDescription:
        queryParameters.get('error_description') ??
        hashParameters.get('error_description') ??
        undefined,
      idToken: hashParameters.get('id_token') ?? undefined,
      accessToken: hashParameters.get('access_token') ?? undefined,
    };
  },

  parseUserData(data: Record<string, unknown>): OAuthUser {
    const userInfo = parseLinkedInUserInfo(data);

    return {
      id: userInfo.sub,
      email: userInfo.email ?? '',
      name: userInfo.name ?? userInfo.given_name ?? userInfo.sub,
      picture: userInfo.picture,
      provider: LINKEDIN_PROVIDER_ID,
    };
  },
};

/**
 * Create a LinkedIn authorization URL with default settings
 */
export function createLinkedInAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    nonce?: string;
    responseType?: string;
    prompt?: 'none' | 'consent';
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? ['openid', 'profile', 'email'],
    state,
    nonce: options?.nonce,
  };

  const additionalParameters: Record<string, string> = {};

  if (options?.prompt) {
    additionalParameters['prompt'] = options.prompt;
  }

  if (Object.keys(additionalParameters).length > 0) {
    parameters.additionalParameters = additionalParameters;
  }

  return linkedInOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse LinkedIn user data from user info response
 */
export function parseLinkedInUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return linkedInOAuthProvider.parseUserData(response);
}
