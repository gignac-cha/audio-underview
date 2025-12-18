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
import { z } from 'zod';
import {
  type OAuthUser,
  type OAuthProviderID,
  parseStoredAuthenticationData,
  isAuthenticationExpired,
  createStoredAuthenticationData,
} from '../types/index.ts';

/**
 * Google userinfo response schema (from /oauth2/v3/userinfo endpoint)
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

/**
 * Parse Google user data from userinfo response
 */
function parseGoogleUserInfo(userInfo: Record<string, unknown>): OAuthUser {
  const result = googleUserInfoSchema.safeParse(userInfo);

  if (!result.success) {
    const errors = result.error.errors.map((error) => `${error.path.join('.')}: ${error.message}`).join(', ');
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
  loginWithGoogle: (credentialResponse: CredentialResponse, userInfo?: Record<string, unknown>) => LoginResult;
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
    (credentialResponse: CredentialResponse, userInfo?: Record<string, unknown>): LoginResult => {
      if (!credentialResponse.credential) {
        return { success: false, error: 'No credential received from Google' };
      }

      try {
        // If userInfo is provided (from useGoogleLogin flow), use it directly
        // Otherwise this would be from GoogleLogin component which provides id_token
        if (!userInfo) {
          return { success: false, error: 'User info is required' };
        }

        const userData = parseGoogleUserInfo(userInfo);

        const authenticationData = createStoredAuthenticationData(
          userData,
          credentialResponse.credential,
          sessionDuration
        );

        localStorage.setItem(storageKey, JSON.stringify(authenticationData));
        setUser(userData);
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to process Google login';
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
