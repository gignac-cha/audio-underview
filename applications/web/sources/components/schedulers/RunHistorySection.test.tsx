import { useState } from 'react';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import type { CrawlerRow, SchedulerRunRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { useGetScheduler } from '../../hooks/use-scheduler-manager.ts';
import type { StageRunSummary } from '../../hooks/use-scheduler-runs.ts';
import { RunHistorySection } from './RunHistorySection.tsx';

const SCHEDULER_MANAGER_URL = 'http://localhost:7777';
const CRAWLER_MANAGER_URL = 'http://localhost:8888';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const FILE_ID = '11111111-1111-4111-8111-111111111111';
// Short enough for a test to see several refreshes
const REFRESH_INTERVAL_MILLISECONDS = 40;

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

function createStageRun(overrides: Partial<StageRunSummary> = {}): StageRunSummary {
  return {
    id: 'stage-run-1',
    run_id: 'run-1',
    stage_id: 'stage-1',
    stage_order: 0,
    status: 'completed',
    started_at: '2026-10-19T09:00:00.000Z',
    completed_at: '2026-10-19T09:00:02.000Z',
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    task_group_id: null,
    task_group_version: null,
    progress: null,
    logs_truncated: false,
    created_at: '2026-10-19T09:00:00.000Z',
    ...overrides,
  };
}

function createStage(overrides: Partial<SchedulerStageRow> = {}): SchedulerStageRow {
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
    ...overrides,
  };
}

function createCrawler(): CrawlerRow {
  return {
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
  };
}

interface HarnessProperties {
  stages: SchedulerStageRow[];
  initialExpandedRunID?: string;
  // Shows the last run time of the scheduler, which the page shows above the run history
  showsScheduler?: boolean;
}

function LastRun() {
  const { scheduler } = useGetScheduler('s1');
  return <p>Last run: {scheduler?.last_run_at ?? '-'}</p>;
}

function Harness({ stages, initialExpandedRunID, showsScheduler }: HarnessProperties) {
  const [expandedRunID, setExpandedRunID] = useState(initialExpandedRunID);
  return (
    <>
      {showsScheduler && <LastRun />}
      <RunHistorySection
        schedulerID="s1"
        stages={stages}
        crawlerMap={new Map([[CRAWLER_ID, createCrawler()]])}
        expandedRunID={expandedRunID}
        onExpandedRunIDChange={setExpandedRunID}
        refreshIntervalMilliseconds={REFRESH_INTERVAL_MILLISECONDS}
      />
    </>
  );
}

function createQueryClient(staleTimeMilliseconds?: number) {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: staleTimeMilliseconds },
      mutations: { retry: false },
    },
  });
}

function renderSection(
  stages: SchedulerStageRow[] = [createStage()],
  initialExpandedRunID?: string,
  { queryClient = createQueryClient(), showsScheduler = false } = {},
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness stages={stages} initialExpandedRunID={initialExpandedRunID} showsScheduler={showsScheduler} />
    </QueryClientProvider>,
  );
}

function respondWithRuns(runs: SchedulerRunRow[]) {
  worker.use(
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs`, () => {
      return HttpResponse.json({ data: runs, total: runs.length, offset: 0, limit: 20 });
    }),
  );
}

function respondWithRun(run: SchedulerRunRow, stageRuns: StageRunSummary[]) {
  worker.use(
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/${run.id}`, () => {
      return HttpResponse.json({ ...run, stage_runs: stageRuns });
    }),
  );
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeEach(() => {
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RunHistorySection list', () => {
  test('shows Manual or Scheduled in the Trigger column', async () => {
    respondWithRuns([
      createRun({ id: 'run-1', triggered_by: 'manual' }),
      createRun({ id: 'run-2', triggered_by: 'schedule', scheduled_for: '2026-10-19T09:00:00.000Z' }),
    ]);

    await renderSection();

    await expect.element(page.getByText('Trigger', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Manual', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Scheduled', { exact: true })).toBeVisible();
  });

  test('shows a skipped run as Skipped', async () => {
    respondWithRuns([
      createRun({ status: 'skipped', started_at: null, completed_at: null, triggered_by: 'schedule' }),
    ]);

    await renderSection();

    await expect.element(page.getByText('Skipped', { exact: true })).toBeVisible();
  });
});

