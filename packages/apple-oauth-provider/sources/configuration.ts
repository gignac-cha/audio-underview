import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const APPLE_PROVIDER_ID: OAuthProviderID = 'apple';
export const APPLE_DISPLAY_NAME = 'Apple';

export const APPLE_AUTHORIZATION_ENDPOINT = 'https://appleid.apple.com/auth/authorize';
export const APPLE_TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_ENDPOINT = 'https://appleid.apple.com/auth/revoke';
export const APPLE_PUBLIC_KEYS_ENDPOINT = 'https://appleid.apple.com/auth/keys';

export const APPLE_DEFAULT_SCOPES = ['name', 'email'];

export interface AppleOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
  responseMode?: 'query' | 'fragment' | 'form_post';
}
