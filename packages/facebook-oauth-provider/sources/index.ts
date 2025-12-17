// Configuration
export {
  FACEBOOK_PROVIDER_ID,
  FACEBOOK_DISPLAY_NAME,
  FACEBOOK_AUTHORIZATION_ENDPOINT,
  FACEBOOK_TOKEN_ENDPOINT,
  FACEBOOK_USER_INFO_ENDPOINT,
  FACEBOOK_DEFAULT_SCOPES,
  type FacebookOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  facebookUserDataSchema,
  parseFacebookUserData,
  facebookOAuthProvider,
  createFacebookAuthorizationURL,
  parseFacebookUserFromResponse,
  type FacebookUserData,
} from './provider.ts';
