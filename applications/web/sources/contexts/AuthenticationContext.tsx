import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { googleLogout, type CredentialResponse } from '@react-oauth/google';
import { jwtDecode } from './jwtDecode.ts';

interface GoogleUser {
  email: string;
  name: string;
  picture: string;
  sub: string;
}

interface AuthenticationContextValue {
  user: GoogleUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentialResponse: CredentialResponse) => void;
  logout: () => void;
}

const AuthenticationContext = createContext<AuthenticationContextValue | null>(null);

const STORAGE_KEY = 'audio-underview-auth';

interface StoredAuthData {
  user: GoogleUser;
  credential: string;
  expiresAt: number;
}

export function AuthenticationProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedData = localStorage.getItem(STORAGE_KEY);
    if (storedData) {
      try {
        const parsed: StoredAuthData = JSON.parse(storedData);
        if (parsed.expiresAt > Date.now()) {
          setUser(parsed.user);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setIsLoading(false);
  }, []);

  const login = useCallback((credentialResponse: CredentialResponse) => {
    if (!credentialResponse.credential) {
      console.error('No credential received');
      return;
    }

    try {
      const decoded = jwtDecode<GoogleUser>(credentialResponse.credential);
      const userData: GoogleUser = {
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
        sub: decoded.sub,
      };

      const authData: StoredAuthData = {
        user: userData,
        credential: credentialResponse.credential,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(authData));
      setUser(userData);
    } catch (error) {
      console.error('Failed to decode credential:', error);
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
