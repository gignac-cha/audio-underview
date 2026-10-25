import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import type { CrawlerRow } from '@audio-underview/supabase-connector';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { ToastProvider } from '../../contexts/ToastContext.tsx';
import type { TaskGroup } from '../../hooks/use-task-groups.ts';
import { StageCreateDialog } from './StageCreateDialog.tsx';

const SCHEDULER_MANAGER_URL = 'http://localhost:7777';
const CRAWLER_MANAGER_URL = 'http://localhost:8888';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const STAGES_URL = `${SCHEDULER_MANAGER_URL}/schedulers/scheduler-1/stages`;

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

function createTaskGroup(id: string, version: number, settingsSchema: Record<string, unknown>): TaskGroup {
  return {
    id,
    version,
    input_schema: {},
    settings_schema: settingsSchema,
    output_schema: {},
    created_at: '2026-10-01T00:00:00.000Z',
  };
}

const NEWSCAST_GROUPS: TaskGroup[] = [
  createTaskGroup('digest', 1, { type: 'object', properties: {} }),
  createTaskGroup('newscast', 1, { type: 'object', properties: { title: { type: 'string', title: 'Title' } } }),
  createTaskGroup('newscast', 2, {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string', title: 'Title' },
      voice: { enum: ['calm', 'bright'], default: 'calm' },
      length: { type: 'integer', description: 'Minutes of audio' },
    },
  }),
];

interface ServerState {
  createRequests: unknown[];
}

