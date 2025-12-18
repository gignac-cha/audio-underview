import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const FACEBOOK_PROVIDER_ID: OAuthProviderID = 'facebook';
export const FACEBOOK_DISPLAY_NAME = 'Facebook';

// Facebook Graph API version
const FACEBOOK_GRAPH_API_VERSION = 'v22.0';

export const FACEBOOK_AUTHORIZATION_ENDPOINT = `https://www.facebook.com/${FACEBOOK_GRAPH_API_VERSION}/dialog/oauth`;
export const FACEBOOK_TOKEN_ENDPOINT = `https://graph.facebook.com/${FACEBOOK_GRAPH_API_VERSION}/oauth/access_token`;
export const FACEBOOK_USER_INFO_ENDPOINT = `https://graph.facebook.com/${FACEBOOK_GRAPH_API_VERSION}/me`;

export const FACEBOOK_DEFAULT_SCOPES = ['email', 'public_profile'];

export interface FacebookOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
