import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import type { CrawlerRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { ToastProvider } from '../../contexts/ToastContext.tsx';
import type { TaskGroup } from '../../hooks/use-task-groups.ts';
import { StageEditDialog } from './StageEditDialog.tsx';

const SCHEDULER_MANAGER_URL = 'http://localhost:7777';
const CRAWLER_MANAGER_URL = 'http://localhost:8888';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const OTHER_CRAWLER_ID = '00000000-0000-0000-0000-000000000031';

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

function createCrawler(overrides: Partial<CrawlerRow> = {}): CrawlerRow {
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
    ...overrides,
  };
}

const CRAWLERS = [
  createCrawler(),
  createCrawler({ id: OTHER_CRAWLER_ID, name: 'Detail Crawler', type: 'data', input_schema: { id: { type: 'string' } } }),
];

function createCrawlerStage(overrides: Partial<SchedulerStageRow> = {}): SchedulerStageRow {
  return {
    id: 'stage-1',
    scheduler_id: 'scheduler-1',
    stage_type: 'crawler',
    crawler_id: CRAWLER_ID,
    task_group_id: null,
    task_group_version: null,
    settings: null,
    stage_order: 0,
    // The database does not keep the order of keys
    input_schema: { url: { default: 'https://old.example', type: 'string' } },
    output_schema: {},
    fan_out_field: 'items',
    fan_out_strategy: 'compact',
    created_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function createTaskGroupStage(settings: Record<string, unknown>): SchedulerStageRow {
  return createCrawlerStage({
    id: 'stage-2',
    stage_type: 'task_group',
    crawler_id: null,
    task_group_id: 'newscast',
    task_group_version: 1,
    settings,
    stage_order: 1,
    input_schema: {},
    fan_out_field: null,
  });
}

function createTaskGroup(version: number, settingsSchema: Record<string, unknown>): TaskGroup {
  return {
    id: 'newscast',
    version,
    input_schema: {},
    settings_schema: settingsSchema,
    output_schema: {},
    created_at: '2026-10-01T00:00:00.000Z',
  };
}

const TASK_GROUPS: TaskGroup[] = [
  createTaskGroup(1, {
    type: 'object',
    properties: {
      title: { type: 'string', title: 'Title' },
      length: { type: 'integer' },
      music: { type: 'boolean' },
    },
  }),
  createTaskGroup(2, {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string', title: 'Title' },
      length: { type: 'integer' },
      voice: { enum: ['calm', 'bright'], default: 'calm' },
    },
  }),
];

interface ServerState {
  updateRequests: unknown[];
}

function startServer({ updateStatus = 200 }: { updateStatus?: number } = {}): ServerState {
  const state: ServerState = { updateRequests: [] };
  worker.use(
    http.get(`${CRAWLER_MANAGER_URL}/crawlers`, () => {
      return HttpResponse.json({ data: CRAWLERS, total: CRAWLERS.length, offset: 0, limit: 20 });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/task-groups`, () => {
      return HttpResponse.json({ data: TASK_GROUPS });
    }),
    http.put(`${SCHEDULER_MANAGER_URL}/schedulers/scheduler-1/stages/:stageID`, async ({ request }) => {
      state.updateRequests.push(await request.json());
      if (updateStatus !== 200) {
        return HttpResponse.json(
          { error: 'invalid_request', error_description: "Task group 'newscast' version 2 is not registered" },
          { status: updateStatus },
        );
      }
      return HttpResponse.json({ id: 'stage-1' });
    }),
  );
  return state;
}

function renderDialog(stage: SchedulerStageRow, onOpenChange: (open: boolean) => void = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const crawlerMap = new Map(CRAWLERS.map((crawler) => [crawler.id, crawler]));

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <StageEditDialog schedulerID="scheduler-1" stage={stage} crawlerMap={crawlerMap} onOpenChange={onOpenChange} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function saveButton() {
  return page.getByRole('button', { name: 'Save' });
}

beforeEach(() => {
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('StageEditDialog crawler stage', () => {
  test('opens with what the stage holds and no task group fields', async () => {
    startServer();
    await renderDialog(createCrawlerStage());

    await expect.element(page.getByLabelText('Crawler')).toHaveValue(CRAWLER_ID);
    await expect.element(page.getByLabelText('Input Schema')).toHaveValue('https://old.example');
    await expect.element(page.getByLabelText('Fan-out Field (optional)')).toHaveValue('items');
    await expect.element(page.getByLabelText('Fan-out Strategy')).toHaveValue('compact');
    await expect.element(page.getByLabelText('Version')).not.toBeInTheDocument();
    await expect.element(page.getByText('Settings', { exact: true })).not.toBeInTheDocument();
  });

  test('sends only the field that changed', async () => {
    const server = startServer();
    await renderDialog(createCrawlerStage());

    await page.getByLabelText('Input Schema').fill('https://new.example');
    await saveButton().click();

    await expect.poll(() => server.updateRequests).toEqual([
      { input_schema: { url: { type: 'string', default: 'https://new.example' } } },
    ]);
    await expect.element(page.getByText('Stage updated.')).toBeVisible();
  });

  test('sends fan_out_field null when the fan-out field is cleared', async () => {
    const server = startServer();
    await renderDialog(createCrawlerStage());

    await page.getByLabelText('Fan-out Field (optional)').fill('');
    await expect.element(page.getByLabelText('Fan-out Strategy')).not.toBeInTheDocument();
    await saveButton().click();

    await expect.poll(() => server.updateRequests).toEqual([{ fan_out_field: null }]);
  });

  test('sends a changed fan-out strategy alone', async () => {
    const server = startServer();
    await renderDialog(createCrawlerStage());

    await page.getByLabelText('Fan-out Strategy').selectOptions('Preserve');
    await saveButton().click();

    await expect.poll(() => server.updateRequests).toEqual([{ fan_out_strategy: 'preserve' }]);
  });

  test('a new crawler sends the crawler and its input schema', async () => {
    const server = startServer();
    await renderDialog(createCrawlerStage({ fan_out_field: null }));

    await page.getByLabelText('Crawler').selectOptions('Detail Crawler (data)');
    await saveButton().click();

    await expect.poll(() => server.updateRequests).toEqual([
      { crawler_id: OTHER_CRAWLER_ID, input_schema: { id: { type: 'string' } } },
    ]);
  });

  test('closes without a request when nothing changed', async () => {
    const server = startServer();
    const onOpenChange = vi.fn();
    await renderDialog(createCrawlerStage(), onOpenChange);

    await expect.element(page.getByLabelText('Input Schema')).toHaveValue('https://old.example');
    await saveButton().click();

    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
    expect(server.updateRequests).toEqual([]);
  });

  test('a schema the simple mode cannot show opens as JSON', async () => {
    startServer();
    const inputSchema = { url: { type: 'string', default: 'https://old.example' }, page: { type: 'number' } };
    await renderDialog(createCrawlerStage({ input_schema: inputSchema }));

    await expect.element(page.getByRole('button', { name: 'Simple mode' })).toBeVisible();
    await expect.element(page.getByLabelText('Input Schema')).toHaveValue(JSON.stringify(inputSchema, null, 2));
  });

  test('Simple mode is refused for a schema it cannot show, which stays as stored', async () => {
    const server = startServer();
    const onOpenChange = vi.fn();
    const inputSchema = { url: { type: 'string', default: 'https://old.example' }, page: { type: 'number' } };
    await renderDialog(createCrawlerStage({ input_schema: inputSchema }), onOpenChange);

    await page.getByRole('button', { name: 'Simple mode' }).click();

    await expect.element(page.getByText('Simple mode shows only a URL, so it cannot show this input schema.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Simple mode' })).toBeVisible();
    await expect.element(page.getByLabelText('Input Schema')).toHaveValue(JSON.stringify(inputSchema, null, 2));

    await saveButton().click();

    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
    expect(server.updateRequests).toEqual([]);
  });

  test('Simple mode shows the URL written in the JSON', async () => {
    const server = startServer();
    await renderDialog(createCrawlerStage());

    await page.getByRole('button', { name: 'Edit JSON' }).click();
    await page.getByLabelText('Input Schema').fill(JSON.stringify({ url: { type: 'string', default: 'https://edited.example' } }));
    await page.getByRole('button', { name: 'Simple mode' }).click();

    await expect.element(page.getByLabelText('Input Schema')).toHaveValue('https://edited.example');

    await saveButton().click();

    await expect.poll(() => server.updateRequests).toEqual([
      { input_schema: { url: { type: 'string', default: 'https://edited.example' } } },
    ]);
  });
});

describe('StageEditDialog task group stage', () => {
  test('opens with the settings in the fields of its version and no crawler fields', async () => {
    startServer();
    await renderDialog(createTaskGroupStage({ title: 'Morning', length: 5 }));

    await expect.element(page.getByLabelText('Version')).toHaveValue('1');
    await expect.element(page.getByLabelText('Title')).toHaveValue('Morning');
    await expect.element(page.getByLabelText('length')).toHaveValue('5');
    await expect.element(page.getByLabelText('Crawler')).not.toBeInTheDocument();
    await expect.element(page.getByLabelText('Input Schema')).not.toBeInTheDocument();
    await expect.element(page.getByLabelText('Fan-out Field (optional)')).not.toBeInTheDocument();
  });

  test('a new version shows its fields, keeps the values of the same names and sends both', async () => {
    const server = startServer();
    await renderDialog(createTaskGroupStage({ title: 'Morning', length: 5, music: true }));

    await page.getByLabelText('Version').selectOptions('v2');

    await expect.element(page.getByLabelText('Title (required)')).toHaveValue('Morning');
    await expect.element(page.getByLabelText('length')).toHaveValue('5');
    await expect.element(page.getByLabelText('voice')).toHaveValue('"calm"');
    await expect.element(page.getByLabelText('music')).not.toBeInTheDocument();

    await saveButton().click();

    await expect.poll(() => server.updateRequests).toEqual([
      { task_group_version: 2, settings: { title: 'Morning', length: 5, voice: 'calm' } },
    ]);
  });

  test('switching to another version and back keeps every value and sends nothing', async () => {
    const server = startServer();
    const onOpenChange = vi.fn();
    await renderDialog(createTaskGroupStage({ title: 'Morning', music: true }), onOpenChange);

    await page.getByLabelText('Version').selectOptions('v2');
    await expect.element(page.getByLabelText('music')).not.toBeInTheDocument();
    await page.getByLabelText('Version').selectOptions('v1');

    await expect.element(page.getByLabelText('Title')).toHaveValue('Morning');
    await expect.element(page.getByLabelText('music')).toBeChecked();

    await saveButton().click();

    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
    expect(server.updateRequests).toEqual([]);
  });

  test('sends changed settings alone', async () => {
    const server = startServer();
    await renderDialog(createTaskGroupStage({ title: 'Morning', length: 5 }));

    await page.getByLabelText('Title').fill('Evening');
    await saveButton().click();

    await expect.poll(() => server.updateRequests).toEqual([
      { settings: { title: 'Evening', length: 5, music: false } },
    ]);
  });

  test('closes without a request when nothing changed, even with a checkbox the settings leave out', async () => {
    const server = startServer();
    const onOpenChange = vi.fn();
    await renderDialog(createTaskGroupStage({ length: 5, title: 'Morning' }), onOpenChange);

    await expect.element(page.getByLabelText('Title')).toHaveValue('Morning');
    await saveButton().click();

    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
    expect(server.updateRequests).toEqual([]);
  });

  test('shows the reason the server gives and stays open', async () => {
    startServer({ updateStatus: 400 });
    const onOpenChange = vi.fn();
    await renderDialog(createTaskGroupStage({ title: 'Morning' }), onOpenChange);

    await page.getByLabelText('Version').selectOptions('v2');
    await saveButton().click();

    await expect.element(page.getByText("Task group 'newscast' version 2 is not registered")).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
