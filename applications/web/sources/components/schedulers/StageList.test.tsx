import type { ReactNode } from 'react';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import type { CrawlerRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { ToastProvider } from '../../contexts/ToastContext.tsx';
import type { TaskGroup } from '../../hooks/use-task-groups.ts';
import { StageList } from './StageList.tsx';

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

function createCrawlerStage(): SchedulerStageRow {
  return {
    id: 'stage-1',
    scheduler_id: 'scheduler-1',
    stage_type: 'crawler',
    crawler_id: CRAWLER_ID,
    task_group_id: null,
    task_group_version: null,
    settings: null,
    stage_order: 0,
    input_schema: { url: { type: 'string', default: 'https://example.com' } },
    output_schema: {},
    fan_out_field: 'items',
    fan_out_strategy: 'preserve',
    created_at: '2026-10-01T00:00:00.000Z',
  };
}

function createTaskGroupStage(): SchedulerStageRow {
  return {
    ...createCrawlerStage(),
    id: 'stage-2',
    stage_type: 'task_group',
    crawler_id: null,
    task_group_id: 'newscast',
    task_group_version: 1,
    settings: {},
    stage_order: 1,
    input_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
  };
}

function createTaskGroup(version: number): TaskGroup {
  return {
    id: 'newscast',
    version,
    input_schema: {},
    settings_schema: { type: 'object', properties: {} },
    output_schema: {},
    created_at: '2026-10-01T00:00:00.000Z',
  };
}

function startServer() {
  worker.use(
    http.get(`${CRAWLER_MANAGER_URL}/crawlers`, () => {
      return HttpResponse.json({ data: [createCrawler()], total: 1, offset: 0, limit: 20 });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/task-groups`, () => {
      return HttpResponse.json({ data: [createTaskGroup(1), createTaskGroup(2)] });
    }),
  );
}

function renderList(stages: SchedulerStageRow[], headerAction?: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <StageList
          schedulerID="scheduler-1"
          stages={stages}
          crawlerMap={new Map([[CRAWLER_ID, createCrawler()]])}
          headerAction={headerAction}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('StageList', () => {
  test('shows the action passed for the header next to Add Stage', async () => {
    startServer();
    await renderList([createCrawlerStage()], <button type="button">Run now</button>);

    await expect.element(page.getByRole('button', { name: 'Run now' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Add Stage' })).toBeVisible();
  });

  test('the edit button of a card opens the edit dialog filled with the stage', async () => {
    startServer();
    await renderList([createCrawlerStage()]);

    await page.getByTitle('Edit stage').click();

    await expect.element(page.getByRole('heading', { name: 'Edit Stage' })).toBeVisible();
    await expect.element(page.getByLabelText('Input Schema')).toHaveValue('https://example.com');
    await expect.element(page.getByLabelText('Fan-out Strategy')).toHaveValue('preserve');

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect.element(page.getByRole('heading', { name: 'Edit Stage' })).not.toBeInTheDocument();
  });

  test('a task group stage shows the newer version the server lists', async () => {
    startServer();
    await renderList([createCrawlerStage(), createTaskGroupStage()]);

    await expect.element(page.getByText('v2 available')).toBeVisible();
  });

  test('a form stage is named Form and its edit button opens the form definition', async () => {
    startServer();
    await renderList([
      {
        ...createCrawlerStage(),
        id: 'stage-3',
        stage_type: 'form',
        crawler_id: null,
        settings: { form: { type: 'object', properties: {} }, timeout_minutes: 30 },
        fan_out_field: null,
      },
    ]);

    await expect.element(page.getByText('Form', { exact: true })).toBeVisible();
    await page.getByTitle('Edit stage').click();

    await expect.element(page.getByRole('heading', { name: 'Edit Stage' })).toBeVisible();
    await expect.element(page.getByLabelText('Timeout (minutes)')).toHaveValue(30);
  });
});