describe('RunHistorySection stage runs', () => {
  test('lists the stage runs of an expanded run in order, named by their stage', async () => {
    const stages = [
      createStage({ id: 'stage-1', stage_order: 0 }),
      createStage({
        id: 'stage-3',
        stage_type: 'task_group',
        crawler_id: null,
        task_group_id: 'newscast',
        task_group_version: 3,
        settings: {},
        stage_order: 2,
      }),
    ];
    const run = createRun();
    respondWithRuns([run]);
    respondWithRun(run, [
      createStageRun({ id: 'sr-1', stage_id: 'stage-1', stage_order: 0 }),
      // The stage of this stage run was removed
      createStageRun({ id: 'sr-2', stage_id: 'gone', stage_order: 1, status: 'failed', error: 'Crawler exploded' }),
      // The group stage run keeps the version it was started with, which is not the stage's version now
      createStageRun({
        id: 'sr-3',
        stage_id: 'stage-3',
        stage_order: 2,
        task_group_id: 'newscast',
        task_group_version: 2,
      }),
    ]);

    await renderSection(stages);
    await page.getByRole('button', { name: /Manual/ }).click();

    await expect.element(page.getByText('Headline Crawler')).toBeVisible();
    await expect.element(page.getByText('Stage 1', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Task group newscast v2', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Crawler exploded')).toBeVisible();
    // The run itself took 5s; each of the three stage runs took 2s
    expect(page.getByText('2s', { exact: true }).elements()).toHaveLength(3);

    const text = document.body.innerText;
    expect(text.indexOf('Headline Crawler')).toBeLessThan(text.indexOf('Stage 1'));
    expect(text.indexOf('Stage 1')).toBeLessThan(text.indexOf('Task group newscast v2'));
  });

  test('shows the item counts of a fan-out stage and the progress of a task group', async () => {
    const run = createRun({ status: 'running', completed_at: null });
    respondWithRuns([run]);
    respondWithRun(run, [
      createStageRun({ id: 'sr-1', items_total: 3, items_succeeded: 2, items_failed: 1 }),
      createStageRun({
        id: 'sr-2',
        stage_id: 'stage-2',
        stage_order: 1,
        status: 'running',
        completed_at: null,
        task_group_id: 'newscast',
        task_group_version: 1,
        progress: {
          message: 'Rendering audio',
          completed: 3,
          total: 10,
          reported_at: '2026-10-19T09:00:03.000Z',
        },
      }),
    ]);

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();

    await expect.element(page.getByText('2/3 items · 1 failed', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Rendering audio · 3\/10 · /)).toBeVisible();
  });

  test('leaves out the failed count of a fan-out stage that lost no item', async () => {
    const run = createRun();
    respondWithRuns([run]);
    respondWithRun(run, [createStageRun({ items_total: 3, items_succeeded: 3, items_failed: 0 })]);

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();

    await expect.element(page.getByText('3/3 items', { exact: true })).toBeVisible();
  });

  test('keeps the error and result of the run below its stage runs', async () => {
    const run = createRun({ status: 'failed', error: 'Stage 0 failed', result: { count: 7 } });
    respondWithRuns([run]);
    respondWithRun(run, [createStageRun()]);

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();

    await expect.element(page.getByText('Stage 0 failed', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/"count": 7/)).toBeVisible();
    const text = document.body.innerText;
    expect(text.indexOf('Headline Crawler')).toBeLessThan(text.indexOf('Stage 0 failed'));
  });

  test('says there are no additional details for a run without stage runs, error or result', async () => {
    const run = createRun({ status: 'skipped', started_at: null, completed_at: null });
    respondWithRuns([run]);
    respondWithRun(run, []);

    await renderSection();
    await page.getByRole('button', { name: /Skipped/ }).click();

    await expect.element(page.getByText('No additional details.')).toBeVisible();
  });
});

