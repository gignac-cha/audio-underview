import { renderHook } from 'vitest-browser-react';
import { AuthenticationProvider } from './AuthenticationContext.tsx';
import { useAuthentication } from '../hooks/use-authentication.ts';
import type { ReactNode } from 'react';

vi.mock('@audio-underview/logger', () => ({
  createBrowserLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createWrapper(props: {
  enabledProviders?: string[];
  googleWorkerURL?: string;
  githubWorkerURL?: string;
  storageKey?: string;
  sessionDuration?: number;
  onGoogleError?: (error: string) => void;
  onGitHubError?: (error: string) => void;
} = {}) {
  const {
    enabledProviders = ['google', 'github'],
    storageKey = `test-auth-${crypto.randomUUID()}`,
    sessionDuration = 24 * 60 * 60 * 1000,
    ...rest
  } = props;

  return ({ children }: { children: ReactNode }) => (
    <AuthenticationProvider
      enabledProviders={enabledProviders as never[]}
      storageKey={storageKey}
      sessionDuration={sessionDuration}
      {...rest}
    >
      {children}
    </AuthenticationProvider>
  );
}

describe('AuthenticationContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('initial state is unauthenticated', async () => {
    const { result } = await renderHook(() => useAuthentication(), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  test('restores user from localStorage', async () => {
    const storageKey = `test-auth-restore-${crypto.randomUUID()}`;
    const storedData = {
      user: { id: 'u1', name: 'Stored User', email: 'stored@test.com', provider: 'google' },
      credential: 'stored-token',
      expiresAt: Date.now() + 3_600_000,
    };
    localStorage.setItem(storageKey, JSON.stringify(storedData));

    const { result } = await renderHook(() => useAuthentication(), {
      wrapper: createWrapper({ storageKey }),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.user).toEqual(storedData.user);
    expect(result.current.isAuthenticated).toBe(true);

    localStorage.removeItem(storageKey);
  });

  test('clears expired data from localStorage', async () => {
    const storageKey = `test-auth-expired-${crypto.randomUUID()}`;
    const expiredData = {
      user: { id: 'u1', name: 'Expired', email: 'expired@test.com', provider: 'google' },
      credential: 'expired-token',
      expiresAt: Date.now() - 1000,
    };
    localStorage.setItem(storageKey, JSON.stringify(expiredData));

    const { result } = await renderHook(() => useAuthentication(), {
      wrapper: createWrapper({ storageKey }),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  test('clears invalid JSON from localStorage', async () => {
    const storageKey = `test-auth-invalid-${crypto.randomUUID()}`;
    localStorage.setItem(storageKey, 'not-valid-json{{{');

    const { result } = await renderHook(() => useAuthentication(), {
      wrapper: createWrapper({ storageKey }),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.user).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  test('loginWithProvider saves user and updates state', async () => {
    const storageKey = `test-auth-login-${crypto.randomUUID()}`;
    const { result } = await renderHook(() => useAuthentication(), {
      wrapper: createWrapper({ storageKey }),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const userData = { id: 'u2', name: 'New User', email: 'new@test.com', provider: 'github' as const };
    const loginResult = result.current.loginWithProvider('github', userData, 'new-token');

    expect(loginResult.success).toBe(true);

    await vi.waitFor(() => {
      expect(result.current.user).toEqual(userData);
      expect(result.current.isAuthenticated).toBe(true);
    });

    const stored = JSON.parse(localStorage.getItem(storageKey)!);
    expect(stored.user).toEqual(userData);
    expect(stored.credential).toBe('new-token');

    localStorage.removeItem(storageKey);
  });

  test('logout clears user and localStorage', async () => {
    const storageKey = `test-auth-logout-${crypto.randomUUID()}`;
    const storedData = {
      user: { id: 'u1', name: 'User', email: 'u@test.com', provider: 'google' },
      credential: 'token',
      expiresAt: Date.now() + 3_600_000,
    };
    localStorage.setItem(storageKey, JSON.stringify(storedData));

    const { result } = await renderHook(() => useAuthentication(), {
      wrapper: createWrapper({ storageKey }),
    });

    await vi.waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
    });

    result.current.logout();

    await vi.waitFor(() => {
      expect(result.current.user).toBeNull();
      expect(result.current.isAuthenticated).toBe(false);
    });
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  test('loginWithGoogle calls onGoogleError when URL not configured', async () => {
    const onGoogleError = vi.fn();
    const { result } = await renderHook(() => useAuthentication(), {
      wrapper: createWrapper({ onGoogleError }),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    result.current.loginWithGoogle();

    expect(onGoogleError).toHaveBeenCalledWith('Google OAuth Worker URL is not configured');
  });

  test('loginWithGitHub calls onGitHubError when URL not configured', async () => {
    const onGitHubError = vi.fn();
    const { result } = await renderHook(() => useAuthentication(), {
      wrapper: createWrapper({ onGitHubError }),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    result.current.loginWithGitHub();

    expect(onGitHubError).toHaveBeenCalledWith('GitHub OAuth Worker URL is not configured');
  });
});
