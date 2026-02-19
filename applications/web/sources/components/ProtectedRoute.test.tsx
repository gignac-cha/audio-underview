import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProtectedRoute } from './ProtectedRoute.tsx';
import { AuthenticationContext } from '../contexts/authentication-context-value.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { page } from '@vitest/browser/context';

function createMockAuth(overrides: Partial<AuthenticationContextValue> = {}): AuthenticationContextValue {
  return {
    user: null,
    isAuthenticated: false,
    isLoading: false,
    enabledProviders: [],
    isGoogleConfigured: false,
    isGitHubConfigured: false,
    loginWithGoogle: vi.fn(),
    loginWithGitHub: vi.fn(),
    loginWithProvider: vi.fn().mockReturnValue({ success: true }),
    logout: vi.fn(),
    ...overrides,
  };
}

describe('ProtectedRoute', () => {
  test('renders children when authenticated', async () => {
    const auth = createMockAuth({
      isAuthenticated: true,
      user: { id: 'u1', name: 'User', email: 'u@test.com', provider: 'google' },
    });

    await render(
      <AuthenticationContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/protected']}>
          <Routes>
            <Route path="/protected" element={<ProtectedRoute><p>Secret Content</p></ProtectedRoute>} />
          </Routes>
        </MemoryRouter>
      </AuthenticationContext.Provider>,
    );

    await expect.element(page.getByText('Secret Content')).toBeVisible();
  });

  test('redirects to sign-in when not authenticated', async () => {
    const auth = createMockAuth({ isAuthenticated: false });

    await render(
      <AuthenticationContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/protected']}>
          <Routes>
            <Route path="/protected" element={<ProtectedRoute><p>Secret</p></ProtectedRoute>} />
            <Route path="/sign/in" element={<p>Sign In Page</p>} />
          </Routes>
        </MemoryRouter>
      </AuthenticationContext.Provider>,
    );

    await expect.element(page.getByText('Sign In Page')).toBeVisible();
  });

  test('shows loading state while loading', async () => {
    const auth = createMockAuth({ isLoading: true });

    await render(
      <AuthenticationContext.Provider value={auth}>
        <MemoryRouter>
          <ProtectedRoute><p>Protected</p></ProtectedRoute>
        </MemoryRouter>
      </AuthenticationContext.Provider>,
    );

    await expect.element(page.getByText('Loading...')).toBeVisible();
  });
});