function startServer({
  taskGroups = NEWSCAST_GROUPS,
  taskGroupsStatus = 200,
  createStatus = 201,
}: { taskGroups?: TaskGroup[]; taskGroupsStatus?: number; createStatus?: number } = {}): ServerState {
  const state: ServerState = { createRequests: [] };
  worker.use(
    http.get(`${CRAWLER_MANAGER_URL}/crawlers`, () => {
      return HttpResponse.json({ data: [createCrawler()], total: 1, offset: 0, limit: 20 });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/task-groups`, () => {
      if (taskGroupsStatus !== 200) {
        return HttpResponse.json(
          { error: 'server_error', error_description: 'Task groups are unavailable' },
          { status: taskGroupsStatus },
        );
      }
      return HttpResponse.json({ data: taskGroups });
    }),
    http.post(STAGES_URL, async ({ request }) => {
      state.createRequests.push(await request.json());
      if (createStatus !== 201) {
        return HttpResponse.json(
          {
            error: 'invalid_request',
            error_description: "Field 'settings' does not match the task group settings format: $.title is required",
          },
          { status: createStatus },
        );
      }
      return HttpResponse.json({ id: 'stage-new' }, { status: 201 });
    }),
  );
  return state;
}

function renderDialog(onOpenChange: (open: boolean) => void = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <StageCreateDialog open onOpenChange={onOpenChange} schedulerID="scheduler-1" nextOrder={2} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function taskGroupOption() {
  return page.getByLabelText('Stage Type').getByRole('option', { name: 'Task group' });
}

async function chooseTaskGroup(taskGroupID: string) {
  await expect.element(taskGroupOption()).toBeEnabled();
  await page.getByLabelText('Stage Type').selectOptions('Task group');
  await page.getByLabelText('Task Group').selectOptions(taskGroupID);
}

beforeEach(() => {
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('StageCreateDialog stage type', () => {
  test('blocks Task group and says so when no task groups are registered', async () => {
    startServer({ taskGroups: [] });
    await renderDialog();

    await expect.element(page.getByText('No task groups are available yet.')).toBeVisible();
    await expect.element(taskGroupOption()).toBeDisabled();
  });

  test('still adds a crawler stage when the task groups cannot be loaded', async () => {
    const server = startServer({ taskGroupsStatus: 500 });
    await renderDialog();

    await expect.element(page.getByText('Failed to load task groups: Task groups are unavailable')).toBeVisible();
    await expect.element(taskGroupOption()).toBeDisabled();

    await page.getByLabelText('Crawler').selectOptions('Headline Crawler (web)');
    await page.getByLabelText('Input Schema').fill('https://example.com');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      {
        crawler_id: CRAWLER_ID,
        stage_order: 2,
        input_schema: { url: { type: 'string', default: 'https://example.com' } },
      },
    ]);
  });
});

describe('StageCreateDialog crawler stage', () => {
  test('sends the fan-out field without a strategy when none is chosen', async () => {
    const server = startServer();
    await renderDialog();

    await page.getByLabelText('Crawler').selectOptions('Headline Crawler (web)');
    await page.getByLabelText('Fan-out Field (optional)').fill('items');
    await expect.element(page.getByLabelText('Fan-out Strategy')).toHaveValue('compact');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      {
        crawler_id: CRAWLER_ID,
        stage_order: 2,
        input_schema: { url: { type: 'string', default: '' } },
        fan_out_field: 'items',
      },
    ]);
    expect(server.createRequests[0]).not.toHaveProperty('fan_out_strategy');
  });

  test('adds the chosen fan-out strategy', async () => {
    const server = startServer();
    await renderDialog();

    await page.getByLabelText('Crawler').selectOptions('Headline Crawler (web)');
    await page.getByLabelText('Fan-out Field (optional)').fill('items');
    await page.getByLabelText('Fan-out Strategy').selectOptions('Preserve');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      {
        crawler_id: CRAWLER_ID,
        stage_order: 2,
        input_schema: { url: { type: 'string', default: '' } },
        fan_out_field: 'items',
        fan_out_strategy: 'preserve',
      },
    ]);
  });

  test('offers a fan-out strategy only with a fan-out field', async () => {
    startServer();
    await renderDialog();

    await page.getByLabelText('Crawler').selectOptions('Headline Crawler (web)');

    await expect.element(page.getByLabelText('Fan-out Strategy')).not.toBeInTheDocument();
  });

  test('Edit JSON shows the URL typed in the simple mode', async () => {
    startServer();
    await renderDialog();

    await page.getByLabelText('Crawler').selectOptions('Headline Crawler (web)');
    await page.getByLabelText('Input Schema').fill('https://example.com');
    await page.getByRole('button', { name: 'Edit JSON' }).click();

    await expect.element(page.getByLabelText('Input Schema')).toHaveValue(
      JSON.stringify({ url: { type: 'string', default: 'https://example.com' } }, null, 2),
    );
  });

  test('Simple mode is refused while the JSON cannot be read', async () => {
    startServer();
    await renderDialog();

    await page.getByLabelText('Crawler').selectOptions('Headline Crawler (web)');
    await page.getByRole('button', { name: 'Edit JSON' }).click();
    await page.getByLabelText('Input Schema').fill('{"url": ');
    await page.getByRole('button', { name: 'Simple mode' }).click();

    await expect.element(page.getByText('Invalid JSON in input schema.')).toBeVisible();
    await expect.element(page.getByLabelText('Input Schema')).toHaveValue('{"url": ');
  });
});

describe('StageCreateDialog task group stage', () => {
  test('starts at the latest version and sends the task group stage', async () => {
    const server = startServer();
    await renderDialog();

    await chooseTaskGroup('newscast');

    await expect.element(page.getByLabelText('Version')).toHaveValue('2');
    await expect.element(page.getByLabelText('voice')).toHaveValue('"calm"');
    await expect.element(page.getByText('Minutes of audio')).toBeVisible();
    await expect.element(page.getByLabelText('Crawler')).not.toBeInTheDocument();

    await page.getByLabelText('Title (required)').fill('Morning');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      {
        stage_type: 'task_group',
        task_group_id: 'newscast',
        task_group_version: 2,
        settings: { title: 'Morning', voice: 'calm' },
        stage_order: 2,
      },
    ]);
  });

  test('a version change keeps the values of fields with the same name', async () => {
    const server = startServer();
    await renderDialog();

    await chooseTaskGroup('newscast');
    await page.getByLabelText('Title (required)').fill('Morning');
    await page.getByLabelText('Version').selectOptions('v1');

    await expect.element(page.getByLabelText('Title')).toHaveValue('Morning');
    await expect.element(page.getByLabelText('voice')).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      {
        stage_type: 'task_group',
        task_group_id: 'newscast',
        task_group_version: 1,
        settings: { title: 'Morning' },
        stage_order: 2,
      },
    ]);
  });

  test('Edit JSON writes the settings as JSON and Simple mode fills the fields again', async () => {
    const server = startServer();
    await renderDialog();

    await chooseTaskGroup('newscast');
    await page.getByLabelText('Title (required)').fill('Morning');
    await page.getByRole('button', { name: 'Edit JSON' }).click();

    const settingsJSON = page.getByLabelText('Settings');
    await expect.element(settingsJSON).toHaveValue(JSON.stringify({ title: 'Morning', voice: 'calm' }, null, 2));

    await settingsJSON.fill('["not", "an", "object"]');
    await page.getByRole('button', { name: 'Simple mode' }).click();
    await expect.element(page.getByText('Settings must be a JSON object.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Simple mode' })).toBeVisible();

    await settingsJSON.fill('{"title": "Evening", "voice": "bright", "length": 3}');
    await page.getByRole('button', { name: 'Simple mode' }).click();
    await expect.element(page.getByLabelText('Title (required)')).toHaveValue('Evening');
    await expect.element(page.getByLabelText('length')).toHaveValue('3');

    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      expect.objectContaining({ settings: { title: 'Evening', voice: 'bright', length: 3 } }),
    ]);
  });

  test('a key added in Edit JSON stays after Simple mode and is sent', async () => {
    const server = startServer();
    await renderDialog();

    await chooseTaskGroup('newscast');
    await page.getByRole('button', { name: 'Edit JSON' }).click();
    await page.getByLabelText('Settings').fill('{"title": "Morning", "voice": "bright", "added": 1}');
    await page.getByRole('button', { name: 'Simple mode' }).click();
    await expect.element(page.getByLabelText('Title (required)')).toHaveValue('Morning');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      expect.objectContaining({ settings: { title: 'Morning', voice: 'bright', added: 1 } }),
    ]);
  });

  test('emptying a field removes only its key', async () => {
    const server = startServer();
    await renderDialog();

    await chooseTaskGroup('newscast');
    await page.getByRole('button', { name: 'Edit JSON' }).click();
    await page.getByLabelText('Settings').fill('{"title": "Morning", "added": 1}');
    await page.getByRole('button', { name: 'Simple mode' }).click();
    await page.getByLabelText('Title (required)').fill('');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      expect.objectContaining({ settings: { added: 1 } }),
    ]);
  });

  test('a version change keeps a key added in Edit JSON', async () => {
    const server = startServer();
    await renderDialog();

    await chooseTaskGroup('newscast');
    await page.getByRole('button', { name: 'Edit JSON' }).click();
    await page.getByLabelText('Settings').fill('{"title": "Morning", "added": 1}');
    await page.getByRole('button', { name: 'Simple mode' }).click();
    await page.getByLabelText('Version').selectOptions('v1');
    await expect.element(page.getByLabelText('Title')).toHaveValue('Morning');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      {
        stage_type: 'task_group',
        task_group_id: 'newscast',
        task_group_version: 1,
        settings: { title: 'Morning', added: 1 },
        stage_order: 2,
      },
    ]);
  });

  describe('through versions that list the same fields', () => {
    const withDefaultsSchema = {
      type: 'object',
      properties: {
        title: { type: 'string', title: 'Title' },
        intro: { type: 'string', default: 'Hello' },
        loud: { type: 'boolean', default: true },
        voice: { enum: ['calm', 'bright'], default: 'calm' },
      },
    };
    const threeVersions = [
      NEWSCAST_GROUPS[1],
      createTaskGroup('newscast', 2, withDefaultsSchema),
      createTaskGroup('newscast', 3, withDefaultsSchema),
    ];

    test('the defaults stay and are sent', async () => {
      const server = startServer({ taskGroups: threeVersions });
      await renderDialog();

      await chooseTaskGroup('newscast');
      await page.getByLabelText('Title').fill('Morning');
      await page.getByLabelText('Version').selectOptions('v2');

      await expect.element(page.getByLabelText('intro')).toHaveValue('Hello');
      await expect.element(page.getByLabelText('loud')).toBeChecked();
      await expect.element(page.getByLabelText('voice')).toHaveValue('"calm"');
      await page.getByRole('button', { name: 'Add Stage' }).click();

      await expect.poll(() => server.createRequests).toEqual([
        expect.objectContaining({
          task_group_version: 2,
          settings: { title: 'Morning', intro: 'Hello', loud: true, voice: 'calm' },
        }),
      ]);
    });

    test('defaults left as they were do not follow to a version without them', async () => {
      const server = startServer({ taskGroups: threeVersions });
      await renderDialog();

      await chooseTaskGroup('newscast');
      await page.getByLabelText('Title').fill('Morning');
      await page.getByLabelText('Version').selectOptions('v2');
      await expect.element(page.getByLabelText('intro')).toHaveValue('Hello');
      await page.getByLabelText('Version').selectOptions('v1');
      await expect.element(page.getByLabelText('intro')).not.toBeInTheDocument();
      await page.getByRole('button', { name: 'Add Stage' }).click();

      await expect.poll(() => server.createRequests).toEqual([
        expect.objectContaining({ task_group_version: 1, settings: { title: 'Morning' } }),
      ]);
    });
  });

  test('does not send a number field that is not a number', async () => {
    const server = startServer();
    await renderDialog();

    await chooseTaskGroup('newscast');
    await page.getByLabelText('length').fill('three');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.element(page.getByText("Setting 'length' must be a number.")).toBeVisible();
    expect(server.createRequests).toEqual([]);
  });

  test('shows the reason the server gives for refusing the settings', async () => {
    startServer({ createStatus: 400 });
    await renderDialog();

    await chooseTaskGroup('newscast');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.element(
      page.getByText("Field 'settings' does not match the task group settings format: $.title is required"),
    ).toBeVisible();
  });

  test('a version without settings fields says so', async () => {
    startServer();
    await renderDialog();

    await chooseTaskGroup('digest');

    await expect.element(page.getByText('This version has no settings.')).toBeVisible();
  });
});

describe('StageCreateDialog form stage', () => {
  async function chooseForm() {
    await page.getByLabelText('Stage Type').selectOptions('Form');
  }

  const FORM_DEFINITION = {
    type: 'object',
    required: ['topic'],
    properties: { topic: { type: 'string', title: 'Topic', 'x-widget': 'text' } },
  };

  test('is offered even when no task groups are registered, without crawler or task group fields', async () => {
    startServer({ taskGroups: [] });
    await renderDialog();

    await chooseForm();

    await expect.element(page.getByLabelText('Form Definition')).toBeVisible();
    await expect.element(page.getByLabelText('Timeout (minutes)')).toHaveValue(1440);
    await expect.element(page.getByLabelText('Crawler')).not.toBeInTheDocument();
    await expect.element(page.getByLabelText('Task Group')).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Add Stage' })).toBeEnabled();
  });

  test('starts from an example form definition that uses the widgets', async () => {
    startServer();
    await renderDialog();

    await chooseForm();

    const definition = JSON.parse((page.getByLabelText('Form Definition').element() as HTMLTextAreaElement).value);
    expect(definition.type).toBe('object');
    expect(definition.required).toEqual(['topic']);
    expect(Object.values(definition.properties).map((property) => (property as Record<string, unknown>)['x-widget']))
      .toEqual(['text', 'radio', 'textarea']);
    // The database does not keep the order of the keys, so the example sets the order of its fields
    expect(Object.values(definition.properties).map((property) => (property as Record<string, unknown>)['x-order']))
      .toEqual([0, 1, 2]);
  });

  test('sends the example as it is with the default timeout', async () => {
    const server = startServer();
    await renderDialog();

    await chooseForm();
    const definition = JSON.parse((page.getByLabelText('Form Definition').element() as HTMLTextAreaElement).value);
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      { stage_type: 'form', settings: { form: definition, timeout_minutes: 1440 }, stage_order: 2 },
    ]);
    await expect.element(page.getByText('Stage added to pipeline.')).toBeVisible();
  });

  test('sends the form definition and the timeout that were written', async () => {
    const server = startServer();
    await renderDialog();

    await chooseForm();
    await page.getByLabelText('Form Definition').fill(JSON.stringify(FORM_DEFINITION));
    await page.getByLabelText('Timeout (minutes)').fill('30');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      { stage_type: 'form', settings: { form: FORM_DEFINITION, timeout_minutes: 30 }, stage_order: 2 },
    ]);
  });

  test('leaves the timeout to the server when it is empty', async () => {
    const server = startServer();
    await renderDialog();

    await chooseForm();
    await page.getByLabelText('Form Definition').fill(JSON.stringify(FORM_DEFINITION));
    await page.getByLabelText('Timeout (minutes)').fill('');
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.poll(() => server.createRequests).toEqual([
      { stage_type: 'form', settings: { form: FORM_DEFINITION }, stage_order: 2 },
    ]);
  });

  test.each([
    ['JSON that cannot be read', '{"type": ', '30', 'Invalid JSON in form definition.'],
    ['JSON that is not an object', '["not", "an", "object"]', '30', 'Form definition must be a JSON object.'],
    ['a timeout of zero', '{}', '0', 'Timeout must be a whole number of minutes from 1 to 525600.'],
    ['a timeout past a year', '{}', '525601', 'Timeout must be a whole number of minutes from 1 to 525600.'],
    ['a timeout that is not whole', '{}', '1.5', 'Timeout must be a whole number of minutes from 1 to 525600.'],
  ])('does not send %s', async (_name, definition, timeout, message) => {
    const server = startServer();
    await renderDialog();

    await chooseForm();
    await page.getByLabelText('Form Definition').fill(definition);
    await page.getByLabelText('Timeout (minutes)').fill(timeout);
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.element(page.getByText(message)).toBeVisible();
    expect(server.createRequests).toEqual([]);
  });

  test('shows the reason the server gives for refusing the form definition', async () => {
    startServer({ createStatus: 400 });
    await renderDialog();

    await chooseForm();
    await page.getByRole('button', { name: 'Add Stage' }).click();

    await expect.element(
      page.getByText("Field 'settings' does not match the task group settings format: $.title is required"),
    ).toBeVisible();
  });
});
