// Configuration
export {
  APPLE_PROVIDER_ID,
  APPLE_DISPLAY_NAME,
  APPLE_AUTHORIZATION_ENDPOINT,
  APPLE_TOKEN_ENDPOINT,
  APPLE_REVOKE_ENDPOINT,
  APPLE_PUBLIC_KEYS_ENDPOINT,
  APPLE_DEFAULT_SCOPES,
  type AppleOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  appleIDTokenPayloadSchema,
  appleUserNameSchema,
  parseAppleIDTokenPayload,
  appleOAuthProvider,
  createAppleAuthorizationURL,
  parseAppleUserFromIDToken,
  type AppleIDTokenPayload,
  type AppleUserName,
} from './provider.ts';
