// Configuration
export {
  GOOGLE_PROVIDER_ID,
  GOOGLE_DISPLAY_NAME,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USER_INFO_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_DEFAULT_SCOPES,
  type GoogleOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  googleIDTokenPayloadSchema,
  parseGoogleIDTokenPayload,
  googleOAuthProvider,
  createGoogleAuthorizationURL,
  parseGoogleUserFromIDToken,
  type GoogleIDTokenPayload,
} from './provider.ts';
