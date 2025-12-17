import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { googleLogout, type CredentialResponse } from '@react-oauth/google';
import { jwtDecode } from './jwtDecode.ts';
import {
  type GoogleUser,
  type StoredAuthData,
  parseGoogleUser,
  parseStoredAuthData,
} from '../schemas/authentication.ts';

interface LoginResult {
  success: boolean;
  error?: string;
}

interface AuthenticationContextValue {
  user: GoogleUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentialResponse: CredentialResponse) => LoginResult;
  logout: () => void;
}

const AuthenticationContext = createContext<AuthenticationContextValue | null>(null);

const STORAGE_KEY = 'audio-underview-auth';

export function AuthenticationProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedData = localStorage.getItem(STORAGE_KEY);
    if (storedData) {
      try {
        const parsed = JSON.parse(storedData);
        const validatedData = parseStoredAuthData(parsed);

        if (validatedData && validatedData.expiresAt > Date.now()) {
          setUser(validatedData.user);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setIsLoading(false);
  }, []);

  const login = useCallback((credentialResponse: CredentialResponse): LoginResult => {
    if (!credentialResponse.credential) {
      console.error('No credential received');
      return { success: false, error: 'No credential received from Google' };
    }

    try {
      const decoded = jwtDecode<Record<string, unknown>>(credentialResponse.credential);
      const userData = parseGoogleUser(decoded);

      const authData: StoredAuthData = {
        user: userData,
        credential: credentialResponse.credential,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(authData));
      setUser(userData);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to decode credential';
      console.error('Login failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }, []);

  const logout = useCallback(() => {
    googleLogout();
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const value: AuthenticationContextValue = {
    user,
    isAuthenticated: !!user,
    isLoading,
    login,
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
