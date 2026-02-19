import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  MICROSOFT_PROVIDER_ID,
  MICROSOFT_DISPLAY_NAME,
  MICROSOFT_AUTHORIZATION_ENDPOINT,
  MICROSOFT_TOKEN_ENDPOINT,
  MICROSOFT_USER_INFO_ENDPOINT,
} from './configuration.ts';

/**
 * Microsoft ID token payload schema
 */
export const microsoftIDTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email().optional(),
  preferred_username: z.string().optional(),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  oid: z.string().optional(),
  tid: z.string().optional(),
});

export type MicrosoftIDTokenPayload = z.infer<typeof microsoftIDTokenPayloadSchema>;

/**
 * Parse Microsoft ID token payload
 */
export function parseMicrosoftIDTokenPayload(data: unknown): MicrosoftIDTokenPayload {
  const result = microsoftIDTokenPayloadSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Microsoft ID token payload: ${errors}`);
  }

  return result.data;
}

/**
 * Microsoft OAuth provider implementation
 */
export const microsoftOAuthProvider: OAuthProvider = {
  providerID: MICROSOFT_PROVIDER_ID,
  displayName: MICROSOFT_DISPLAY_NAME,
  authorizationEndpoint: MICROSOFT_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: MICROSOFT_TOKEN_ENDPOINT,
  userInfoEndpoint: MICROSOFT_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(MICROSOFT_AUTHORIZATION_ENDPOINT);

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
    const payload = parseMicrosoftIDTokenPayload(data);

    const email = payload.email ?? payload.preferred_username ?? '';
    const name = payload.name ?? payload.given_name ?? email.split('@')[0] ?? '';

    return {
      id: payload.sub,
      email,
      name,
      provider: MICROSOFT_PROVIDER_ID,
    };
  },
};

/**
 * Create a Microsoft authorization URL with default settings
 */
export function createMicrosoftAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    nonce?: string;
    responseType?: string;
    prompt?: 'none' | 'consent' | 'login' | 'select_account';
    loginHint?: string;
    domainHint?: 'consumers' | 'organizations';
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

  if (options?.domainHint) {
    additionalParameters['domain_hint'] = options.domainHint;
  }

  if (Object.keys(additionalParameters).length > 0) {
    parameters.additionalParameters = additionalParameters;
  }

  return microsoftOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse Microsoft user data from decoded ID token
 */
export function parseMicrosoftUserFromIDToken(decodedToken: Record<string, unknown>): OAuthUser {
  return microsoftOAuthProvider.parseUserData(decodedToken);
}
