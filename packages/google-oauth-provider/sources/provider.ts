import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  GOOGLE_PROVIDER_ID,
  GOOGLE_DISPLAY_NAME,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USER_INFO_ENDPOINT,
} from './configuration.ts';

/**
 * Google ID token payload schema
 */
export const googleIDTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  name: z.string().min(1),
  picture: z.string().url().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  locale: z.string().optional(),
  hd: z.string().optional(), // Hosted domain (for Google Workspace accounts)
});

export type GoogleIDTokenPayload = z.infer<typeof googleIDTokenPayloadSchema>;

/**
 * Parse Google ID token payload
 */
export function parseGoogleIDTokenPayload(data: unknown): GoogleIDTokenPayload {
  const result = googleIDTokenPayloadSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Google ID token payload: ${errors}`);
  }

  return result.data;
}

/**
 * Google OAuth provider implementation
 */
export const googleOAuthProvider: OAuthProvider = {
  providerID: GOOGLE_PROVIDER_ID,
  displayName: GOOGLE_DISPLAY_NAME,
  authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
  userInfoEndpoint: GOOGLE_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);

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

    // Google-specific: request ID token in implicit flow
    if (parameters.responseType.includes('id_token')) {
      url.searchParams.set('access_type', 'online');
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
    const payload = parseGoogleIDTokenPayload(data);

    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      provider: GOOGLE_PROVIDER_ID,
    };
  },
};

/**
 * Create a Google authorization URL with default settings
 */
export function createGoogleAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    nonce?: string;
    responseType?: string;
    prompt?: 'none' | 'consent' | 'select_account';
    loginHint?: string;
    hostedDomain?: string;
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? ['openid', 'email', 'profile'],
    state,
    nonce: options?.nonce,
  };

  const additionalParameters: Record<string, string> = {};

  if (options?.prompt) {
    additionalParameters['prompt'] = options.prompt;
  }

  if (options?.loginHint) {
    additionalParameters['login_hint'] = options.loginHint;
  }

  if (options?.hostedDomain) {
    additionalParameters['hd'] = options.hostedDomain;
  }

  if (Object.keys(additionalParameters).length > 0) {
    parameters.additionalParameters = additionalParameters;
  }

  return googleOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse Google user data from decoded ID token
 */
export function parseGoogleUserFromIDToken(decodedToken: Record<string, unknown>): OAuthUser {
  return googleOAuthProvider.parseUserData(decodedToken);
}