describe('RunHistorySection stage run detail', () => {
  const run = createRun();

  function respondWithStageRun(overrides: Record<string, unknown> = {}) {
    respondWithRuns([run]);
    respondWithRun(run, [createStageRun()]);
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1/stage-runs/stage-run-1`, () => {
        return HttpResponse.json({
          ...createStageRun(),
          input: { url: 'https://example.com/news' },
          output: { headlines: ['First', 'Second'] },
          logs: [{ level: 'info', message: 'Fetched two headlines', timestamp: '2026-10-19T09:00:01.000Z' }],
          ...overrides,
        });
      }),
    );
  }

  test('shows the input, output and logs of the stage run that is clicked', async () => {
    respondWithStageRun();

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();
    await page.getByRole('button', { name: /Headline Crawler/ }).click();

    await expect.element(page.getByText('Input', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/"url": "https:\/\/example\.com\/news"/)).toBeVisible();
    await expect.element(page.getByText('Output', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/"headlines"/)).toBeVisible();
    await expect.element(page.getByText('Logs', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Fetched two headlines/)).toBeVisible();
    await expect.element(page.getByText('Logs were truncated.')).not.toBeInTheDocument();
  });

  test('says when the logs were truncated', async () => {
    respondWithStageRun({ logs_truncated: true });

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();
    await page.getByRole('button', { name: /Headline Crawler/ }).click();

    await expect.element(page.getByText('Logs were truncated.')).toBeVisible();
  });

  test('lists the files in the output with a download', async () => {
    respondWithStageRun({
      output: { audio: { file_id: FILE_ID, content_type: 'audio/mpeg', size: 2048, name: 'news.mp3' } },
    });

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();
    await page.getByRole('button', { name: /Headline Crawler/ }).click();

    await expect.element(page.getByText('Files', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Download news.mp3' })).toBeVisible();
  });

  test('downloads a file from the crawler manager', async () => {
    respondWithStageRun({
      output: { audio: { file_id: FILE_ID, content_type: 'audio/mpeg', size: 2048, name: 'news.mp3' } },
    });
    let authorization: string | null = null;
    worker.use(
      http.get(`${CRAWLER_MANAGER_URL}/files/${FILE_ID}`, ({ request }) => {
        authorization = request.headers.get('Authorization');
        return new HttpResponse('audio', { headers: { 'Content-Type': 'audio/mpeg' } });
      }),
    );

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();
    await page.getByRole('button', { name: /Headline Crawler/ }).click();
    await page.getByRole('button', { name: 'Download news.mp3' }).click();

    await vi.waitFor(() => expect(authorization).toBe('Bearer test-access-token'));
  });

  test('shows the error when the stage run cannot be read', async () => {
    respondWithRuns([run]);
    respondWithRun(run, [createStageRun()]);
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1/stage-runs/stage-run-1`, () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'Stage run not found' }, { status: 404 });
      }),
    );

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();
    await page.getByRole('button', { name: /Headline Crawler/ }).click();

    await expect.element(page.getByText('Failed to load stage run: Stage run not found')).toBeVisible();
  });
});

