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
  parseStoredAuthenticationData,
  isAuthenticationExpired,
  createStoredAuthenticationData,
  PROVIDER_DISPLAY_CONFIGURATIONS,
  type ProviderDisplayConfiguration,
} from '@audio-underview/sign-provider';

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

interface LoginResult {
  success: boolean;
  error?: string;
}

interface AuthenticationContextValue {
  user: OAuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  enabledProviders: OAuthProviderID[];
  loginWithGoogle: () => void;
  loginWithProvider: (providerID: OAuthProviderID, user: OAuthUser, credential: string) => LoginResult;
  logout: () => void;
}

const AuthenticationContext = createContext<AuthenticationContextValue | null>(null);

interface AuthenticationProviderInnerProps {
  children: ReactNode;
  enabledProviders: OAuthProviderID[];
  storageKey: string;
  sessionDuration: number;
  onGoogleError?: (error: string) => void;
}

function AuthenticationProviderInner({
  children,
  enabledProviders,
  storageKey,
  sessionDuration,
  onGoogleError,
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
      try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        const userInfo = await response.json();
        const userData = parseGoogleUserInfo(userInfo);
        saveUser(userData, tokenResponse.access_token);
      } catch {
        onGoogleError?.('Failed to fetch Google user info');
      }
    },
    onError: () => {
      onGoogleError?.('Google login failed');
    },
  });

  const loginWithProvider = useCallback(
    (_providerID: OAuthProviderID, userData: OAuthUser, credential: string): LoginResult => {
      return saveUser(userData, credential);
    },
    [saveUser]
  );

  const logout = useCallback(() => {
    if (user?.provider === 'google') {
      googleLogout();
    }
    localStorage.removeItem(storageKey);
    setUser(null);
  }, [user, storageKey]);

  const value = useMemo<AuthenticationContextValue>(
    () => ({
      user,
      isAuthenticated: !!user,
      isLoading,
      enabledProviders,
      loginWithGoogle: googleLogin,
      loginWithProvider,
      logout,
    }),
    [user, isLoading, enabledProviders, googleLogin, loginWithProvider, logout]
  );

  return <AuthenticationContext.Provider value={value}>{children}</AuthenticationContext.Provider>;
}

export interface AuthenticationProviderProps {
  children: ReactNode;
  googleClientID?: string;
  enabledProviders: OAuthProviderID[];
  storageKey?: string;
  sessionDuration?: number;
  onGoogleError?: (error: string) => void;
}

export function AuthenticationProvider({
  children,
  googleClientID,
  enabledProviders,
  storageKey = DEFAULT_STORAGE_KEY,
  sessionDuration = 24 * 60 * 60 * 1000,
  onGoogleError,
}: AuthenticationProviderProps) {
  const content = (
    <AuthenticationProviderInner
      enabledProviders={enabledProviders}
      storageKey={storageKey}
      sessionDuration={sessionDuration}
      onGoogleError={onGoogleError}
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
