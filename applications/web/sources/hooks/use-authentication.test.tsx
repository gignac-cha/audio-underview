import { renderHook } from 'vitest-browser-react';
import { useAuthentication } from './use-authentication.ts';
import { AuthenticationContext } from '../contexts/authentication-context-value.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';

const mockContextValue: AuthenticationContextValue = {
  user: { id: 'u1', email: 'test@example.com', name: 'Test', provider: 'google' },
  isAuthenticated: true,
  isLoading: false,
  enabledProviders: ['google', 'github'],
  isGoogleConfigured: true,
  isGitHubConfigured: true,
  loginWithGoogle: vi.fn(),
  loginWithGitHub: vi.fn(),
  loginWithProvider: vi.fn().mockReturnValue({ success: true }),
  logout: vi.fn(),
};

describe('useAuthentication', () => {
  test('returns context value when inside provider', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthenticationContext.Provider value={mockContextValue}>
        {children}
      </AuthenticationContext.Provider>
    );

    const { result } = await renderHook(() => useAuthentication(), { wrapper });
    expect(result.current.user?.id).toBe('u1');
    expect(result.current.isAuthenticated).toBe(true);
  });

  test('isAuthenticated reflects user presence', async () => {
    const noUserContext = { ...mockContextValue, user: null, isAuthenticated: false };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthenticationContext.Provider value={noUserContext}>
        {children}
      </AuthenticationContext.Provider>
    );

    const { result } = await renderHook(() => useAuthentication(), { wrapper });
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  test('provides login and logout functions', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthenticationContext.Provider value={mockContextValue}>
        {children}
      </AuthenticationContext.Provider>
    );

    const { result } = await renderHook(() => useAuthentication(), { wrapper });
    expect(typeof result.current.loginWithGoogle).toBe('function');
    expect(typeof result.current.logout).toBe('function');
    expect(typeof result.current.loginWithProvider).toBe('function');
  });

  test('provides enabled provider information', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthenticationContext.Provider value={mockContextValue}>
        {children}
      </AuthenticationContext.Provider>
    );

    const { result } = await renderHook(() => useAuthentication(), { wrapper });
    expect(result.current.enabledProviders).toContain('google');
    expect(result.current.enabledProviders).toContain('github');
    expect(result.current.isGoogleConfigured).toBe(true);
  });
});