describe('RunHistorySection refresh', () => {
  test('reads the list again while a run is running and stops once none is', async () => {
    let listRequests = 0;
    let status: SchedulerRunRow['status'] = 'running';
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs`, () => {
        listRequests += 1;
        const run = createRun({ status, completed_at: status === 'running' ? null : '2026-10-19T09:00:05.000Z' });
        return HttpResponse.json({ data: [run], total: 1, offset: 0, limit: 20 });
      }),
    );

    await renderSection();
    await expect.element(page.getByText('Running', { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(listRequests).toBeGreaterThanOrEqual(3));

    status = 'completed';
    await expect.element(page.getByText('Completed', { exact: true })).toBeVisible();
    const requestsWhenCompleted = listRequests;
    await wait(REFRESH_INTERVAL_MILLISECONDS * 6);

    expect(listRequests).toBe(requestsWhenCompleted);
  });

  test('reads the list again for a pending run too', async () => {
    let status: SchedulerRunRow['status'] = 'pending';
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs`, () => {
        const run = createRun({ status, started_at: null, completed_at: null });
        return HttpResponse.json({ data: [run], total: 1, offset: 0, limit: 20 });
      }),
    );

    await renderSection();
    await expect.element(page.getByText('Pending', { exact: true })).toBeVisible();

    status = 'failed';
    await expect.element(page.getByText('Failed', { exact: true })).toBeVisible();
  });

  test('does not read the list again when no run is pending or running', async () => {
    let listRequests = 0;
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs`, () => {
        listRequests += 1;
        return HttpResponse.json({
          data: [createRun(), createRun({ id: 'run-2', status: 'partially_failed' }), createRun({ id: 'run-3', status: 'skipped' })],
          total: 3,
          offset: 0,
          limit: 20,
        });
      }),
    );

    await renderSection();
    await expect.element(page.getByText('Partial', { exact: true })).toBeVisible();
    await wait(REFRESH_INTERVAL_MILLISECONDS * 6);

    expect(listRequests).toBe(1);
  });

  test('reads an expanded run that is running again until it ends, and its stage run once more when its stage ends', async () => {
    const runningRun = createRun({ status: 'running', completed_at: null });
    let hasEnded = false;
    let detailRequests = 0;
    let stageRunRequests = 0;
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs`, () => {
        return HttpResponse.json({ data: [hasEnded ? createRun() : runningRun], total: 1, offset: 0, limit: 20 });
      }),
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1`, () => {
        detailRequests += 1;
        return HttpResponse.json({
          ...(hasEnded ? createRun() : runningRun),
          stage_runs: [createStageRun(hasEnded ? {} : { status: 'running', completed_at: null })],
        });
      }),
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1/stage-runs/stage-run-1`, () => {
        stageRunRequests += 1;
        return HttpResponse.json({
          ...createStageRun(),
          input: { url: 'https://example.com/news' },
          output: hasEnded ? { headlines: ['First'] } : null,
          logs: null,
        });
      }),
    );

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();
    await page.getByRole('button', { name: /Headline Crawler/ }).click();

    await expect.element(page.getByText('None', { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(detailRequests).toBeGreaterThanOrEqual(3));
    // The stage run is not read again while its stage runs
    expect(stageRunRequests).toBe(1);

    hasEnded = true;
    await expect.element(page.getByText(/"headlines"/)).toBeVisible();
    const detailRequestsWhenEnded = detailRequests;
    await wait(REFRESH_INTERVAL_MILLISECONDS * 6);

    expect(detailRequests).toBe(detailRequestsWhenEnded);
    expect(stageRunRequests).toBe(2);
  });

  test('reads the scheduler again when a run that was in progress ends, as the server records its last run time then', async () => {
    let lastRunAt: string | null = null;
    let status: SchedulerRunRow['status'] = 'pending';
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1`, () => {
        return HttpResponse.json({ id: 's1', last_run_at: lastRunAt });
      }),
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs`, () => {
        const run = createRun({ status, started_at: null, completed_at: null });
        return HttpResponse.json({ data: [run], total: 1, offset: 0, limit: 20 });
      }),
    );

    // The staleness of the page: nothing but an invalidation reads the scheduler again
    await renderSection([createStage()], undefined, {
      queryClient: createQueryClient(5 * 60 * 1000),
      showsScheduler: true,
    });
    await expect.element(page.getByText('Pending', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Last run: -')).toBeVisible();
    await wait(REFRESH_INTERVAL_MILLISECONDS * 4);
    await expect.element(page.getByText('Last run: -')).toBeVisible();

    lastRunAt = '2026-10-19T09:00:05.000Z';
    status = 'completed';

    await expect.element(page.getByText('Last run: 2026-10-19T09:00:05.000Z')).toBeVisible();
  });

  test('does not read the scheduler again for a list that only shows ended runs', async () => {
    let schedulerRequests = 0;
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1`, () => {
        schedulerRequests += 1;
        return HttpResponse.json({ id: 's1', last_run_at: null });
      }),
    );
    respondWithRuns([createRun()]);

    await renderSection([createStage()], undefined, {
      queryClient: createQueryClient(5 * 60 * 1000),
      showsScheduler: true,
    });
    await expect.element(page.getByText('Completed', { exact: true })).toBeVisible();
    await wait(REFRESH_INTERVAL_MILLISECONDS * 4);

    expect(schedulerRequests).toBe(1);
  });

  test('keeps the stage runs and the open stage run on screen when a refresh of the run fails', async () => {
    const runningRun = createRun({ status: 'running', completed_at: null });
    const stageRun = createStageRun({ status: 'running', completed_at: null });
    let detailRequests = 0;
    let failing = false;
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs`, () => {
        return HttpResponse.json({ data: [runningRun], total: 1, offset: 0, limit: 20 });
      }),
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1`, () => {
        detailRequests += 1;
        if (failing) {
          return HttpResponse.json({ error: 'unavailable', error_description: 'Service unavailable' }, { status: 503 });
        }
        return HttpResponse.json({ ...runningRun, stage_runs: [stageRun] });
      }),
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1/stage-runs/stage-run-1`, () => {
        return HttpResponse.json({ ...stageRun, input: { url: 'https://example.com/news' }, output: null, logs: null });
      }),
    );

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();
    await page.getByRole('button', { name: /Headline Crawler/ }).click();
    await expect.element(page.getByText(/"url": "https:\/\/example.com\/news"/)).toBeVisible();

    failing = true;
    const requestsWhenFailing = detailRequests;
    await vi.waitFor(() => expect(detailRequests).toBeGreaterThanOrEqual(requestsWhenFailing + 3));

    expect(document.body.innerText).not.toContain('Failed to load stages');
    await expect.element(page.getByText('Headline Crawler')).toBeVisible();
    await expect.element(page.getByText(/"url": "https:\/\/example.com\/news"/)).toBeVisible();

    failing = false;
    const requestsWhenRecovering = detailRequests;
    await vi.waitFor(() => expect(detailRequests).toBeGreaterThanOrEqual(requestsWhenRecovering + 2));

    await expect.element(page.getByText(/"url": "https:\/\/example.com\/news"/)).toBeVisible();
  });

  test('says the stages cannot be loaded when the run was never read', async () => {
    const run = createRun();
    respondWithRuns([run]);
    worker.use(
      http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1`, () => {
        return HttpResponse.json({ error: 'unavailable', error_description: 'Service unavailable' }, { status: 503 });
      }),
    );

    await renderSection();
    await page.getByRole('button', { name: /Manual/ }).click();

    await expect.element(page.getByText('Failed to load stages: Service unavailable')).toBeVisible();
  });

  test('opens the run that the page asks to expand', async () => {
    const run = createRun();
    respondWithRuns([run]);
    respondWithRun(run, [createStageRun()]);

    await renderSection([createStage()], 'run-1');

    await expect.element(page.getByText('Headline Crawler')).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Manual/ })).toHaveAttribute('aria-expanded', 'true');
  });
});
