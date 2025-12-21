import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { GoogleOAuthProvider, useGoogleLogin, googleLogout } from '@react-oauth/google';
import { z } from 'zod';
import {
  type OAuthUser,
  type OAuthProviderID,
  type LoginResult,
  parseStoredAuthenticationData,
  isAuthenticationExpired,
  createStoredAuthenticationData,
  PROVIDER_DISPLAY_CONFIGURATIONS,
  type ProviderDisplayConfiguration,
} from '@audio-underview/sign-provider';
import { createBrowserLogger } from '@audio-underview/logger';

const authenticationLogger = createBrowserLogger({
  defaultContext: {
    module: 'AuthenticationContext',
  },
});

const DEFAULT_STORAGE_KEY = 'sign-provider-auth';

/**
 * Google userinfo response schema
 */
const googleUserInfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  name: z.string().min(1),
  picture: z.string().url().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  locale: z.string().optional(),
  hd: z.string().optional(),
});

function parseGoogleUserInfo(userInfo: Record<string, unknown>): OAuthUser {
  const result = googleUserInfoSchema.safeParse(userInfo);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
    throw new Error(`Invalid Google user info: ${errors}`);
  }
  const payload = result.data;
  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    provider: 'google',
  };
}

interface AuthenticationContextValue {
  user: OAuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  enabledProviders: OAuthProviderID[];
  isGitHubConfigured: boolean;
  loginWithGoogle: () => void;
  loginWithGitHub: () => void;
  loginWithProvider: (providerID: OAuthProviderID, user: OAuthUser, credential: string) => LoginResult;
  logout: () => void;
}

const AuthenticationContext = createContext<AuthenticationContextValue | null>(null);

interface AuthenticationProviderInnerProps {
  children: ReactNode;
  enabledProviders: OAuthProviderID[];
  storageKey: string;
  sessionDuration: number;
  githubWorkerURL?: string;
  onGoogleError?: (error: string) => void;
  onGitHubError?: (error: string) => void;
}

