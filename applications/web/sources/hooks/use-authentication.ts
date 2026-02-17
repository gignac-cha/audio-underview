import { useContext } from 'react';
import {
  AuthenticationContext,
  type AuthenticationContextValue,
} from '../contexts/authentication-context-value.ts';

export function useAuthentication(): AuthenticationContextValue {
  const context = useContext(AuthenticationContext);
  if (!context) {
    throw new Error('useAuthentication must be used within AuthenticationProvider');
  }
  return context;
}
