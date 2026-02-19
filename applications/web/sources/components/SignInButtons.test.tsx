import { render } from 'vitest-browser-react';
import { SignInButtons } from './SignInButtons.tsx';
import { AuthenticationContext } from '../contexts/authentication-context-value.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { page } from '@vitest/browser/context';

function createWrapper(overrides: Partial<AuthenticationContextValue> = {}) {
  const auth: AuthenticationContextValue = {
    user: null,
    isAuthenticated: false,
    isLoading: false,
    enabledProviders: ['google', 'github'],
    isGoogleConfigured: true,
    isGitHubConfigured: true,
    loginWithGoogle: vi.fn(),
    loginWithGitHub: vi.fn(),
    loginWithProvider: vi.fn().mockReturnValue({ success: true }),
    logout: vi.fn(),
    ...overrides,
  };

  return {
    auth,
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <AuthenticationContext.Provider value={auth}>
        {children}
      </AuthenticationContext.Provider>
    ),
  };
}

describe('SignInButtons', () => {
  test('renders buttons for enabled providers', async () => {
    const { wrapper } = createWrapper();
    await render(<SignInButtons />, { wrapper });

    await expect.element(page.getByText('Sign in with Google')).toBeVisible();
    await expect.element(page.getByText('Sign in with GitHub')).toBeVisible();
  });

  test('calls loginWithGoogle when Google button is clicked', async () => {
    const { wrapper, auth } = createWrapper();
    await render(<SignInButtons />, { wrapper });

    await page.getByText('Sign in with Google').click();
    expect(auth.loginWithGoogle).toHaveBeenCalledOnce();
  });

  test('calls loginWithGitHub when GitHub button is clicked', async () => {
    const { wrapper, auth } = createWrapper();
    await render(<SignInButtons />, { wrapper });

    await page.getByText('Sign in with GitHub').click();
    expect(auth.loginWithGitHub).toHaveBeenCalledOnce();
  });

  test('calls onProviderClick for non-google/github providers', async () => {
    const onProviderClick = vi.fn();
    const { wrapper } = createWrapper({ enabledProviders: ['discord'] });
    await render(<SignInButtons onProviderClick={onProviderClick} />, { wrapper });

    await page.getByText('Sign in with Discord').click();
    expect(onProviderClick).toHaveBeenCalledWith('discord');
  });

  test('renders no buttons when no providers enabled', async () => {
    const { wrapper } = createWrapper({ enabledProviders: [] });
    const { container } = await render(<SignInButtons />, { wrapper });

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(0);
  });
});
