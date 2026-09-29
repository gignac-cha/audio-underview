import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  LINE_PROVIDER_ID,
  LINE_DISPLAY_NAME,
  LINE_AUTHORIZATION_ENDPOINT,
  LINE_TOKEN_ENDPOINT,
  LINE_USER_INFO_ENDPOINT,
  LINE_DEFAULT_SCOPES,
} from './configuration.ts';

/**
 * LINE token response schema (POST /oauth2/v2.1/token)
 * `id_token` is only present when the `openid` scope was granted.
 */
export const lineTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  id_token: z.string().min(1).optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

export type LINETokenResponse = z.infer<typeof lineTokenResponseSchema>;

/**
 * LINE user profile response schema (GET /v2/profile)
 * `pictureUrl` and `statusMessage` are left out when the user has not set them.
 */
export const lineProfileResponseSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string(),
  pictureUrl: z.url().optional(),
  statusMessage: z.string().optional(),
});

export type LINEProfileResponse = z.infer<typeof lineProfileResponseSchema>;

/**
 * LINE ID token verification response schema (POST /oauth2/v2.1/verify)
 * `email` is only present when the channel's email permission is approved and
 * the user consented. An address that does not parse is dropped instead of
 * failing the whole verification, so `sub` can still be checked.
 */
export const lineIDTokenVerificationResponseSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.string(),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
  amr: z.array(z.string()).optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
  email: z.email().optional().catch(undefined),
});

export type LINEIDTokenVerificationResponse = z.infer<typeof lineIDTokenVerificationResponseSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
}

/**
 * Parse LINE token response
 */
export function parseLINETokenResponse(data: unknown): LINETokenResponse {
  const result = lineTokenResponseSchema.safeParse(data);

  if (!result.success) {
    throw new Error(`Invalid LINE token response: ${formatIssues(result.error)}`);
  }

  return result.data;
}

/**
 * Parse LINE user profile response
 */
export function parseLINEProfileResponse(data: unknown): LINEProfileResponse {
  const result = lineProfileResponseSchema.safeParse(data);

  if (!result.success) {
    throw new Error(`Invalid LINE profile response: ${formatIssues(result.error)}`);
  }

  return result.data;
}

/**
 * Parse LINE ID token verification response
 */
export function parseLINEIDTokenVerificationResponse(data: unknown): LINEIDTokenVerificationResponse {
  const result = lineIDTokenVerificationResponseSchema.safeParse(data);

  if (!result.success) {
    throw new Error(`Invalid LINE ID token verification response: ${formatIssues(result.error)}`);
  }

  return result.data;
}

/**
 * LINE OAuth provider implementation
 */
export const lineOAuthProvider: OAuthProvider = {
  providerID: LINE_PROVIDER_ID,
  displayName: LINE_DISPLAY_NAME,
  authorizationEndpoint: LINE_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: LINE_TOKEN_ENDPOINT,
  userInfoEndpoint: LINE_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const queryParameters = new URLSearchParams();

    queryParameters.set('response_type', parameters.responseType);
    queryParameters.set('client_id', parameters.clientID);
    queryParameters.set('redirect_uri', parameters.redirectURI);
    queryParameters.set('state', parameters.state);
    queryParameters.set('scope', parameters.scopes.join(' '));

    if (parameters.nonce) {
      queryParameters.set('nonce', parameters.nonce);
    }

    if (parameters.codeChallenge) {
      queryParameters.set('code_challenge', parameters.codeChallenge);
      queryParameters.set('code_challenge_method', parameters.codeChallengeMethod ?? 'S256');
    }

    // Add any additional parameters
    if (parameters.additionalParameters) {
      for (const [key, value] of Object.entries(parameters.additionalParameters)) {
        queryParameters.set(key, value);
      }
    }

    // LINE documents the scope list as separated by %20. URLSearchParams writes
    // a space as `+` and a literal `+` as `%2B`, so every remaining `+` is a
    // space and can be rewritten without touching real plus signs.
    return `${LINE_AUTHORIZATION_ENDPOINT}?${queryParameters.toString().replace(/\+/g, '%20')}`;
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
    const profile = parseLINEProfileResponse(data);

    // The profile carries no email; it is only known from a verified ID token
    // (see parseLINEUserFromResponse). No address is made up here.
    return {
      id: profile.userId,
      name: profile.displayName,
      picture: profile.pictureUrl,
      provider: LINE_PROVIDER_ID,
    };
  },
};

/**
 * Create a LINE authorization URL with default settings
 */
export function createLINEAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    responseType?: string;
    nonce?: string;
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: options?.responseType ?? 'code',
    scopes: options?.scopes ?? LINE_DEFAULT_SCOPES,
    state,
    nonce: options?.nonce,
  };

  return lineOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse LINE user data from the profile API response.
 *
 * `email` must come from an ID token that LINE verified for the same user
 * (`sub` equal to the profile `userId`); without it the field is omitted.
 */
export function parseLINEUserFromResponse(
  response: Record<string, unknown>,
  options?: {
    email?: string;
  }
): OAuthUser {
  const user = lineOAuthProvider.parseUserData(response);

  if (options?.email) {
    return { ...user, email: options.email };
  }

  return user;
}
