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

// Context and hooks
export { SignProvider, useSign, type SignProviderProps } from './contexts/index.ts';

// Components
export { SignInButtons, type SignInButtonsProps } from './components/index.ts';

// Provider configurations
export {
  PROVIDER_DISPLAY_CONFIGURATIONS,
  getProviderDisplayConfiguration,
  type ProviderDisplayConfiguration,
} from './providers/index.ts';
