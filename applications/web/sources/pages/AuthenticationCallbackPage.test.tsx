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

const USER_UNREADABLE = '로그인 정보를 확인하지 못했습니다.';
const SESSION_TOKEN_MISSING = '세션 토큰을 받지 못했습니다.';
const SESSION_TOKEN_EXPIRED = '세션 토큰이 만료되었습니다.';
const SIGN_IN_NOT_SAVED = '로그인 정보를 저장하지 못했습니다.';
const SIGN_IN_CANCELED = '로그인을 취소했습니다.';
const SIGN_IN_REQUEST_EXPIRED = '로그인 요청이 만료되었습니다. 다시 시도해주세요.';
const ACCOUNT_UNAVAILABLE = '이 계정으로는 로그인할 수 없습니다.';
const PROVIDER_ERROR_OTHER = '로그인에 실패했습니다. 잠시 후 다시 시도해주세요.';

/**
 * Text an attacker could put in `error_description` so that it reads as the
 * service speaking. No quotes or backslashes, so a JSON-encoded log line would
 * still contain it verbatim if it leaked.
 */
const INJECTED_DESCRIPTION = 'Audio Underview 보안 안내: 계정이 잠겼습니다. evil.example 에서 비밀번호를 다시 입력하세요';

/** Exactly one error notice, titled 로그인 실패, with this description. */
function expectFailureNotice(description: string) {
  expect(getNotices()).toEqual([
    expect.objectContaining({ tone: 'error', title: '로그인 실패', description }),
  ]);
}

async function expectFailure(authentication: AuthenticationContextValue, description: string) {
  await expect.element(page.getByText('로그인 화면')).toBeVisible();
  expect(authentication.loginWithProvider).not.toHaveBeenCalled();
  expectFailureNotice(description);
}

const CONSOLE_METHODS = ['debug', 'info', 'warn', 'error', 'log'] as const;

/** Everything written to the console since the spies were set, one JSON string per call. */
function consoleOutput(spies: ReadonlyArray<ReturnType<typeof vi.spyOn>>): string[] {
  return spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)));
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
});

