// Configuration
export {
  MICROSOFT_PROVIDER_ID,
  MICROSOFT_DISPLAY_NAME,
  MICROSOFT_TENANT,
  MICROSOFT_DEFAULT_TENANT,
  MICROSOFT_AUTHORIZATION_ENDPOINT,
  MICROSOFT_TOKEN_ENDPOINT,
  MICROSOFT_LOGOUT_ENDPOINT,
  MICROSOFT_GRAPH_API_ENDPOINT,
  MICROSOFT_USER_INFO_ENDPOINT,
  MICROSOFT_DEFAULT_SCOPES,
  getMicrosoftAuthorizationEndpoint,
  getMicrosoftTokenEndpoint,
  getMicrosoftLogoutEndpoint,
  type MicrosoftOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  microsoftIDTokenPayloadSchema,
  parseMicrosoftIDTokenPayload,
  microsoftOAuthProvider,
  createMicrosoftAuthorizationURL,
  parseMicrosoftUserFromIDToken,
  type MicrosoftIDTokenPayload,
} from './provider.ts';
