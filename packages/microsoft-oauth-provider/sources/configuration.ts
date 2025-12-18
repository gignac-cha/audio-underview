import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const MICROSOFT_PROVIDER_ID: OAuthProviderID = 'microsoft';
export const MICROSOFT_DISPLAY_NAME = 'Microsoft';

// Microsoft Identity Platform v2.0 endpoints
// Default tenant for both personal Microsoft accounts and work/school accounts
export const MICROSOFT_DEFAULT_TENANT = 'common';

// Helper functions to get tenant-aware endpoints
export function getMicrosoftAuthorizationEndpoint(tenant: string = MICROSOFT_DEFAULT_TENANT): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

export function getMicrosoftTokenEndpoint(tenant: string = MICROSOFT_DEFAULT_TENANT): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export function getMicrosoftLogoutEndpoint(tenant: string = MICROSOFT_DEFAULT_TENANT): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/logout`;
}

// Static endpoints using default tenant (for backwards compatibility)
export const MICROSOFT_TENANT = MICROSOFT_DEFAULT_TENANT;
export const MICROSOFT_AUTHORIZATION_ENDPOINT = getMicrosoftAuthorizationEndpoint();
export const MICROSOFT_TOKEN_ENDPOINT = getMicrosoftTokenEndpoint();
export const MICROSOFT_LOGOUT_ENDPOINT = getMicrosoftLogoutEndpoint();

// Microsoft Graph API endpoints
export const MICROSOFT_GRAPH_API_ENDPOINT = 'https://graph.microsoft.com/v1.0';
export const MICROSOFT_USER_INFO_ENDPOINT = `${MICROSOFT_GRAPH_API_ENDPOINT}/me`;

// Default scopes for Microsoft OAuth
export const MICROSOFT_DEFAULT_SCOPES = ['openid', 'email', 'profile'];

export interface MicrosoftOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
  tenant?: string;
}
