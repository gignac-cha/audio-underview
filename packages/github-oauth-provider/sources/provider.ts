import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  GITHUB_PROVIDER_ID,
  GITHUB_DISPLAY_NAME,
  GITHUB_AUTHORIZATION_ENDPOINT,
  GITHUB_TOKEN_ENDPOINT,
  GITHUB_USER_INFO_ENDPOINT,
} from './configuration.ts';

/**
 * GitHub user data schema
 */
export const githubUserDataSchema = z.object({
  id: z.number(),
  login: z.string().min(1),
  email: z.string().email().nullable().optional(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().url().optional(),
  bio: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  blog: z.string().nullable().optional(),
  html_url: z.string().url().optional(),
  public_repos: z.number().optional(),
  public_gists: z.number().optional(),
  followers: z.number().optional(),
  following: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type GitHubUserData = z.infer<typeof githubUserDataSchema>;

/**
 * Parse GitHub user data from API response
 */
export function parseGitHubUserData(data: unknown): GitHubUserData {
  const result = githubUserDataSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid GitHub user data: ${errors}`);
  }

  return result.data;
}

/**
 * GitHub OAuth provider implementation
 */
export const githubOAuthProvider: OAuthProvider = {
  providerID: GITHUB_PROVIDER_ID,
  displayName: GITHUB_DISPLAY_NAME,
  authorizationEndpoint: GITHUB_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
  userInfoEndpoint: GITHUB_USER_INFO_ENDPOINT,

  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const url = new URL(GITHUB_AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', parameters.clientID);
    url.searchParams.set('redirect_uri', parameters.redirectURI);
    url.searchParams.set('scope', parameters.scopes.join(' '));
    url.searchParams.set('state', parameters.state);

    // GitHub doesn't use response_type parameter (always returns code)
    // but we keep it for consistency with the OAuthAuthorizationParameters interface

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
    const userData = parseGitHubUserData(data);

    return {
      id: userData.id.toString(),
      email: userData.email ?? `${userData.login}@users.noreply.github.com`,
      name: userData.name ?? userData.login,
      picture: userData.avatar_url,
      provider: GITHUB_PROVIDER_ID,
    };
  },
};

/**
 * Create a GitHub authorization URL with default settings
 */
export function createGitHubAuthorizationURL(
  clientID: string,
  redirectURI: string,
  state: string,
  options?: {
    scopes?: string[];
    allowSignup?: boolean;
    loginHint?: string;
  }
): string {
  const parameters: OAuthAuthorizationParameters = {
    clientID,
    redirectURI,
    responseType: 'code',
    scopes: options?.scopes ?? ['user:email'],
    state,
  };

  const additionalParameters: Record<string, string> = {};

  if (options?.allowSignup !== undefined) {
    additionalParameters['allow_signup'] = options.allowSignup ? 'true' : 'false';
  }

  if (options?.loginHint) {
    additionalParameters['login'] = options.loginHint;
  }

  if (Object.keys(additionalParameters).length > 0) {
    parameters.additionalParameters = additionalParameters;
  }

  return githubOAuthProvider.buildAuthorizationURL(parameters);
}

/**
 * Parse GitHub user data from API response
 */
export function parseGitHubUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return githubOAuthProvider.parseUserData(response);
}
