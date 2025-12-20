// Configuration
export {
  GITHUB_PROVIDER_ID,
  GITHUB_DISPLAY_NAME,
  GITHUB_AUTHORIZATION_ENDPOINT,
  GITHUB_TOKEN_ENDPOINT,
  GITHUB_USER_INFO_ENDPOINT,
  GITHUB_DEFAULT_SCOPES,
  type GitHubOAuthConfiguration,
} from './configuration.ts';

// Provider
export {
  githubUserDataSchema,
  parseGitHubUserData,
  githubOAuthProvider,
  createGitHubAuthorizationURL,
  parseGitHubUserFromResponse,
  type GitHubUserData,
} from './provider.ts';
