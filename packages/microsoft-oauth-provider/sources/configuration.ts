import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const MICROSOFT_PROVIDER_ID: OAuthProviderID = 'microsoft';
export const MICROSOFT_DISPLAY_NAME = 'Microsoft';

// Microsoft Identity Platform v2.0 endpoints
// Using 'common' tenant for both personal Microsoft accounts and work/school accounts
export const MICROSOFT_TENANT = 'common';
export const MICROSOFT_AUTHORIZATION_ENDPOINT = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/authorize`;
export const MICROSOFT_TOKEN_ENDPOINT = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/token`;
export const MICROSOFT_LOGOUT_ENDPOINT = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/logout`;

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