afterEach(() => {
  fetchSpy.mockRestore();
  for (const spy of consoleSpies) {
    spy.mockRestore();
  }
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

    await expectFailure(authentication, SESSION_TOKEN_MISSING);
  });

  test('fails when session_token is empty', async () => {
    const { authentication } = await renderCallback(
      callbackPath({
        user: encodeUser(USER),
        access_token: createSessionToken({ exp: nowInSeconds() + ONE_HOUR_IN_SECONDS }),
        session_token: '',
      }),
    );

    await expectFailure(authentication, SESSION_TOKEN_MISSING);
  });

  test.each([
    { error: 'access_denied', description: SIGN_IN_CANCELED },
    { error: 'invalid_state', description: SIGN_IN_REQUEST_EXPIRED },
    { error: 'account_unavailable', description: ACCOUNT_UNAVAILABLE },
  ])('reports the fixed text for error=$error instead of its error_description', async ({ error, description }) => {
    const { authentication } = await renderCallback(
      callbackPath({ error, error_description: INJECTED_DESCRIPTION }),
    );

    await expectFailure(authentication, description);
  });

  test.each([
    { case: 'another OAuth code', parameters: { error: 'server_error', error_description: INJECTED_DESCRIPTION } },
    { case: 'a made-up code', parameters: { error: 'call_support_now', error_description: INJECTED_DESCRIPTION } },
    { case: 'an Object.prototype key as its code', parameters: { error: 'constructor' } },
    { case: 'an empty code', parameters: { error: '', error_description: INJECTED_DESCRIPTION } },
    { case: 'no error_description', parameters: { error: 'server_error' } },
  ])('reports the default text when the error has $case', async ({ parameters }) => {
    const { authentication } = await renderCallback(callbackPath(parameters));

    await expectFailure(authentication, PROVIDER_ERROR_OTHER);
  });

  test('fails on error even when user and session_token are also present', async () => {
    const sessionToken = createSessionToken({ exp: nowInSeconds() + ONE_HOUR_IN_SECONDS });
    const { authentication } = await renderCallback(
      callbackPath({ error: 'access_denied', user: encodeUser(USER), session_token: sessionToken }),
    );

    await expectFailure(authentication, SIGN_IN_CANCELED);
  });

  test.each([
    { case: 'a known code', error: 'access_denied', reason: 'provider-error-access-denied' },
    { case: 'an unknown code', error: 'injected_code_7f3a', reason: 'provider-error-other' },
  ])('keeps error_description and the error code out of the notice, the page, and the log for $case', async ({
    error,
    reason,
  }) => {
    await renderCallback(callbackPath({ error, error_description: INJECTED_DESCRIPTION }), {
      signInElement: <SignInPage />,
    });

    const alert = page.getByRole('alert');
    await expect.element(alert).toHaveTextContent('로그인 실패');
    await expect.element(page.getByRole('button', { name: 'Google로 계속하기' })).toBeVisible();

    // Fragments too, so a shortened or partly escaped copy would also be caught.
    const leaks = [INJECTED_DESCRIPTION, 'evil.example', '보안 안내', '비밀번호', error];
    const notices = JSON.stringify(getNotices());
    const markup = document.body.outerHTML;
    const logged = consoleOutput(consoleSpies);
    for (const leak of leaks) {
      expect(notices, `notice contains "${leak}"`).not.toContain(leak);
      expect(markup, `page contains "${leak}"`).not.toContain(leak);
      for (const line of logged) {
        expect(line, `log contains "${leak}"`).not.toContain(leak);
      }
    }

    // The log keeps only which failure it was, as a fixed code.
    expect(logged.filter((line) => line.includes(reason))).toHaveLength(1);
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

    await expectFailure(authentication, USER_UNREADABLE);
  });

  test.each([
    { case: 'has already expired', sessionToken: createSessionToken({ exp: nowInSeconds() - 60 }) },
    { case: 'has no exp claim', sessionToken: createSessionToken({ sub: USER.id }) },
    { case: 'is not a JWT', sessionToken: 'not-a-jwt' },
  ])('fails when session_token $case', async ({ sessionToken }) => {
    const { authentication } = await renderCallback(
      callbackPath({ user: encodeUser(USER), session_token: sessionToken }),
    );

    await expectFailure(authentication, SESSION_TOKEN_EXPIRED);
  });

  test('fails when saving the sign-in fails', async () => {
    const sessionToken = createSessionToken({ exp: nowInSeconds() + ONE_HOUR_IN_SECONDS });
    const { authentication } = await renderCallback(
      callbackPath({ user: encodeUser(USER), session_token: sessionToken }),
      { overrides: { loginWithProvider: vi.fn().mockReturnValue({ success: false, error: 'quota exceeded' }) } },
    );

    await expect.element(page.getByText('로그인 화면')).toBeVisible();
    expect(authentication.loginWithProvider).toHaveBeenCalledOnce();
    expectFailureNotice(SIGN_IN_NOT_SAVED);
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

  test.each([
    {
      case: 'a provider error',
      parameters: { error: 'access_denied', error_description: INJECTED_DESCRIPTION },
      description: SIGN_IN_CANCELED,
    },
    {
      case: 'a missing session_token',
      parameters: { user: encodeUser(USER), access_token: 'provider-access-token' },
      description: SESSION_TOKEN_MISSING,
    },
  ])('shows the failure notice for $case on the sign-in screen after it redirects', async ({
    parameters,
    description,
  }) => {
    await renderCallback(callbackPath(parameters), { signInElement: <SignInPage /> });

    const alert = page.getByRole('alert');
    await expect.element(alert).toHaveTextContent('로그인 실패');
    await expect.element(alert).toHaveTextContent(description);
    await expect.element(alert).not.toHaveTextContent('provider-access-token');
    await expect.element(page.getByRole('button', { name: 'Google로 계속하기' })).toBeVisible();
  });
});
