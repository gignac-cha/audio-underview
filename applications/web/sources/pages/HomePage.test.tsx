import { StrictMode } from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { loadAuthenticationData, type OAuthUser } from '@audio-underview/sign-provider';
import { test, expect } from '../tests/extensions.ts';
import { worker } from '../tests/mocks/browser.ts';
import { AuthenticationContext, type AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { clearNotices, getNotices } from '../design-system/notice-store.ts';
import { HomePage } from './HomePage.tsx';

vi.mock('@audio-underview/sign-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@audio-underview/sign-provider')>();
  return {
    ...actual,
    loadAuthenticationData: vi.fn(),
  };
});

const GOOGLE_WORKER_URL = 'http://localhost:7101';
const GITHUB_WORKER_URL = 'http://localhost:7102';
const CREDENTIAL = 'home-session-token';

const GOOGLE_USER: OAuthUser = {
  id: 'google-user',
  name: '차진혁',
  email: 'jinhyeok@example.com',
  provider: 'google',
};

const GITHUB_USER: OAuthUser = {
  id: 'github-user',
  name: 'gignac-cha',
  email: null,
  provider: 'github',
};

function storeSession(user: OAuthUser) {
  vi.mocked(loadAuthenticationData).mockReturnValue({
    user,
    credential: CREDENTIAL,
    expiresAt: Date.now() + 3_600_000,
  });
}

function createAuthentication(user: OAuthUser, logout: () => void): AuthenticationContextValue {
  return {
    user,
    isAuthenticated: true,
    isLoading: false,
    enabledProviders: [],
    isGoogleConfigured: true,
    isGitHubConfigured: true,
    loginWithGoogle: vi.fn(),
    loginWithGitHub: vi.fn(),
    loginWithProvider: vi.fn().mockReturnValue({ success: true }),
    logout,
  };
}

async function renderHome(user: OAuthUser = GOOGLE_USER) {
  const logout = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  await render(
    <StrictMode>
      <AuthenticationContext.Provider value={createAuthentication(user, logout)}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/home']}>
            <Routes>
              <Route path="/home" element={<HomePage />} />
              <Route path="/sign/in" element={<p>로그인 화면</p>} />
              <Route path="/crawlers" element={<p>크롤러 화면</p>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AuthenticationContext.Provider>
    </StrictMode>,
  );

  return { logout };
}

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | null;
}

function respondWithAccounts(workerURL: string, respond: () => Response | Promise<Response>): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  worker.use(
    http.get(`${workerURL}/accounts`, ({ request }) => {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get('Authorization'),
      });
      return respond();
    }),
  );
  return requests;
}

const accountRegion = () => page.getByRole('region', { name: '계정' });
const linkedAccountsRegion = () => page.getByRole('region', { name: '연결된 로그인' });
const shortcutsRegion = () => page.getByRole('region', { name: '바로가기' });

/** Waits for the empty-list answer, so no request is still in flight when the test ends. */
async function waitForEmptyList() {
  await expect.element(linkedAccountsRegion().getByText('연결된 로그인이 없습니다')).toBeVisible();
}

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_OAUTH_WORKER_URL', GOOGLE_WORKER_URL);
  vi.stubEnv('VITE_GITHUB_OAUTH_WORKER_URL', GITHUB_WORKER_URL);
  storeSession(GOOGLE_USER);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(loadAuthenticationData).mockReset();
  clearNotices();
});

