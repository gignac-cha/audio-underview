import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { googleLogout, type CredentialResponse } from '@react-oauth/google';
import {
  type OAuthUser,
  type OAuthProviderID,
  jwtDecode,
  saveAuthenticationData,
  loadAuthenticationData,
  clearAuthenticationData,
  createStoredAuthenticationData,
} from '@audio-underview/sign-provider';
import { parseGoogleUserFromIDToken } from '@audio-underview/google-oauth-provider';

interface LoginResult {
  success: boolean;
  error?: string;
}

interface AuthenticationContextValue {
  user: OAuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentialResponse: CredentialResponse) => LoginResult;
  loginWithProvider: (providerID: OAuthProviderID, user: OAuthUser, credential: string) => LoginResult;
  logout: () => void;
}

const AuthenticationContext = createContext<AuthenticationContextValue | null>(null);

const STORAGE_KEY = 'audio-underview-auth';

export function AuthenticationProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<OAuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedData = loadAuthenticationData(STORAGE_KEY);
    if (storedData) {
      setUser(storedData.user);
    }
    setIsLoading(false);
  }, []);

  // Google OAuth login (using @react-oauth/google)
  const login = useCallback((credentialResponse: CredentialResponse): LoginResult => {
    if (!credentialResponse.credential) {
      console.error('No credential received');
      return { success: false, error: 'No credential received from Google' };
    }

    try {
      const decoded = jwtDecode<Record<string, unknown>>(credentialResponse.credential);
      const userData = parseGoogleUserFromIDToken(decoded);

      const authenticationData = createStoredAuthenticationData(
        userData,
        credentialResponse.credential
      );

      saveAuthenticationData(authenticationData, STORAGE_KEY);
      setUser(userData);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to decode credential';
      console.error('Login failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }, []);

  // Generic provider login
  const loginWithProvider = useCallback(
    (_providerID: OAuthProviderID, userData: OAuthUser, credential: string): LoginResult => {
      try {
        const authenticationData = createStoredAuthenticationData(userData, credential);

        saveAuthenticationData(authenticationData, STORAGE_KEY);
        setUser(userData);
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to save authentication';
        console.error('Login failed:', errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    []
  );

  const logout = useCallback(() => {
    // Call Google logout if user was logged in with Google
    if (user?.provider === 'google') {
      googleLogout();
    }
    clearAuthenticationData(STORAGE_KEY);
    setUser(null);
  }, [user]);

  const value: AuthenticationContextValue = {
    user,
    isAuthenticated: !!user,
    isLoading,
    login,
    loginWithProvider,
    logout,
  };

  return (
    <AuthenticationContext.Provider value={value}>
      {children}
    </AuthenticationContext.Provider>
  );
}

export function useAuthentication(): AuthenticationContextValue {
  const context = useContext(AuthenticationContext);
  if (!context) {
    throw new Error('useAuthentication must be used within AuthenticationProvider');
  }
  return context;
}