function AuthenticationProviderInner({
  children,
  enabledProviders,
  storageKey,
  sessionDuration,
  githubWorkerURL,
  onGoogleError,
  onGitHubError,
}: AuthenticationProviderInnerProps) {
  const [user, setUser] = useState<OAuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedData = localStorage.getItem(storageKey);
    if (storedData) {
      try {
        const parsed = JSON.parse(storedData);
        const validatedData = parseStoredAuthenticationData(parsed);
        if (validatedData && !isAuthenticationExpired(validatedData)) {
          setUser(validatedData.user);
        } else {
          localStorage.removeItem(storageKey);
        }
      } catch {
        localStorage.removeItem(storageKey);
      }
    }
    setIsLoading(false);
  }, [storageKey]);

  const saveUser = useCallback(
    (userData: OAuthUser, credential: string): LoginResult => {
      try {
        const authenticationData = createStoredAuthenticationData(userData, credential, sessionDuration);
        localStorage.setItem(storageKey, JSON.stringify(authenticationData));
        setUser(userData);
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to save authentication';
        return { success: false, error: errorMessage };
      }
    },
    [storageKey, sessionDuration]
  );

  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      const requestURL = 'https://www.googleapis.com/oauth2/v3/userinfo';
      const timer = authenticationLogger.startTimer();

      authenticationLogger.info('Starting Google user info fetch', undefined, {
        function: 'googleLogin.onSuccess',
      });

      authenticationLogger.logRequest('Fetching Google user info', {
        method: 'GET',
        url: requestURL,
        headers: { Authorization: 'Bearer [REDACTED]' },
      }, { function: 'googleLogin.onSuccess' });

      try {
        const response = await fetch(requestURL, {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });

        const durationMilliseconds = timer();

        if (!response.ok) {
          let errorBody = '';
          try {
            errorBody = await response.text();
          } catch {
            // Ignore text parsing errors
          }

          authenticationLogger.logAPIError(
            'Google API request failed',
            { method: 'GET', url: requestURL, headers: { Authorization: 'Bearer [REDACTED]' } },
            { status: response.status, statusText: response.statusText, body: errorBody, durationMilliseconds },
            new Error(`Google API error (${response.status}): ${errorBody ?? response.statusText}`),
            { function: 'googleLogin.onSuccess' }
          );

          throw new Error(`Google API error (${response.status}): ${errorBody ?? response.statusText}`);
        }

        const userInfo = await response.json();

        authenticationLogger.logResponse('Google user info fetch successful', {
          status: response.status,
          statusText: response.statusText,
          durationMilliseconds,
        }, { function: 'googleLogin.onSuccess' });

        const userData = parseGoogleUserInfo(userInfo);

        authenticationLogger.info('Google user authenticated successfully', {
          userID: userData.id,
          email: userData.email,
        }, { function: 'googleLogin.onSuccess' });

        saveUser(userData, tokenResponse.access_token);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch Google user info';

        authenticationLogger.error('Google login failed', error, {
          function: 'googleLogin.onSuccess',
        });

        onGoogleError?.(errorMessage);
      }
    },
    onError: (errorResponse) => {
      authenticationLogger.error('Google OAuth error', errorResponse, {
        function: 'googleLogin.onError',
      });
      onGoogleError?.('Google login failed');
    },
  });

  const loginWithProvider = useCallback(
    (providerID: OAuthProviderID, userData: OAuthUser, credential: string): LoginResult => {
      authenticationLogger.info('Logging in with provider', {
        providerID,
        userID: userData.id,
        email: userData.email,
      }, { function: 'loginWithProvider' });

      const result = saveUser(userData, credential);

      if (result.success) {
        authenticationLogger.info('Provider login successful', {
          providerID,
          userID: userData.id,
        }, { function: 'loginWithProvider' });
      } else {
        authenticationLogger.error('Provider login failed', new Error(result.error), {
          function: 'loginWithProvider',
          metadata: { providerID },
        });
      }

      return result;
    },
    [saveUser]
  );

  const isGitHubConfigured = !!githubWorkerURL;

  const loginWithGitHub = useCallback(() => {
    if (!githubWorkerURL) {
      const errorMessage = 'GitHub OAuth Worker URL is not configured';
      authenticationLogger.error(errorMessage, undefined, {
        function: 'loginWithGitHub',
      });
      onGitHubError?.(errorMessage);
      return;
    }

    // Build the callback URL (current origin + /auth/callback)
    const callbackURL = `${window.location.origin}/auth/callback`;
    const authorizeURL = new URL('/authorize', githubWorkerURL);
    authorizeURL.searchParams.set('redirect_uri', callbackURL);

    authenticationLogger.info('Initiating GitHub OAuth flow', {
      authorizeURL: authorizeURL.toString(),
      callbackURL,
    }, { function: 'loginWithGitHub' });

    // Redirect to GitHub OAuth Worker
    window.location.href = authorizeURL.toString();
  }, [githubWorkerURL, onGitHubError]);

  const logout = useCallback(() => {
    authenticationLogger.info('User logging out', {
      userID: user?.id,
      provider: user?.provider,
    }, { function: 'logout' });

    if (user?.provider === 'google') {
      googleLogout();
    }
    localStorage.removeItem(storageKey);
    setUser(null);

    authenticationLogger.info('User logged out successfully', undefined, { function: 'logout' });
  }, [user, storageKey]);

  const value = useMemo<AuthenticationContextValue>(
    () => ({
      user,
      isAuthenticated: !!user,
      isLoading,
      enabledProviders,
      isGitHubConfigured,
      loginWithGoogle: googleLogin,
      loginWithGitHub,
      loginWithProvider,
      logout,
    }),
    [user, isLoading, enabledProviders, isGitHubConfigured, googleLogin, loginWithGitHub, loginWithProvider, logout]
  );

  return <AuthenticationContext.Provider value={value}>{children}</AuthenticationContext.Provider>;
}

export interface AuthenticationProviderProps {
  children: ReactNode;
  googleClientID?: string;
  githubWorkerURL?: string;
  enabledProviders: OAuthProviderID[];
  storageKey?: string;
  sessionDuration?: number;
  onGoogleError?: (error: string) => void;
  onGitHubError?: (error: string) => void;
}

export function AuthenticationProvider({
  children,
  googleClientID,
  githubWorkerURL,
  enabledProviders,
  storageKey = DEFAULT_STORAGE_KEY,
  sessionDuration = 24 * 60 * 60 * 1000,
  onGoogleError,
  onGitHubError,
}: AuthenticationProviderProps) {
  const content = (
    <AuthenticationProviderInner
      enabledProviders={enabledProviders}
      storageKey={storageKey}
      sessionDuration={sessionDuration}
      githubWorkerURL={githubWorkerURL}
      onGoogleError={onGoogleError}
      onGitHubError={onGitHubError}
    >
      {children}
    </AuthenticationProviderInner>
  );

  if (enabledProviders.includes('google') && googleClientID) {
    return <GoogleOAuthProvider clientId={googleClientID}>{content}</GoogleOAuthProvider>;
  }

  return content;
}

export function useAuthentication(): AuthenticationContextValue {
  const context = useContext(AuthenticationContext);
  if (!context) {
    throw new Error('useAuthentication must be used within AuthenticationProvider');
  }
  return context;
}

// Re-export for convenience
export { PROVIDER_DISPLAY_CONFIGURATIONS, type ProviderDisplayConfiguration };
export type { OAuthProviderID, OAuthUser };
