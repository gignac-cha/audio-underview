import { cleanup, render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import type { JobStatus, NewscastJobSummary } from '@audio-underview/newscast-core';
import { test, expect } from '../tests/extensions.ts';
import { worker } from '../tests/mocks/browser.ts';
import { ToastProvider } from '../contexts/ToastContext.tsx';
import { AuthenticationContext, type AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { clearMediaTokens } from '../hooks/use-newscast-jobs.ts';
import { NewscastPage } from './NewscastPage.tsx';

const NEWSCAST_URL = 'http://localhost:6666';
const SCHEDULER_MANAGER_URL = 'http://localhost:7777';
const CRAWLER_MANAGER_URL = 'http://localhost:8888';
const USER = { id: 'u1', name: 'Test', email: 'test@example.com', provider: 'google' as const };

vi.mock('@audio-underview/sign-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@audio-underview/sign-provider')>();
  return {
    ...actual,
    loadAuthenticationData: vi.fn(() => ({ user: USER, credential: 'test-access-token', expiresAt: Date.now() + 3_600_000 })),
  };
});

function createAuthentication(): AuthenticationContextValue {
  return {
    user: USER,
    isAuthenticated: true,
    isLoading: false,
    enabledProviders: [],
    isGoogleConfigured: false,
    isGitHubConfigured: false,
    loginWithGoogle: vi.fn(),
    loginWithGitHub: vi.fn(),
    loginWithProvider: vi.fn().mockReturnValue({ success: true }),
    logout: vi.fn(),
  };
}

const DONE_SUMMARY: NewscastJobSummary = {
  id: 'job-done',
  status: 'done',
  stage: 'done',
  overallProgress: 1,
  createdAt: '2026-10-26T04:00:00.000+00:00',
  title: 'A finished newscast',
};

const RUNNING_SUMMARY: NewscastJobSummary = {
  id: 'job-running',
  status: 'running',
  stage: 'tts',
  overallProgress: 0.6,
  createdAt: '2026-10-26T04:10:00.000+00:00',
  title: 'A running newscast',
};

const DONE_STATUS: JobStatus = {
  id: 'job-done',
  stage: 'done',
  stageProgress: 1,
  overallProgress: 1,
  status: 'done',
  result: {
    sources: [{ title: 'The source article', originalUrl: 'https://example.com/a', discussionUrl: '', content: '' }],
    script: [{ speaker: 1, text: 'Welcome to the newscast.' }],
    segments: [{ index: 0, startMs: 0, durationMs: 1000 }],
    audioKey: 'job-done/part-1',
    parts: [
      {
        index: 1,
        audioKey: 'job-done/part-1',
        script: [{ speaker: 1, text: 'Welcome to the newscast.' }],
        segments: [{ index: 0, startMs: 0, durationMs: 1000 }],
        durationMs: 1000,
      },
    ],
  },
};

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return await render(
    <AuthenticationContext.Provider value={createAuthentication()}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/newscasts']}>
            <Routes>
              <Route path="/newscasts" element={<NewscastPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthenticationContext.Provider>,
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_NEWSCAST_WORKER_URL', NEWSCAST_URL);
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
  try {
    localStorage.removeItem('newscast-create-collapsed');
  } catch {
    // Nothing stored
  }
  worker.use(
    http.get(`${CRAWLER_MANAGER_URL}/provider-keys`, () =>
      HttpResponse.json({
        data: (['anthropic', 'openai', 'google', 'xai'] as const).map((provider) => ({
          provider,
          configured: provider === 'google',
          last4: null,
          validated_at: null,
        })),
      }),
    ),
    http.get(`${NEWSCAST_URL}/newscasts`, () => HttpResponse.json({ data: [RUNNING_SUMMARY, DONE_SUMMARY] })),
    http.get(`${NEWSCAST_URL}/newscasts/job-done`, () => HttpResponse.json(DONE_STATUS)),
    http.post(`${NEWSCAST_URL}/newscasts/job-done/media-token`, () => HttpResponse.json({ token: 'media-token', expiresIn: 3600 })),
  );
});

afterEach(async () => {
  // Unmounted before the URL goes, since the player builds audio URLs on it while it renders
  await cleanup();
  clearMediaTokens();
  vi.unstubAllEnvs();
});

describe('NewscastPage', () => {
  test('shows the navigation, the New newscast panel and the newscasts', async () => {
    await renderPage();

    await expect.element(page.getByRole('link', { name: 'Newscasts' })).toHaveAttribute('href', '/newscasts');
    await expect.element(page.getByRole('button', { name: /New newscast/ })).toBeInTheDocument();
    await expect.element(page.getByText('A running newscast')).toBeInTheDocument();
    await expect.element(page.getByText('A finished newscast')).toBeInTheDocument();
    // The list is not empty, so the panel starts folded away
    await expect.element(page.getByRole('button', { name: /New newscast/ })).toHaveAttribute('aria-expanded', 'false');
  });

  test('plays a selected newscast in the floating player with the media token of its part', async () => {
    const screen = await renderPage();

    await page.getByRole('button', { name: /A finished newscast/ }).click();
    await page.getByRole('button', { name: 'Play newscast' }).click();

    await expect.element(page.getByRole('button', { name: 'Close player' })).toBeInTheDocument();
    await expect
      .poll(() => screen.container.querySelector('audio')?.getAttribute('src'))
      .toBe(`${NEWSCAST_URL}/newscasts/job-done/audio?part=1&token=media-token`);
    await expect.element(page.getByText('Welcome to the newscast.').first()).toBeInTheDocument();
  });
});
