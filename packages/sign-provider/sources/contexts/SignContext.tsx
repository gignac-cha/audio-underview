import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { GoogleOAuthProvider, googleLogout, type CredentialResponse } from '@react-oauth/google';
import {
  type OAuthUser,
  type OAuthProviderID,
  type StoredAuthenticationData,
  parseStoredAuthenticationData,
  isAuthenticationExpired,
  createStoredAuthenticationData,
} from '../types/index.ts';
import { jwtDecode } from '../tools/index.ts';
import { parseGoogleUserFromIDToken } from '@audio-underview/google-oauth-provider';

const DEFAULT_STORAGE_KEY = 'sign-provider-auth';

interface LoginResult {
  success: boolean;
  error?: string;
}

interface SignContextValue {
  user: OAuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  enabledProviders: OAuthProviderID[];
  loginWithGoogle: (credentialResponse: CredentialResponse) => LoginResult;
  loginWithProvider: (providerID: OAuthProviderID, user: OAuthUser, credential: string) => LoginResult;
  logout: () => void;
}

const SignContext = createContext<SignContextValue | null>(null);

export interface SignProviderProps {
  children: ReactNode;
  /** Google OAuth Client ID */
  googleClientID?: string;
  /** List of enabled provider IDs */
  enabledProviders: OAuthProviderID[];
  /** Storage key for auth data (default: 'sign-provider-auth') */
  storageKey?: string;
  /** Session duration in milliseconds (default: 24 hours) */
  sessionDuration?: number;
}

export function SignProvider({
  children,
  googleClientID,
  enabledProviders,
  storageKey = DEFAULT_STORAGE_KEY,
  sessionDuration = 24 * 60 * 60 * 1000,
}: SignProviderProps) {
  const [user, setUser] = useState<OAuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load auth from storage on mount
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

  // Google login handler
  const loginWithGoogle = useCallback(
    (credentialResponse: CredentialResponse): LoginResult => {
      if (!credentialResponse.credential) {
        return { success: false, error: 'No credential received from Google' };
      }

      try {
        const decoded = jwtDecode<Record<string, unknown>>(credentialResponse.credential);
        const userData = parseGoogleUserFromIDToken(decoded);

        const authenticationData = createStoredAuthenticationData(
          userData,
          credentialResponse.credential,
          sessionDuration
        );

        localStorage.setItem(storageKey, JSON.stringify(authenticationData));
        setUser(userData);
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to decode credential';
        console.error('Google login failed:', errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [storageKey, sessionDuration]
  );

  // Generic provider login handler
  const loginWithProvider = useCallback(
    (_providerID: OAuthProviderID, userData: OAuthUser, credential: string): LoginResult => {
      try {
        const authenticationData = createStoredAuthenticationData(
          userData,
          credential,
          sessionDuration
        );

        localStorage.setItem(storageKey, JSON.stringify(authenticationData));
        setUser(userData);
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to save authentication';
        console.error('Login failed:', errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [storageKey, sessionDuration]
  );

  // Logout handler
  const logout = useCallback(() => {
    if (user?.provider === 'google') {
      googleLogout();
    }
    localStorage.removeItem(storageKey);
    setUser(null);
  }, [user, storageKey]);

  const value = useMemo<SignContextValue>(
    () => ({
      user,
      isAuthenticated: !!user,
      isLoading,
      enabledProviders,
      loginWithGoogle,
      loginWithProvider,
      logout,
    }),
    [user, isLoading, enabledProviders, loginWithGoogle, loginWithProvider, logout]
  );

  // Wrap with GoogleOAuthProvider if Google is enabled and clientID is provided
  let content = <SignContext.Provider value={value}>{children}</SignContext.Provider>;

  if (enabledProviders.includes('google') && googleClientID) {
    content = <GoogleOAuthProvider clientId={googleClientID}>{content}</GoogleOAuthProvider>;
  }

  return content;
}

export function useSign(): SignContextValue {
  const context = useContext(SignContext);
  if (!context) {
    throw new Error('useSign must be used within SignProvider');
  }
  return context;
}
