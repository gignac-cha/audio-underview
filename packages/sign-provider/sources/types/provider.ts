import type { OAuthProviderID, OAuthUser } from './user.ts';

/**
 * OAuth configuration for a provider
 */
export interface OAuthProviderConfiguration {
  /** Provider identifier */
  providerID: OAuthProviderID;
  /** Client ID from the OAuth provider */
  clientID: string;
  /** Redirect URI after authentication */
  redirectURI?: string;
  /** OAuth scopes to request */
  scopes?: string[];
}

/**
 * OAuth authorization URL parameters
 */
export interface OAuthAuthorizationParameters {
  /** Client ID */
  clientID: string;
  /** Redirect URI */
  redirectURI: string;
  /** Response type (code, token, id_token) */
  responseType: string;
  /** Scopes to request */
  scopes: string[];
  /** State parameter for CSRF protection */
  state: string;
  /** Nonce for OpenID Connect */
  nonce?: string;
  /** Code challenge for PKCE */
  codeChallenge?: string;
  /** Code challenge method for PKCE */
  codeChallengeMethod?: 'S256' | 'plain';
  /** Additional provider-specific parameters */
  additionalParameters?: Record<string, string>;
}

/**
 * OAuth token response
 */
export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
}

/**
 * OAuth callback parameters
 */
export interface OAuthCallbackParameters {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  idToken?: string;
  accessToken?: string;
}

/**
 * OAuth provider interface that each provider package must implement
 */
export interface OAuthProvider {
  /** Provider identifier */
  readonly providerID: OAuthProviderID;

  /** Provider display name */
  readonly displayName: string;

  /** Authorization endpoint URL */
  readonly authorizationEndpoint: string;

  /** Token endpoint URL */
  readonly tokenEndpoint: string;

  /** User info endpoint URL (if available) */
  readonly userInfoEndpoint?: string;

  /**
   * Build the authorization URL
   */
  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string;

  /**
   * Parse OAuth callback parameters from URL
   */
  parseCallbackParameters(url: string | URL): OAuthCallbackParameters;

  /**
   * Parse user data from ID token or user info response
   */
  parseUserData(data: Record<string, unknown>): OAuthUser;
}

/**
 * Generate a random state string for CSRF protection
 */
export function generateState(length: number = 32): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += characters[randomValues[i] % characters.length];
  }
  return result;
}

/**
 * Generate a random nonce for OpenID Connect
 */
export function generateNonce(length: number = 32): string {
  return generateState(length);
}

/**
 * Generate code verifier for PKCE
 */
export function generateCodeVerifier(length: number = 64): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += characters[randomValues[i] % characters.length];
  }
  return result;
}

/**
 * Generate code challenge from code verifier for PKCE (S256 method)
 */
export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