describe('HomePage — 계정', () => {
  test('greets the user and shows the name, email, and the provider used to sign in', async () => {
    respondWithAccounts(GOOGLE_WORKER_URL, () => HttpResponse.json({ accounts: [] }));
    await renderHome(GOOGLE_USER);

    await expect.element(page.getByRole('heading', { level: 1, name: '차진혁님, 안녕하세요' })).toBeVisible();
    await expect.element(accountRegion().getByText('차진혁', { exact: true })).toBeVisible();
    await expect.element(accountRegion().getByText('jinhyeok@example.com')).toBeVisible();
    await expect.element(accountRegion().getByText('Google로 로그인함')).toBeVisible();
    await waitForEmptyList();
  });

  test.each([
    ['null', null],
    ['missing', undefined],
  ])('leaves out the email line when the email is %s', async (_label, email) => {
    const user: OAuthUser = { ...GITHUB_USER, email };
    storeSession(user);
    respondWithAccounts(GITHUB_WORKER_URL, () => HttpResponse.json({ accounts: [] }));
    await renderHome(user);

    await expect.element(accountRegion().getByText('gignac-cha', { exact: true })).toBeVisible();
    await expect.element(accountRegion().getByText('GitHub로 로그인함')).toBeVisible();
    expect(accountRegion().element().querySelectorAll('p')).toHaveLength(2);
    await expect.element(accountRegion()).not.toHaveTextContent('@');
    await waitForEmptyList();
  });
});

