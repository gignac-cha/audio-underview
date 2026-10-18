import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import type { SchedulerRow, SchedulerRunRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import { test, expect } from '../tests/extensions.ts';
import { worker } from '../tests/mocks/browser.ts';
import { ToastProvider } from '../contexts/ToastContext.tsx';
import { AuthenticationContext } from '../contexts/authentication-context-value.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { SchedulerDetailPage } from './SchedulerDetailPage.tsx';

const SCHEDULER_MANAGER_URL = 'http://localhost:7777';
const CRAWLER_MANAGER_URL = 'http://localhost:8888';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';

vi.mock('@audio-underview/sign-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@audio-underview/sign-provider')>();
  return {
    ...actual,
    loadAuthenticationData: vi.fn(() => ({
      user: { id: 'u1', name: 'Test', email: 'test@example.com', provider: 'google' },
      credential: 'test-access-token',
      expiresAt: Date.now() + 3_600_000,
    })),
  };
});

function createAuthentication(): AuthenticationContextValue {
  return {
    user: { id: 'u1', name: 'Test', email: 'test@example.com', provider: 'google' },
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

function createScheduler(): SchedulerRow {
  return {
    id: 's1',
    user_uuid: 'u1',
    name: 'Morning Pipeline',
    cron_expression: '0 9 * * *',
    is_enabled: true,
    last_run_at: null,
    timezone: 'Asia/Seoul',
    next_run_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

function createStage(): SchedulerStageRow {
  return {
    id: 'stage-1',
    scheduler_id: 's1',
    stage_type: 'crawler',
    crawler_id: CRAWLER_ID,
    task_group_id: null,
    task_group_version: null,
    settings: null,
    stage_order: 0,
    input_schema: {},
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-10-01T00:00:00.000Z',
  };
}

function createRun(overrides: Partial<SchedulerRunRow> = {}): SchedulerRunRow {
  return {
    id: 'run-1',
    scheduler_id: 's1',
    status: 'completed',
    started_at: '2026-10-19T09:00:00.000Z',
    completed_at: '2026-10-19T09:00:05.000Z',
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-19T09:00:00.000Z',
    ...overrides,
  };
}

// The scheduler manager as it answers once a run exists; runs is what the history lists
interface ServerState {
  stages: SchedulerStageRow[];
  runs: SchedulerRunRow[];
  schedulerRequests: number;
}

function startServer(stages: SchedulerStageRow[] = [createStage()]): ServerState {
  const state: ServerState = { stages, runs: [], schedulerRequests: 0 };
  worker.use(
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1`, () => {
      state.schedulerRequests += 1;
      return HttpResponse.json(createScheduler());
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/stages`, () => {
      return HttpResponse.json({ data: state.stages });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs`, () => {
      return HttpResponse.json({ data: state.runs, total: state.runs.length, offset: 0, limit: 20 });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/:runID`, ({ params }) => {
      const run = state.runs.find((candidate) => candidate.id === params.runID);
      return HttpResponse.json({ ...run, stage_runs: [] });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/task-groups`, () => {
      return HttpResponse.json({ data: [] });
    }),
    http.get(`${CRAWLER_MANAGER_URL}/crawlers`, () => {
      return HttpResponse.json({
        data: [
          {
            id: CRAWLER_ID,
            user_uuid: 'u1',
            name: 'Headline Crawler',
            type: 'web',
            url_pattern: null,
            code: '',
            input_schema: {},
            output_schema: {},
            environment_variable_names: [],
            created_at: '2026-10-01T00:00:00.000Z',
            updated_at: '2026-10-01T00:00:00.000Z',
          },
        ],
        total: 1,
        offset: 0,
        limit: 20,
      });
    }),
  );
  return state;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <AuthenticationContext.Provider value={createAuthentication()}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/schedulers/s1']}>
            <Routes>
              <Route path="/schedulers/:id" element={<SchedulerDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthenticationContext.Provider>,
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SchedulerDetailPage manual run', () => {
  test('cannot run a scheduler that has no stages', async () => {
    startServer([]);

    await renderPage();

    await expect.element(page.getByText('No stages yet.', { exact: false })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Run now' })).toBeDisabled();
  });

  test('runs the scheduler, reads the history, the scheduler and expands the new run', async () => {
    const state = startServer();
    let executeRequests = 0;
    let authorization: string | null = null;
    worker.use(
      http.post(`${SCHEDULER_MANAGER_URL}/schedulers/s1/execute`, async ({ request }) => {
        executeRequests += 1;
        authorization = request.headers.get('Authorization');
        state.runs = [createRun()];
        return HttpResponse.json({
          run_id: 'run-1',
          status: 'completed',
          result: { count: 3 },
          error: null,
          started_at: '2026-10-19T09:00:00.000Z',
          completed_at: '2026-10-19T09:00:05.000Z',
        });
      }),
    );

    await renderPage();
    await expect.element(page.getByText('No runs yet.')).toBeVisible();
    const schedulerRequestsBefore = state.schedulerRequests;

    await page.getByRole('button', { name: 'Run now' }).click();

    await expect.element(page.getByText('Manual', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Manual/ })).toHaveAttribute('aria-expanded', 'true');
    expect(executeRequests).toBe(1);
    expect(authorization).toBe('Bearer test-access-token');
    // The last run time of the scheduler is read again
    await vi.waitFor(() => expect(state.schedulerRequests).toBeGreaterThan(schedulerRequestsBefore));
  });

  test('shows a run that a Workflow runs as pending and expands it', async () => {
    const state = startServer();
    worker.use(
      http.post(`${SCHEDULER_MANAGER_URL}/schedulers/s1/execute`, () => {
        state.runs = [createRun({ status: 'pending', started_at: null, completed_at: null })];
        return HttpResponse.json(
          { run_id: 'run-1', status: 'pending', result: null, error: null, started_at: null, completed_at: null },
          { status: 202 },
        );
      }),
    );

    await renderPage();
    await expect.element(page.getByText('No runs yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Run now' }).click();

    await expect.element(page.getByText('Pending', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Manual/ })).toHaveAttribute('aria-expanded', 'true');
  });

  test('expands the run and shows the error when a run that failed was recorded', async () => {
    const state = startServer();
    worker.use(
      http.post(`${SCHEDULER_MANAGER_URL}/schedulers/s1/execute`, () => {
        state.runs = [createRun({ status: 'failed', error: 'Invalid input_schema for stage 0' })];
        return HttpResponse.json(
          {
            run_id: 'run-1',
            status: 'failed',
            result: null,
            error: 'Invalid input_schema for stage 0',
            started_at: '2026-10-19T09:00:00.000Z',
            completed_at: '2026-10-19T09:00:01.000Z',
          },
          { status: 422 },
        );
      }),
    );

    await renderPage();
    await expect.element(page.getByText('No runs yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Run now' }).click();

    await expect.element(page.getByRole('button', { name: /Manual/ })).toHaveAttribute('aria-expanded', 'true');
    await expect.element(page.getByText('Failed', { exact: true })).toBeVisible();
    // Once in the toast and once in the expanded run
    await vi.waitFor(() => {
      expect(page.getByText('Invalid input_schema for stage 0').elements()).toHaveLength(2);
    });
  });

  test('tells when a run is already in progress', async () => {
    startServer();
    worker.use(
      http.post(`${SCHEDULER_MANAGER_URL}/schedulers/s1/execute`, () => {
        return HttpResponse.json(
          { error: 'conflict', error_description: 'A run is already in progress' },
          { status: 409 },
        );
      }),
    );

    await renderPage();
    await page.getByRole('button', { name: 'Run now' }).click();

    await expect.element(page.getByText('A run is already in progress')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Run now' })).toBeEnabled();
  });

  test('shows the server text when the request fails without a recorded run', async () => {
    startServer();
    worker.use(
      http.post(`${SCHEDULER_MANAGER_URL}/schedulers/s1/execute`, () => {
        return HttpResponse.json(
          { error: 'not_found', error_description: 'Scheduler not found' },
          { status: 404 },
        );
      }),
    );

    await renderPage();
    await page.getByRole('button', { name: 'Run now' }).click();

    await expect.element(page.getByText('Scheduler not found')).toBeVisible();
    await expect.element(page.getByText('No runs yet.')).toBeVisible();
  });

  test('cannot be pressed again while the request runs', async () => {
    const state = startServer();
    let executeRequests = 0;
    let respond: () => void = () => {};
    const responded = new Promise<void>((resolve) => {
      respond = resolve;
    });
    worker.use(
      http.post(`${SCHEDULER_MANAGER_URL}/schedulers/s1/execute`, async () => {
        executeRequests += 1;
        await responded;
        state.runs = [createRun()];
        return HttpResponse.json({ run_id: 'run-1', status: 'completed', result: null, error: null });
      }),
    );

    await renderPage();
    await page.getByRole('button', { name: 'Run now' }).click();

    await expect.element(page.getByRole('button', { name: 'Running...' })).toBeDisabled();
    expect(executeRequests).toBe(1);

    respond();

    await expect.element(page.getByRole('button', { name: 'Run now' })).toBeEnabled();
    await expect.element(page.getByRole('button', { name: /Manual/ })).toHaveAttribute('aria-expanded', 'true');
    expect(executeRequests).toBe(1);
  });
});
