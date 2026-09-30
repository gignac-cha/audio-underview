import { StrictMode, type ReactNode } from 'react';
import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { page } from 'vitest/browser';
import type { OAuthUser } from '@audio-underview/sign-provider';
import { AuthenticationContext } from '../contexts/authentication-context-value.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { clearNotices, getNotices } from '../design-system/notice-store.ts';
import { AuthenticationCallbackPage } from './AuthenticationCallbackPage.tsx';
import { SignInPage } from './SignInPage.tsx';

const USER: OAuthUser = {
  id: 'github-4821',
  email: 'sky@example.com',
  name: '김하늘',
  picture: 'https://avatars.example.com/4821.png',
  provider: 'github',
};

const ONE_HOUR_IN_SECONDS = 60 * 60;

function base64URL(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createSessionToken(payload: Record<string, unknown>): string {
  return `${base64URL({ alg: 'HS256', typ: 'JWT' })}.${base64URL(payload)}.signature`;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The OAuth workers set `user` to an already URI-encoded JSON string, so it is encoded twice in the URL. */
function encodeUser(user: unknown): string {
  return encodeURIComponent(JSON.stringify(user));
}

function callbackPath(parameters: Record<string, string>): string {
  return `/authentication/callback?${new URLSearchParams(parameters).toString()}`;
}

function createAuthentication(overrides: Partial<AuthenticationContextValue> = {}): AuthenticationContextValue {
  return {
    user: undefined,
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
}

async function renderCallback(
  path: string,
  {
    overrides = {},
    signInElement = <p>로그인 화면</p>,
    strict = false,
  }: { overrides?: Partial<AuthenticationContextValue>; signInElement?: ReactNode; strict?: boolean } = {},
) {
  const authentication = createAuthentication(overrides);
  const tree = (
    <AuthenticationContext.Provider value={authentication}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/authentication/callback" element={<AuthenticationCallbackPage />} />
          <Route path="/home" element={<p>홈 화면</p>} />
          <Route path="/sign/in" element={signInElement} />
        </Routes>
      </MemoryRouter>
    </AuthenticationContext.Provider>
  );
  const screen = await render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { authentication, screen };
}

async function expectFailure(authentication: AuthenticationContextValue, description?: string) {
  await expect.element(page.getByText('로그인 화면')).toBeVisible();
  expect(authentication.loginWithProvider).not.toHaveBeenCalled();
  expect(getNotices()).toEqual([expect.objectContaining({ tone: 'error', title: '로그인 실패', description })]);
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  clearNotices();
});

describe('AuthenticationCallbackPage', () => {
  test('signs in with session_token for the time left until exp, then goes to /home', async () => {
    const expiresAtInSeconds = nowInSeconds() + ONE_HOUR_IN_SECONDS;
    const sessionToken = createSessionToken({ sub: USER.id, exp: expiresAtInSeconds });
    const before = Date.now();

    const { authentication } = await renderCallback(
      callbackPath({
        user: encodeUser(USER),
        access_token: 'provider-access-token',
        uuid: '6f1c1d52-8d0f-4d6f-9b34-2f0f0c7a1a11',
        session_token: sessionToken,
      }),
    );

    await expect.element(page.getByText('홈 화면')).toBeVisible();
    const after = Date.now();

    expect(authentication.loginWithProvider).toHaveBeenCalledOnce();
    const [providerID, user, credential, durationMilliseconds] = vi.mocked(authentication.loginWithProvider).mock
      .calls[0];
    expect(providerID).toBe('github');
    expect(user).toEqual(USER);
    expect(credential).toBe(sessionToken);
    expect(durationMilliseconds).toBeGreaterThanOrEqual(expiresAtInSeconds * 1000 - after);
    expect(durationMilliseconds).toBeLessThanOrEqual(expiresAtInSeconds * 1000 - before);
    expect(getNotices()).toHaveLength(0);
  });

  test('shows 로그인하는 중입니다 while it signs in', async () => {
    let statusDuringSignIn: string | null | undefined;
    const sessionToken = createSessionToken({ exp: nowInSeconds() + ONE_HOUR_IN_SECONDS });

    await renderCallback(callbackPath({ user: encodeUser(USER), session_token: sessionToken }), {
      overrides: {
        loginWithProvider: vi.fn(() => {
          statusDuringSignIn = document.querySelector('[role="status"]')?.textContent;
          return { success: true };
        }),
      },
    });

    await expect.element(page.getByText('홈 화면')).toBeVisible();
    expect(statusDuringSignIn).toBe('로그인하는 중입니다');
  });

  test('fails without session_token and never signs in with access_token', async () => {
    const { authentication } = await renderCallback(
      callbackPath({ user: encodeUser(USER), access_token: createSessionToken({ exp: nowInSeconds() + 3600 }) }),
    );

    await expectFailure(authentication);
  });

  test('reports error_description when the provider returns an error', async () => {
    const { authentication } = await renderCallback(
      callbackPath({ error: 'access_denied', error_description: '사용자가 로그인을 취소했습니다.' }),
    );

    await expectFailure(authentication, '사용자가 로그인을 취소했습니다.');
  });

  test('reports 로그인에 실패했습니다. when the error has no description', async () => {
    const { authentication } = await renderCallback(callbackPath({ error: 'server_error' }));

    await expectFailure(authentication, '로그인에 실패했습니다.');
  });

  test.each([
    { case: 'user is missing', user: undefined },
    { case: 'user is not JSON', user: encodeURIComponent('{not json') },
    { case: 'user has no name', user: encodeUser({ ...USER, name: '' }) },
    { case: 'user has an unknown provider', user: encodeUser({ ...USER, provider: 'myspace' }) },
    { case: 'user has an invalid email', user: encodeUser({ ...USER, email: 'not-an-email' }) },
  ])('fails when $case', async ({ user }) => {
    const sessionToken = createSessionToken({ exp: nowInSeconds() + ONE_HOUR_IN_SECONDS });
    const parameters: Record<string, string> = { session_token: sessionToken };
    if (user !== undefined) {
      parameters.user = user;
    }

    const { authentication } = await renderCallback(callbackPath(parameters));

    await expectFailure(authentication);
  });

  test.each([
    { case: 'has already expired', sessionToken: createSessionToken({ exp: nowInSeconds() - 60 }) },
    { case: 'has no exp claim', sessionToken: createSessionToken({ sub: USER.id }) },
    { case: 'is not a JWT', sessionToken: 'not-a-jwt' },
  ])('fails when session_token $case', async ({ sessionToken }) => {
    const { authentication } = await renderCallback(
      callbackPath({ user: encodeUser(USER), session_token: sessionToken }),
    );

    await expectFailure(authentication);
  });

  test('fails when saving the sign-in fails', async () => {
    const sessionToken = createSessionToken({ exp: nowInSeconds() + ONE_HOUR_IN_SECONDS });
    const { authentication } = await renderCallback(
      callbackPath({ user: encodeUser(USER), session_token: sessionToken }),
      { overrides: { loginWithProvider: vi.fn().mockReturnValue({ success: false, error: 'quota exceeded' }) } },
    );

    await expect.element(page.getByText('로그인 화면')).toBeVisible();
    expect(authentication.loginWithProvider).toHaveBeenCalledOnce();
    expect(getNotices()).toEqual([expect.objectContaining({ tone: 'error', title: '로그인 실패' })]);
  });

  test('never calls fetch, on success or on failure', async () => {
    const sessionToken = createSessionToken({ exp: nowInSeconds() + ONE_HOUR_IN_SECONDS });

    const success = await renderCallback(callbackPath({ user: encodeUser(USER), session_token: sessionToken }));
    await expect.element(page.getByText('홈 화면')).toBeVisible();
    await success.screen.unmount();

    const failure = await renderCallback(callbackPath({ user: encodeUser(USER), access_token: 'provider-access-token' }));
    await expect.element(page.getByText('로그인 화면')).toBeVisible();
    await failure.screen.unmount();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('handles one callback once under React StrictMode', async () => {
    const sessionToken = createSessionToken({ exp: nowInSeconds() + ONE_HOUR_IN_SECONDS });

    const { authentication } = await renderCallback(
      callbackPath({ user: encodeUser(USER), session_token: sessionToken }),
      { strict: true },
    );

    await expect.element(page.getByText('홈 화면')).toBeVisible();
    expect(authentication.loginWithProvider).toHaveBeenCalledOnce();
  });

  test('shows the failure notice on the sign-in screen after it redirects', async () => {
    await renderCallback(callbackPath({ error: 'access_denied', error_description: '권한을 허용하지 않았습니다.' }), {
      signInElement: <SignInPage />,
    });

    const alert = page.getByRole('alert');
    await expect.element(alert).toHaveTextContent('로그인 실패');
    await expect.element(alert).toHaveTextContent('권한을 허용하지 않았습니다.');
    await expect.element(page.getByRole('button', { name: 'Google로 계속하기' })).toBeVisible();
  });
});
