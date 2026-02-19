import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import {
  type OAuthUser,
  type OAuthProviderID,
  type LoginResult,
  parseStoredAuthenticationData,
  isAuthenticationExpired,
  createStoredAuthenticationData,
} from '@audio-underview/sign-provider';
import { createBrowserLogger } from '@audio-underview/logger';
import {
  AuthenticationContext,
  type AuthenticationContextValue,
} from './authentication-context-value.ts';

const authenticationLogger = createBrowserLogger({
  defaultContext: {
    module: 'AuthenticationContext',
  },
});

const DEFAULT_STORAGE_KEY = 'sign-provider-auth';

interface AuthenticationProviderInnerProps {
  children: ReactNode;
  enabledProviders: OAuthProviderID[];
  storageKey: string;
  sessionDuration: number;
  googleWorkerURL?: string;
  githubWorkerURL?: string;
  onGoogleError?: (error: string) => void;
  onGitHubError?: (error: string) => void;
}

function AuthenticationProviderInner({
  children,
  enabledProviders,
  storageKey,
  sessionDuration,
  googleWorkerURL,
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
    (userData: OAuthUser, credential: string, customDurationMilliseconds?: number): LoginResult => {
      try {
        const authenticationData = createStoredAuthenticationData(userData, credential, customDurationMilliseconds ?? sessionDuration);
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

  const isGoogleConfigured = !!googleWorkerURL;

  const loginWithGoogle = useCallback(() => {
    if (!googleWorkerURL) {
      const errorMessage = 'Google OAuth Worker URL is not configured';
      authenticationLogger.error(errorMessage, undefined, {
        function: 'loginWithGoogle',
      });
      onGoogleError?.(errorMessage);
      return;
    }

    const callbackURL = `${window.location.origin}/auth/callback`;
    const authorizeURL = new URL('/authorize', googleWorkerURL);
    authorizeURL.searchParams.set('redirect_uri', callbackURL);

    authenticationLogger.info('Initiating Google OAuth flow', {
      authorizeURL: authorizeURL.toString(),
      callbackURL,
    }, { function: 'loginWithGoogle' });

    window.location.href = authorizeURL.toString();
  }, [googleWorkerURL, onGoogleError]);

  const loginWithProvider = useCallback(
    (providerID: OAuthProviderID, userData: OAuthUser, credential: string, sessionDurationMilliseconds?: number): LoginResult => {
      authenticationLogger.info('Logging in with provider', {
        providerID,
        userID: userData.id,
        email: userData.email,
      }, { function: 'loginWithProvider' });

      const result = saveUser(userData, credential, sessionDurationMilliseconds);

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
      isGoogleConfigured,
      isGitHubConfigured,
      loginWithGoogle,
      loginWithGitHub,
      loginWithProvider,
      logout,
    }),
    [user, isLoading, enabledProviders, isGoogleConfigured, isGitHubConfigured, loginWithGoogle, loginWithGitHub, loginWithProvider, logout]
  );

  return <AuthenticationContext.Provider value={value}>{children}</AuthenticationContext.Provider>;
}

export interface AuthenticationProviderProps {
  children: ReactNode;
  googleClientID?: string; // TODO: Worker redirect flow 전환 완료 후 제거 가능
  googleWorkerURL?: string;
  githubWorkerURL?: string;
  enabledProviders: OAuthProviderID[];
  storageKey?: string;
  sessionDuration?: number;
  onGoogleError?: (error: string) => void;
  onGitHubError?: (error: string) => void;
}

export function AuthenticationProvider({
  children,
  googleWorkerURL,
  githubWorkerURL,
  enabledProviders,
  storageKey = DEFAULT_STORAGE_KEY,
  sessionDuration = 24 * 60 * 60 * 1000,
  onGoogleError,
  onGitHubError,
}: AuthenticationProviderProps) {
  return (
    <AuthenticationProviderInner
      enabledProviders={enabledProviders}
      storageKey={storageKey}
      sessionDuration={sessionDuration}
      googleWorkerURL={googleWorkerURL}
      githubWorkerURL={githubWorkerURL}
      onGoogleError={onGoogleError}
      onGitHubError={onGitHubError}
    >
      {children}
    </AuthenticationProviderInner>
  );
}