describe('HomePage — 연결된 로그인', () => {
  test("requests /accounts from the Google worker with the stored credential", async () => {
    const requests = respondWithAccounts(GOOGLE_WORKER_URL, () => HttpResponse.json({ accounts: [] }));
    await renderHome(GOOGLE_USER);

    await expect.element(linkedAccountsRegion().getByText('연결된 로그인이 없습니다')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: `${GOOGLE_WORKER_URL}/accounts`,
      method: 'GET',
      authorization: `Bearer ${CREDENTIAL}`,
    });
  });

  test('requests /accounts from the GitHub worker when the user signed in with GitHub', async () => {
    storeSession(GITHUB_USER);
    const googleRequests = respondWithAccounts(GOOGLE_WORKER_URL, () => HttpResponse.json({ accounts: [] }));
    const githubRequests = respondWithAccounts(GITHUB_WORKER_URL, () => HttpResponse.json({ accounts: [] }));
    await renderHome(GITHUB_USER);

    await expect.element(linkedAccountsRegion().getByText('연결된 로그인이 없습니다')).toBeVisible();
    expect(googleRequests).toHaveLength(0);
    expect(githubRequests).toHaveLength(1);
    expect(githubRequests[0]).toEqual({
      url: `${GITHUB_WORKER_URL}/accounts`,
      method: 'GET',
      authorization: `Bearer ${CREDENTIAL}`,
    });
  });

  test('shows placeholders while loading, then each provider with its link date', async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    respondWithAccounts(GOOGLE_WORKER_URL, async () => {
      await released;
      return HttpResponse.json({
        accounts: [
          { provider: 'github', linkedAt: '2026-01-15T12:00:00.000Z' },
          { provider: 'google', linkedAt: '2026-08-03T12:00:00.000Z' },
          { provider: 'kakao', linkedAt: null },
        ],
      });
    });
    await renderHome(GOOGLE_USER);

    const loading = linkedAccountsRegion().getByRole('status');
    await expect.element(loading).toHaveTextContent('연결된 로그인을 불러오는 중입니다');
    expect(linkedAccountsRegion().getByRole('listitem').elements()).toHaveLength(0);

    release();

    const items = linkedAccountsRegion().getByRole('listitem');
    await expect.poll(() => items.elements()).toHaveLength(3);
    await expect.element(loading).not.toBeInTheDocument();

    const [github, google, kakao] = items.elements();
    expect(github).toHaveTextContent('GitHub');
    expect(github).toHaveTextContent('2026. 1. 15.');
    expect(github.querySelector('time')).toHaveAttribute('datetime', '2026-01-15T12:00:00.000Z');
    expect(google).toHaveTextContent('Google');
    expect(google).toHaveTextContent('2026. 8. 3.');
    expect(kakao).toHaveTextContent('Kakao');
    expect(kakao.querySelector('time')).toBeNull();
  });

  describe.each([360, 768, 1280])('at %ipx wide', (width) => {
    let initialViewport: [number, number] = [0, 0];

    beforeEach(async () => {
      initialViewport = [window.innerWidth, window.innerHeight];
      await page.viewport(width, 900);
    });

    afterEach(async () => {
      await page.viewport(...initialViewport);
    });

    test.each([
      ['one linked login', 'one'],
      ['the empty message', 'empty'],
      ['the failure message', 'failed'],
    ] as const)('keeps the list and the shortcuts in place when %s replaces the placeholder', async (_label, outcome) => {
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      respondWithAccounts(GOOGLE_WORKER_URL, async () => {
        await released;
        switch (outcome) {
          case 'failed':
            return HttpResponse.json({ error: 'accounts_unavailable' }, { status: 503 });
          case 'empty':
            return HttpResponse.json({ accounts: [] });
          case 'one':
            return HttpResponse.json({ accounts: [{ provider: 'google', linkedAt: '2026-08-03T12:00:00.000Z' }] });
        }
      });
      await renderHome();

      // The panel under the 연결된 로그인 heading, and where 바로가기 starts.
      const measure = async () => {
        await document.fonts.ready;
        const heading = linkedAccountsRegion().getByRole('heading', { level: 2, name: '연결된 로그인' }).element();
        const shortcutsHeading = shortcutsRegion().getByRole('heading', { level: 2, name: '바로가기' }).element();
        const surface = heading.nextElementSibling;
        if (surface === null) {
          throw new Error('The linked logins have no panel');
        }
        return {
          surfaceHeight: surface.getBoundingClientRect().height,
          shortcutsTop: shortcutsHeading.getBoundingClientRect().top,
        };
      };
      await expect.element(linkedAccountsRegion().getByRole('status')).toBeInTheDocument();
      const whileLoading = await measure();

      release();
      switch (outcome) {
        case 'failed':
          await expect.element(linkedAccountsRegion().getByRole('button', { name: '다시 시도' })).toBeVisible();
          break;
        case 'empty':
          await waitForEmptyList();
          break;
        case 'one':
          await expect.element(linkedAccountsRegion().getByRole('listitem')).toHaveTextContent('Google');
          break;
      }
      expect(await measure()).toEqual(whileLoading);

      if (outcome === 'one') {
        // One login fills the panel: no reserved room is left empty below it.
        const row = linkedAccountsRegion().getByRole('listitem').element().getBoundingClientRect();
        expect(whileLoading.surfaceHeight - row.height).toBeLessThanOrEqual(2);
      }
    });
  });

  test('says there are no linked logins when the list is empty', async () => {
    respondWithAccounts(GOOGLE_WORKER_URL, () => HttpResponse.json({ accounts: [] }));
    await renderHome();

    await expect.element(linkedAccountsRegion().getByText('연결된 로그인이 없습니다')).toBeVisible();
    expect(linkedAccountsRegion().getByRole('listitem').elements()).toHaveLength(0);
  });

  test('shows the failure message and 다시 시도, which requests the list again', async () => {
    let attempt = 0;
    const requests = respondWithAccounts(GOOGLE_WORKER_URL, () => {
      attempt += 1;
      if (attempt === 1) {
        return HttpResponse.json({ error: 'accounts_unavailable' }, { status: 503 });
      }
      return HttpResponse.json({ accounts: [{ provider: 'google', linkedAt: '2026-08-03T12:00:00.000Z' }] });
    });
    await renderHome();

    await expect.element(linkedAccountsRegion().getByText('연결된 로그인을 불러오지 못했습니다')).toBeVisible();
    await linkedAccountsRegion().getByRole('button', { name: '다시 시도' }).click();

    await expect.element(linkedAccountsRegion().getByRole('listitem')).toHaveTextContent('Google');
    await expect.element(linkedAccountsRegion().getByText('연결된 로그인을 불러오지 못했습니다')).not.toBeInTheDocument();
    expect(requests).toHaveLength(2);
  });

  test('treats a response that does not match the schema as a failure', async () => {
    respondWithAccounts(GOOGLE_WORKER_URL, () =>
      HttpResponse.json({ accounts: [{ provider: 'myspace', linkedAt: 'yesterday' }] }),
    );
    await renderHome();

    await expect.element(linkedAccountsRegion().getByText('연결된 로그인을 불러오지 못했습니다')).toBeVisible();
    await expect.element(linkedAccountsRegion().getByRole('button', { name: '다시 시도' })).toBeVisible();
  });

  test('shows the failure message without any request when the worker URL is not configured', async () => {
    vi.stubEnv('VITE_GOOGLE_OAUTH_WORKER_URL', undefined);
    const fetchSpy = vi.spyOn(window, 'fetch');
    await renderHome(GOOGLE_USER);

    await expect.element(linkedAccountsRegion().getByText('연결된 로그인을 불러오지 못했습니다')).toBeVisible();
    await linkedAccountsRegion().getByRole('button', { name: '다시 시도' }).click();
    await expect.element(linkedAccountsRegion().getByText('연결된 로그인을 불러오지 못했습니다')).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('signs out and goes to /sign/in with a notice when the worker answers 401', async () => {
    respondWithAccounts(GOOGLE_WORKER_URL, () => HttpResponse.json({ error: 'invalid_session' }, { status: 401 }));
    const { logout } = await renderHome();

    await expect.element(page.getByText('로그인 화면')).toBeVisible();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(getNotices()).toEqual([
      expect.objectContaining({ tone: 'error', title: '세션이 만료되었습니다', description: '다시 로그인해주세요.' }),
    ]);
  });

  test('handles a missing stored session like an expired one, without a request', async () => {
    vi.mocked(loadAuthenticationData).mockReturnValue(null);
    const fetchSpy = vi.spyOn(window, 'fetch');
    const { logout } = await renderHome();

    await expect.element(page.getByText('로그인 화면')).toBeVisible();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(getNotices()).toEqual([expect.objectContaining({ title: '세션이 만료되었습니다' })]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('HomePage — 상단 바와 바로가기', () => {
  test('로그아웃 signs out and goes to /sign/in', async () => {
    respondWithAccounts(GOOGLE_WORKER_URL, () => HttpResponse.json({ accounts: [] }));
    const { logout } = await renderHome();
    await waitForEmptyList();

    await page.getByRole('banner').getByRole('button', { name: '로그아웃' }).click();

    await expect.element(page.getByText('로그인 화면')).toBeVisible();
    expect(logout).toHaveBeenCalledTimes(1);
  });

  test('links the service name, the menu, and the shortcuts to their pages', async () => {
    respondWithAccounts(GOOGLE_WORKER_URL, () => HttpResponse.json({ accounts: [] }));
    await renderHome();
    await waitForEmptyList();

    const banner = page.getByRole('banner');
    await expect.element(banner.getByRole('link', { name: 'Audio Underview' })).toHaveAttribute('href', '/home');

    const navigation = page.getByRole('navigation', { name: '주 메뉴' });
    await expect.element(navigation.getByRole('link', { name: '홈' })).toHaveAttribute('href', '/home');
    await expect.element(navigation.getByRole('link', { name: '크롤러' })).toHaveAttribute('href', '/crawlers');
    await expect.element(navigation.getByRole('link', { name: '스케줄러' })).toHaveAttribute('href', '/schedulers');
    await expect.element(navigation.getByRole('link', { name: '홈' })).toHaveAttribute('aria-current', 'page');

    // Two cards, each one whole link.
    await expect.poll(() => shortcutsRegion().getByRole('link').elements()).toHaveLength(2);
    const crawlers = shortcutsRegion().getByRole('link', { name: /^크롤러/ });
    const schedulers = shortcutsRegion().getByRole('link', { name: /^스케줄러/ });
    await expect.element(crawlers).toHaveAttribute('href', '/crawlers');
    await expect.element(crawlers).toHaveTextContent('웹 페이지에서 필요한 내용을 뽑는 코드를 만들고 시험합니다');
    await expect.element(schedulers).toHaveAttribute('href', '/schedulers');
    await expect.element(schedulers).toHaveTextContent('크롤러를 순서대로 묶어 실행합니다');
    await expect.element(crawlers.getByRole('heading', { level: 3, name: '크롤러' })).toBeVisible();
    await expect.element(schedulers.getByRole('heading', { level: 3, name: '스케줄러' })).toBeVisible();

    await crawlers.click();
    await expect.element(page.getByText('크롤러 화면')).toBeVisible();
  });
});
