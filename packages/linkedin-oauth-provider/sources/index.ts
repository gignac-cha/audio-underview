// Configuration
export {
  LINKEDIN_PROVIDER_ID,
  LINKEDIN_DISPLAY_NAME,
  LINKEDIN_AUTHORIZATION_ENDPOINT,
  LINKEDIN_TOKEN_ENDPOINT,
  LINKEDIN_USER_INFO_ENDPOINT,
  LINKEDIN_DEFAULT_SCOPES,
  type LinkedInOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  linkedInUserInfoSchema,
  parseLinkedInUserInfo,
  linkedInOAuthProvider,
  createLinkedInAuthorizationURL,
  parseLinkedInUserFromResponse,
  type LinkedInUserInfo,
} from './provider.ts';
