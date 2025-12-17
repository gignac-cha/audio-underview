// Types
export {
  oauthProviderID,
  oauthUserSchema,
  storedAuthenticationDataSchema,
  parseOAuthUser,
  parseStoredAuthenticationData,
  isAuthenticationExpired,
  createStoredAuthenticationData,
  generateState,
  generateNonce,
  generateCodeVerifier,
  generateCodeChallenge,
  type OAuthProviderID,
  type OAuthUser,
  type StoredAuthenticationData,
  type LoginResult,
  type OAuthProviderConfiguration,
  type OAuthAuthorizationParameters,
  type OAuthTokenResponse,
  type OAuthCallbackParameters,
  type OAuthProvider,
} from './types/index.ts';

// Tools
export {
  jwtDecode,
  getJWTExpiration,
  isJWTExpired,
  saveAuthenticationData,
  loadAuthenticationData,
  clearAuthenticationData,
  hasValidAuthentication,
} from './tools/index.ts';
