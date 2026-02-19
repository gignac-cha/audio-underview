import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  APPLE_PROVIDER_ID,
  APPLE_DISPLAY_NAME,
  APPLE_AUTHORIZATION_ENDPOINT,
  APPLE_TOKEN_ENDPOINT,
} from './configuration.ts';

/**
 * Apple ID token payload schema
 */
export const appleIDTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.union([z.boolean(), z.string()]).optional(),
  is_private_email: z.union([z.boolean(), z.string()]).optional(),
  real_user_status: z.number().optional(), // 0 = unsupported, 1 = unknown, 2 = likely real user
  nonce: z.string().optional(),
  nonce_supported: z.boolean().optional(),
  auth_time: z.number().optional(),
});

export type AppleIDTokenPayload = z.infer<typeof appleIDTokenPayloadSchema>;

/**
 * Apple user name structure (returned only on first sign-in)
 */
export const appleUserNameSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  middleName: z.string().optional(),
});

export type AppleUserName = z.infer<typeof appleUserNameSchema>;

/**
 * Parse Apple ID token payload
 */
export function parseAppleIDTokenPayload(data: unknown): AppleIDTokenPayload {
  const result = appleIDTokenPayloadSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Apple ID token payload: ${errors}`);
  }

  return result.data;
}

/**
 * Apple OAuth provider implementation
 */
export const appleOAuthProvider: OAuthProvider = {
  providerID: APPLE_PROVIDER_ID,
  displayName: APPLE_DISPLAY_NAME,
  authorizationEndpoint: APPLE_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: APPLE_TOKEN_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(APPLE_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('response_type', parameters.responseType);
    url.searchParams.set('scope', parameters.scopes.join(' '));
    url.searchParams.set('state', parameters.state);

    // Apple defaults to form_post, but can be overridden
    const responseMode = parameters.additionalParameters?.['response_mode'] ?? 'query';
    url.searchParams.set('response_mode', responseMode);

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
        if (key !== 'response_mode') {
          url.searchParams.set(key, value);
        }
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
      code: queryParameters.get('code') ?? hashParameters.get('code') ?? undefined,
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
    const payload = parseAppleIDTokenPayload(data);

    // Apple only provides email in the ID token
    // Name is only provided on first sign-in in a separate 'user' parameter
    // For subsequent sign-ins, the name must be cached from the first sign-in
    return {
      id: payload.sub,
      email: payload.email,
      name: payload.email.split('@')[0], // Fallback: use email prefix as name
      provider: APPLE_PROVIDER_ID,
    };
  },
};

/**
 * Create an Apple authorization URL with default settings
 */
export function createAppleAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    nonce?: string;
    responseType?: string;
    responseMode?: 'query' | 'fragment' | 'form_post';
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? ['name', 'email'],
    state,
    nonce: options?.nonce,
  };

  const additionalParameters: Record<string, string> = {};

  if (options?.responseMode) {
    additionalParameters['response_mode'] = options.responseMode;
  }

  if (Object.keys(additionalParameters).length > 0) {
    parameters.additionalParameters = additionalParameters;
  }

  return appleOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse Apple user data from decoded ID token
 * @param decodedToken - The decoded ID token payload
 * @param userName - Optional user name data (only provided on first sign-in)
 */
export function parseAppleUserFromIDToken(
  decodedToken: Record<string, unknown>,
  userName?: AppleUserName
): OAuthUser {
  const user = appleOAuthProvider.parseUserData(decodedToken);

  // If name data is provided (first sign-in), use it
  if (userName) {
    const nameParts = [userName.firstName, userName.middleName, userName.lastName]
      .filter(Boolean)
      .join(' ');
    if (nameParts) {
      return { ...user, name: nameParts };
    }
  }

  return user;
}
