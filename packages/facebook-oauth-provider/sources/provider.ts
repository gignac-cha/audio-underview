import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  FACEBOOK_PROVIDER_ID,
  FACEBOOK_DISPLAY_NAME,
  FACEBOOK_AUTHORIZATION_ENDPOINT,
  FACEBOOK_TOKEN_ENDPOINT,
  FACEBOOK_USER_INFO_ENDPOINT,
} from './configuration.ts';

/**
 * Facebook user data schema (from Graph API /me endpoint)
 */
export const facebookUserDataSchema = z.object({
  id: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().min(1).optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  picture: z
    .object({
      data: z.object({
        url: z.string().url(),
        width: z.number().optional(),
        height: z.number().optional(),
        is_silhouette: z.boolean().optional(),
      }),
    })
    .optional(),
});

export type FacebookUserData = z.infer<typeof facebookUserDataSchema>;

/**
 * Parse Facebook user data from Graph API response
 */
export function parseFacebookUserData(data: unknown): FacebookUserData {
  const result = facebookUserDataSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Facebook user data: ${errors}`);
  }

  return result.data;
}

/**
 * Facebook OAuth provider implementation
 */
export const facebookOAuthProvider: OAuthProvider = {
  providerID: FACEBOOK_PROVIDER_ID,
  displayName: FACEBOOK_DISPLAY_NAME,
  authorizationEndpoint: FACEBOOK_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: FACEBOOK_TOKEN_ENDPOINT,
  userInfoEndpoint: FACEBOOK_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(FACEBOOK_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('response_type', parameters.responseType);
    url.searchParams.set('scope', parameters.scopes.join(','));
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
    const userData = parseFacebookUserData(data);

    const email = userData.email ?? `${userData.id}@facebook.com`;
    const name = userData.name ?? [userData.first_name, userData.last_name].filter(Boolean).join(' ') ?? userData.id;
    const picture = userData.picture?.data?.url;

    return {
      id: userData.id,
      email,
      name,
      picture,
      provider: FACEBOOK_PROVIDER_ID,
    };
  },
};

/**
 * Create a Facebook authorization URL with default settings
 */
export function createFacebookAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    responseType?: string;
    authType?: 'rerequest' | 'reauthenticate';
    display?: 'page' | 'popup' | 'touch';
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? ['email', 'public_profile'],
    state,
  };

  const additionalParameters: Record<string, string> = {};

  if (options?.authType) {
    additionalParameters['auth_type'] = options.authType;
  }

  if (options?.display) {
    additionalParameters['display'] = options.display;
  }

  if (Object.keys(additionalParameters).length > 0) {
    parameters.additionalParameters = additionalParameters;
  }

  return facebookOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse Facebook user data from Graph API response
 */
export function parseFacebookUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return facebookOAuthProvider.parseUserData(response);
}
