import { createContext } from 'react';
import {
  type OAuthUser,
  type OAuthProviderID,
  type LoginResult,
} from '@audio-underview/sign-provider';

export interface AuthenticationContextValue {
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

export const AuthenticationContext = createContext<AuthenticationContextValue | null>(null);
