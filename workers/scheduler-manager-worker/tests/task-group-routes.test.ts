import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { signJWT } from '@audio-underview/worker-tools';
import worker from '../sources/index.ts';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const WORKER_URL = 'https://worker.example.com';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const CRAWLER_STAGE_ID = '00000000-0000-0000-0000-000000000020';
const TASK_GROUP_STAGE_ID = '00000000-0000-0000-0000-000000000022';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const OTHER_RUN_ID = '00000000-0000-0000-0000-000000000041';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

async function authenticatedRequest(path: string, options: RequestInit = {}): Promise<Request> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ sub: USER_UUID, iat: now, exp: now + 86400 }, JWT_SECRET);
  const headers = new Headers(options.headers);
  headers.set('Origin', 'https://example.com');
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  return new Request(`${WORKER_URL}${path}`, { ...options, headers });
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const request = await authenticatedRequest(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(request, env);
}

function taskGroupRow(overrides: Row = {}): Row {
  return {
    id: 'newscast',
    version: 1,
    input_schema: {},
    settings_schema: {
      type: 'object',
      properties: { voice: { type: 'string' } },
      required: ['voice'],
      additionalProperties: false,
    },
    output_schema: {},
    worker_binding: 'NEWSCAST',
    created_at: '2026-10-04T00:00:00Z',
    ...overrides,
  };
}

function crawlerStageRow(overrides: Row = {}): Row {
  return {
    id: CRAWLER_STAGE_ID,
    scheduler_id: SCHEDULER_ID,
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
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function taskGroupStageRow(overrides: Row = {}): Row {
  return crawlerStageRow({
    id: TASK_GROUP_STAGE_ID,
    stage_type: 'task_group',
    crawler_id: null,
    task_group_id: 'newscast',
    task_group_version: 1,
    settings: { voice: 'calm' },
    stage_order: 1,
    ...overrides,
  });
}

function seed(tables: Record<string, Row[]> = {}) {
  supabase.tables.schedulers = [{
    id: SCHEDULER_ID,
    user_uuid: USER_UUID,
    name: 'Test Scheduler',
    cron_expression: null,
    timezone: 'Asia/Seoul',
    is_enabled: true,
    last_run_at: null,
    next_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }];
  supabase.tables.crawler_permissions = [{
    id: '00000000-0000-0000-0000-000000000099',
    crawler_id: CRAWLER_ID,
    user_uuid: USER_UUID,
    level: 'owner',
    created_at: '2026-01-01T00:00:00Z',
  }];
  supabase.tables.task_groups = [taskGroupRow()];
  supabase.tables.scheduler_stages = [];
  for (const [table, rows] of Object.entries(tables)) {
    supabase.tables[table] = rows;
  }
}

async function expectError(response: Response, status: number, error: string, description: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error, error_description: description });
}

function runRow(overrides: Row = {}): Row {
  return {
    id: RUN_ID,
    scheduler_id: SCHEDULER_ID,
    status: 'running',
    started_at: '2026-10-05T22:00:00.000Z',
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-05T22:00:00.000Z',
    ...overrides,
  };
}

function stageRunRow(overrides: Row = {}): Row {
  return {
    id: '00000000-0000-0000-0000-000000000051',
    run_id: RUN_ID,
    stage_id: CRAWLER_STAGE_ID,
    stage_order: 0,
    status: 'completed',
    started_at: '2026-10-05T22:00:00.000Z',
    completed_at: '2026-10-05T22:01:00.000Z',
    input: { url: 'https://example.com' },
    output: { title: 'Example' },
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    task_group_id: null,
    task_group_version: null,
    progress: null,
    created_at: '2026-10-05T22:00:00.000Z',
    ...overrides,
  };
}

// The answer of the database to a write of a stage that points at something that does not exist (or no longer does)
function failStageWrite(method: 'POST' | 'PATCH', message: string) {
  supabase.intercept = (request) => (
    request.method === method && request.table === 'scheduler_stages'
      ? { statusCode: 409, data: { code: '23503', details: null, hint: null, message } }
      : undefined
  );
}

const TASK_GROUP_FOREIGN_KEY_MESSAGE = 'insert or update on table "scheduler_stages" violates foreign key constraint "scheduler_stages_task_group_fkey"';
const CRAWLER_FOREIGN_KEY_MESSAGE = 'insert or update on table "scheduler_stages" violates foreign key constraint "scheduler_stages_crawler_id_fkey"';

describe('GET /task-groups', () => {
  it('returns 401 without authentication', async () => {
    const response = await worker.fetch(new Request(`${WORKER_URL}/task-groups`, { headers: { Origin: 'https://example.com' } }), env);

    expect(response.status).toBe(401);
  });

  it('returns an empty list when no task group is registered', async () => {
    seed({ task_groups: [] });

    const response = await send('GET', '/task-groups');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
  });

  it('lists every registered version by id and version, without the worker binding', async () => {
    seed({
      task_groups: [
        taskGroupRow({ id: 'newscast', version: 2 }),
        taskGroupRow({ id: 'digest', version: 1, worker_binding: 'DIGEST' }),
        taskGroupRow({ id: 'newscast', version: 1 }),
      ],
    });

    const response = await send('GET', '/task-groups');

    expect(response.status).toBe(200);
    const body = await response.json() as { data: Row[] };
    expect(body.data.map((taskGroup) => [taskGroup.id, taskGroup.version])).toEqual([
      ['digest', 1],
      ['newscast', 1],
      ['newscast', 2],
    ]);
    expect(body.data[0]).toEqual({
      id: 'digest',
      version: 1,
      input_schema: {},
      settings_schema: taskGroupRow().settings_schema,
      output_schema: {},
      created_at: '2026-10-04T00:00:00Z',
    });
    expect(JSON.stringify(body)).not.toContain('worker_binding');
    expect(supabase.requestsOf('GET', 'task_groups')[0].query.get('order')).toBe('id.asc,version.asc');
  });

  it('returns 405 for POST', async () => {
    const response = await send('POST', '/task-groups', {});

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it.each(['PUT', 'DELETE'])('returns 405 with Allow: GET for %s as well, without reading anything', async (method) => {
    const response = await send(method, '/task-groups', method === 'PUT' ? {} : undefined);

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(supabase.requests).toEqual([]);
  });

  it.each(['/task-groups/newscast', '/task-groups/'])('returns 404 for the path %s below /task-groups', async (path) => {
    seed();

    const response = await send('GET', path);

    expect(response.status).toBe(404);
    expect(supabase.requests).toEqual([]);
  });

  it('is listed in the help', async () => {
    const response = await worker.fetch(new Request(WORKER_URL, { headers: { Origin: 'https://example.com' } }), env);

    const body = await response.json() as { endpoints: { method: string; path: string }[] };
    expect(body.endpoints).toContainEqual(expect.objectContaining({ method: 'GET', path: '/task-groups' }));
  });
});

describe('POST /schedulers/:id/stages with stage types', () => {
  const path = `/schedulers/${SCHEDULER_ID}/stages`;
  const validTaskGroupStage = {
    stage_type: 'task_group',
    task_group_id: 'newscast',
    task_group_version: 1,
    settings: { voice: 'calm' },
    stage_order: 1,
  };

  it('stores a task group stage with its group, version and settings', async () => {
    seed();

    const response = await send('POST', path, validTaskGroupStage);

    expect(response.status).toBe(201);
    const inserts = supabase.requestsOf('POST', 'scheduler_stages');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].body).toEqual({
      scheduler_id: SCHEDULER_ID,
      stage_type: 'task_group',
      crawler_id: null,
      task_group_id: 'newscast',
      task_group_version: 1,
      settings: { voice: 'calm' },
      stage_order: 1,
      input_schema: {},
    });
    expect(await response.json()).toMatchObject({ stage_type: 'task_group', task_group_id: 'newscast', settings: { voice: 'calm' } });
    expect(supabase.requestsOf('GET', 'crawler_permissions')).toHaveLength(0);
  });

  it.each([undefined, 'crawler'])('sends the same request as before for a crawler stage (stage_type %s)', async (stageType) => {
    seed();

    const response = await send('POST', path, {
      ...(stageType === undefined ? {} : { stage_type: stageType }),
      crawler_id: CRAWLER_ID,
      stage_order: 0,
      input_schema: { url: { type: 'string' } },
    });

    expect(response.status).toBe(201);
    expect(supabase.requestsOf('POST', 'scheduler_stages')[0].body).toEqual({
      scheduler_id: SCHEDULER_ID,
      crawler_id: CRAWLER_ID,
      stage_order: 0,
      input_schema: { url: { type: 'string' } },
    });
  });

  it.each([
    ['stage_type is neither crawler nor task_group', { stage_type: 'other' }, "Field 'stage_type' must be 'crawler' or 'task_group'"],
    ['a crawler stage has task_group_id', { crawler_id: CRAWLER_ID, task_group_id: 'newscast' }, "Field 'task_group_id' is not allowed on a crawler stage"],
    ['a crawler stage has task_group_version', { stage_type: 'crawler', task_group_version: 1 }, "Field 'task_group_version' is not allowed on a crawler stage"],
    ['a crawler stage has settings, before crawler_id is checked', { settings: {} }, "Field 'settings' is not allowed on a crawler stage"],
    ['a task group stage has crawler_id', { ...validTaskGroupStage, crawler_id: CRAWLER_ID, fan_out_field: 'items' }, "Field 'crawler_id' is not allowed on a task group stage"],
    ['a task group stage has input_schema', { ...validTaskGroupStage, input_schema: {} }, "Field 'input_schema' is not allowed on a task group stage"],
    ['a task group stage has output_schema', { ...validTaskGroupStage, output_schema: {} }, "Field 'output_schema' is not allowed on a task group stage"],
    ['a task group stage has fan_out_field', { ...validTaskGroupStage, fan_out_field: 'items' }, "Field 'fan_out_field' is not allowed on a task group stage"],
    ['a task group stage has fan_out_strategy', { ...validTaskGroupStage, fan_out_strategy: 'compact' }, "Field 'fan_out_strategy' is not allowed on a task group stage"],
    ['task_group_id is missing', { ...validTaskGroupStage, task_group_id: undefined }, "Field 'task_group_id' is required and must be a task group ID"],
    ['task_group_id has upper case letters', { ...validTaskGroupStage, task_group_id: 'News' }, "Field 'task_group_id' is required and must be a task group ID"],
    ['task_group_id ends with a hyphen', { ...validTaskGroupStage, task_group_id: 'a-' }, "Field 'task_group_id' is required and must be a task group ID"],
    ['task_group_id is longer than 63 characters', { ...validTaskGroupStage, task_group_id: 'a'.repeat(64) }, "Field 'task_group_id' is required and must be a task group ID"],
    ['task_group_version is missing', { ...validTaskGroupStage, task_group_version: undefined }, "Field 'task_group_version' is required and must be a positive integer"],
    ['task_group_version is 0', { ...validTaskGroupStage, task_group_version: 0 }, "Field 'task_group_version' is required and must be a positive integer"],
    ['task_group_version is a string', { ...validTaskGroupStage, task_group_version: '1' }, "Field 'task_group_version' is required and must be a positive integer"],
    ['stage_order is negative', { ...validTaskGroupStage, stage_order: -1 }, "Field 'stage_order' is required and must be a non-negative integer"],
    ['settings is missing', { ...validTaskGroupStage, settings: undefined }, "Field 'settings' is required and must be a JSON object"],
    ['settings is an array', { ...validTaskGroupStage, settings: [] }, "Field 'settings' is required and must be a JSON object"],
    ['settings is null', { ...validTaskGroupStage, settings: null }, "Field 'settings' is required and must be a JSON object"],
    ['the version is not registered', { ...validTaskGroupStage, task_group_version: 2 }, "Task group 'newscast' version 2 is not registered"],
    ['the group is not registered', { ...validTaskGroupStage, task_group_id: 'digest' }, "Task group 'digest' version 1 is not registered"],
    ['the version is beyond any registered one', { ...validTaskGroupStage, task_group_version: 2 ** 40 }, `Task group 'newscast' version ${2 ** 40} is not registered`],
    ['the settings do not match the settings format', { ...validTaskGroupStage, settings: { voice: 3 } }, "Field 'settings' does not match the task group settings format: $.voice must be of type string"],
    ['the settings have a field the format does not allow', { ...validTaskGroupStage, settings: { voice: 'calm', speed: 2 } }, "Field 'settings' does not match the task group settings format: $.speed is not allowed"],
  ])('returns 400 when %s', async (_, body, description) => {
    seed();

    const response = await send('POST', path, body);

    await expectError(response, 400, 'invalid_request', description);
    expect(supabase.requestsOf('POST', 'scheduler_stages')).toHaveLength(0);
  });

  it('returns 500 when the settings format cannot be read', async () => {
    seed({ task_groups: [taskGroupRow({ settings_schema: { type: 'object', patternProperties: {} } })] });

    const response = await send('POST', path, validTaskGroupStage);

    await expectError(response, 500, 'server_error', 'Task group format cannot be read');
    expect(supabase.requestsOf('POST', 'scheduler_stages')).toHaveLength(0);
  });

  it('returns 409 when a stage with the order exists', async () => {
    seed();
    supabase.intercept = (request) => (
      request.method === 'POST' && request.table === 'scheduler_stages'
        ? { statusCode: 409, data: { code: '23505', details: null, hint: null, message: 'duplicate key value violates unique constraint "scheduler_stages_scheduler_id_stage_order_key"' } }
        : undefined
    );

    const response = await send('POST', path, validTaskGroupStage);

    await expectError(response, 409, 'conflict', 'A stage with this order already exists');
  });

  it('returns 400 naming the version when the database rejects the stage because the version was removed after the check', async () => {
    seed();
    failStageWrite('POST', TASK_GROUP_FOREIGN_KEY_MESSAGE);

    const response = await send('POST', path, validTaskGroupStage);

    await expectError(response, 400, 'invalid_request', "Task group 'newscast' version 1 is not registered");
    // The registry was read and the version was there, then the database rejected the write
    expect(supabase.requestsOf('GET', 'task_groups')).toHaveLength(1);
    expect(supabase.requestsOf('POST', 'scheduler_stages')).toHaveLength(1);
  });

  it('keeps the wording for a crawler that does not exist on a crawler stage', async () => {
    seed();
    failStageWrite('POST', CRAWLER_FOREIGN_KEY_MESSAGE);

    const response = await send('POST', path, { crawler_id: CRAWLER_ID, stage_order: 0, input_schema: {} });

    await expectError(response, 400, 'invalid_request', 'Referenced crawler does not exist');
  });

  describe('with several invalid fields at once', () => {
    const everythingInvalid = {
      stage_type: 'task_group',
      task_group_id: 'News',
      task_group_version: 0,
      stage_order: -1,
      settings: [],
    };
    const crawlerFields: [string, unknown][] = [
      ['crawler_id', CRAWLER_ID],
      ['input_schema', {}],
      ['output_schema', {}],
      ['fan_out_field', 'items'],
      ['fan_out_strategy', 'compact'],
    ];

    function expectNothingLookedUp() {
      expect(supabase.requestsOf('GET', 'task_groups')).toHaveLength(0);
      expect(supabase.requestsOf('GET', 'crawler_permissions')).toHaveLength(0);
      expect(supabase.requestsOf('POST', 'scheduler_stages')).toHaveLength(0);
    }

    it('names stage_type before anything else that is wrong', async () => {
      seed();

      const response = await send('POST', path, { ...everythingInvalid, stage_type: 'other', crawler_id: CRAWLER_ID });

      await expectError(response, 400, 'invalid_request', "Field 'stage_type' must be 'crawler' or 'task_group'");
      expectNothingLookedUp();
    });

    it.each(crawlerFields.map(([field], index) => [field, Object.fromEntries(crawlerFields.slice(index))] as const))(
      "names '%s', the first crawler field present in the order of the list, before the fields of the task group",
      async (field, presentCrawlerFields) => {
        seed();

        const response = await send('POST', path, { ...everythingInvalid, ...presentCrawlerFields });

        await expectError(response, 400, 'invalid_request', `Field '${field}' is not allowed on a task group stage`);
        expectNothingLookedUp();
      },
    );

    it.each([
      ['task_group_id', everythingInvalid, "Field 'task_group_id' is required and must be a task group ID"],
      [
        'task_group_version',
        { ...everythingInvalid, task_group_id: 'newscast' },
        "Field 'task_group_version' is required and must be a positive integer",
      ],
      [
        'stage_order',
        { ...everythingInvalid, task_group_id: 'newscast', task_group_version: 1 },
        "Field 'stage_order' is required and must be a non-negative integer",
      ],
      [
        'settings',
        { ...everythingInvalid, task_group_id: 'newscast', task_group_version: 1, stage_order: 1 },
        "Field 'settings' is required and must be a JSON object",
      ],
    ])("names '%s' first, in the order task_group_id, task_group_version, stage_order, settings", async (_, body, description) => {
      seed();

      const response = await send('POST', path, body);

      await expectError(response, 400, 'invalid_request', description);
      expectNothingLookedUp();
    });

    it.each([
      ['task_group_id', { task_group_id: 'newscast', task_group_version: 1, settings: {} }],
      ['task_group_version', { task_group_version: 1, settings: {} }],
      ['settings', { settings: {} }],
    ])("names '%s' on a crawler stage first, in the order task_group_id, task_group_version, settings, before the crawler is looked at", async (field, taskGroupFields) => {
      seed();

      const response = await send('POST', path, {
        stage_type: 'crawler',
        crawler_id: CRAWLER_ID,
        stage_order: 0,
        input_schema: {},
        ...taskGroupFields,
      });

      await expectError(response, 400, 'invalid_request', `Field '${field}' is not allowed on a crawler stage`);
      expectNothingLookedUp();
    });

    it('reads the registry only once every field is valid', async () => {
      seed();

      const response = await send('POST', path, { ...validTaskGroupStage, task_group_id: 'digest' });

      await expectError(response, 400, 'invalid_request', "Task group 'digest' version 1 is not registered");
      expect(supabase.requestsOf('GET', 'task_groups')).toHaveLength(1);
    });
  });
});

describe('PUT /schedulers/:id/stages/:stageID with stage types', () => {
  const taskGroupStagePath = `/schedulers/${SCHEDULER_ID}/stages/${TASK_GROUP_STAGE_ID}`;
  const crawlerStagePath = `/schedulers/${SCHEDULER_ID}/stages/${CRAWLER_STAGE_ID}`;

  function seedStages(taskGroups: Row[] = [
    taskGroupRow(),
    taskGroupRow({
      version: 2,
      settings_schema: { type: 'object', properties: { voice: { enum: ['calm', 'bright'] } }, required: ['voice'] },
    }),
  ]) {
    seed({ scheduler_stages: [crawlerStageRow(), taskGroupStageRow()], task_groups: taskGroups });
  }

  function stageUpdates() {
    return supabase.requestsOf('PATCH', 'scheduler_stages');
  }

  it('changes only the settings, checked against the stored version', async () => {
    seedStages();

    const response = await send('PUT', taskGroupStagePath, { settings: { voice: 'bright' } });

    expect(response.status).toBe(200);
    expect(stageUpdates().map((request) => request.body)).toEqual([{ settings: { voice: 'bright' } }]);
    expect(supabase.requestsOf('GET', 'task_groups')[0].query.get('version')).toBe('eq.1');
    expect(await response.json()).toMatchObject({ task_group_version: 1, settings: { voice: 'bright' } });
  });

  it('changes only the version, checking the stored settings against the new version', async () => {
    seedStages();

    const response = await send('PUT', taskGroupStagePath, { task_group_version: 2 });

    expect(response.status).toBe(200);
    expect(stageUpdates().map((request) => request.body)).toEqual([{ task_group_version: 2 }]);
    expect(supabase.requestsOf('GET', 'task_groups')[0].query.get('version')).toBe('eq.2');
  });

  it('rejects a new version the stored settings do not match', async () => {
    seedStages([
      taskGroupRow(),
      taskGroupRow({ version: 2, settings_schema: { type: 'object', required: ['language'] } }),
    ]);

    const response = await send('PUT', taskGroupStagePath, { task_group_version: 2 });

    await expectError(response, 400, 'invalid_request', "Field 'settings' does not match the task group settings format: $.language is required");
    expect(stageUpdates()).toHaveLength(0);
  });

  it('changes the version and the settings together, checking the new settings against the new version', async () => {
    seedStages();

    const response = await send('PUT', taskGroupStagePath, { task_group_version: 2, settings: { voice: 'bright' } });

    expect(response.status).toBe(200);
    expect(stageUpdates().map((request) => request.body)).toEqual([{ task_group_version: 2, settings: { voice: 'bright' } }]);
  });

  it('rejects new settings that do not match the new version', async () => {
    seedStages();

    const response = await send('PUT', taskGroupStagePath, { task_group_version: 2, settings: { voice: 'loud' } });

    await expectError(response, 400, 'invalid_request', `Field 'settings' does not match the task group settings format: $.voice must be one of: "calm", "bright"`);
  });

  it('rejects a version that is not registered', async () => {
    seedStages();

    const response = await send('PUT', taskGroupStagePath, { task_group_version: 3 });

    await expectError(response, 400, 'invalid_request', "Task group 'newscast' version 3 is not registered");
  });

  it.each([
    ['task_group_version is not a positive integer', { task_group_version: 0 }, "Field 'task_group_version' must be a positive integer"],
    ['settings is not an object', { settings: [] }, "Field 'settings' must be a JSON object"],
    ['neither field is given', {}, 'At least one field must be provided for update'],
    ['input_schema is given', { input_schema: {}, settings: { voice: 'calm' } }, "Field 'input_schema' is not allowed on a task group stage"],
    ['fan_out_strategy is given', { fan_out_strategy: 'compact' }, "Field 'fan_out_strategy' is not allowed on a task group stage"],
  ])('returns 400 for a task group stage when %s', async (_, body, description) => {
    seedStages();

    const response = await send('PUT', taskGroupStagePath, body);

    await expectError(response, 400, 'invalid_request', description);
    expect(stageUpdates()).toHaveLength(0);
  });

  it('returns 400 for crawler_id on a task group stage without checking the crawler permission', async () => {
    seedStages();

    const response = await send('PUT', taskGroupStagePath, { crawler_id: CRAWLER_ID });

    await expectError(response, 400, 'invalid_request', "Field 'crawler_id' is not allowed on a task group stage");
    expect(supabase.requestsOf('GET', 'crawler_permissions')).toHaveLength(0);
  });

  it.each([
    ['settings', { settings: { voice: 'calm' } }],
    ['task_group_version', { task_group_version: 1 }],
  ])('returns 400 for %s on a crawler stage', async (field, body) => {
    seedStages();

    const response = await send('PUT', crawlerStagePath, body);

    await expectError(response, 400, 'invalid_request', `Field '${field}' is not allowed on a crawler stage`);
    expect(stageUpdates()).toHaveLength(0);
  });

  it('still updates a crawler stage as before, after reading it', async () => {
    seedStages();

    const response = await send('PUT', crawlerStagePath, { crawler_id: CRAWLER_ID, fan_out_field: 'items' });

    expect(response.status).toBe(200);
    expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(1);
    expect(supabase.requestsOf('GET', 'crawler_permissions')).toHaveLength(1);
    expect(stageUpdates().map((request) => request.body)).toEqual([{ crawler_id: CRAWLER_ID, fan_out_field: 'items' }]);
  });

  it.each(['stage_type', 'task_group_id'])('returns 400 for %s without reading the stage', async (field) => {
    seedStages();

    const response = await send('PUT', taskGroupStagePath, { [field]: 'task_group', settings: { voice: 'calm' } });

    await expectError(response, 400, 'invalid_request', `Field '${field}' cannot be changed`);
    expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(0);
  });

  it('returns 404 when the stage does not exist', async () => {
    seed();

    const response = await send('PUT', taskGroupStagePath, { settings: { voice: 'calm' } });

    await expectError(response, 404, 'not_found', 'Stage not found');
  });

  it('returns 500 when the settings format cannot be read', async () => {
    seedStages([taskGroupRow({ settings_schema: { anyOf: [] } })]);

    const response = await send('PUT', taskGroupStagePath, { settings: { voice: 'calm' } });

    await expectError(response, 500, 'server_error', 'Task group format cannot be read');
    expect(stageUpdates()).toHaveLength(0);
  });

  it('returns 400 when the database rejects the fields for the stage type', async () => {
    seedStages();
    supabase.intercept = (request) => (
      request.method === 'PATCH' && request.table === 'scheduler_stages'
        ? {
            statusCode: 400,
            data: {
              code: '23514',
              details: null,
              hint: null,
              message: 'new row for relation "scheduler_stages" violates check constraint "scheduler_stages_type_check"',
            },
          }
        : undefined
    );

    const response = await send('PUT', taskGroupStagePath, { settings: { voice: 'calm' } });

    await expectError(response, 400, 'invalid_request', 'Stage fields do not match the stage type');
  });

  it('returns 400 when the database rejects the fields for the stage type on a crawler stage', async () => {
    seedStages();
    supabase.intercept = (request) => (
      request.method === 'PATCH' && request.table === 'scheduler_stages'
        ? {
            statusCode: 400,
            data: {
              code: '23514',
              details: null,
              hint: null,
              message: 'new row for relation "scheduler_stages" violates check constraint "scheduler_stages_type_check"',
            },
          }
        : undefined
    );

    const response = await send('PUT', crawlerStagePath, { fan_out_field: 'items' });

    await expectError(response, 400, 'invalid_request', 'Stage fields do not match the stage type');
    expect(stageUpdates().map((request) => request.body)).toEqual([{ fan_out_field: 'items' }]);
  });

  // The message also matches the foreign key or the unique mapping, which the stage type mapping comes before
  const foreignKeyAndTypeMessage = 'insert or update on table "scheduler_stages" violates foreign key constraint "scheduler_stages_crawler_id_fkey" and violates check constraint "scheduler_stages_type_check"';
  const uniqueAndTypeMessage = 'duplicate key value violates unique constraint "scheduler_stages_scheduler_id_stage_order_key" and violates check constraint "scheduler_stages_type_check"';

  it.each([
    ['foreign key', 'crawler', crawlerStagePath, { fan_out_field: 'items' }, foreignKeyAndTypeMessage],
    ['unique', 'crawler', crawlerStagePath, { fan_out_field: 'items' }, uniqueAndTypeMessage],
    ['foreign key', 'task group', taskGroupStagePath, { settings: { voice: 'calm' } }, foreignKeyAndTypeMessage],
    ['unique', 'task group', taskGroupStagePath, { settings: { voice: 'calm' } }, uniqueAndTypeMessage],
  ])('maps the stage type rejection before the %s mapping on a %s stage', async (_, __, path, body, message) => {
    seedStages();
    supabase.intercept = (request) => (
      request.method === 'PATCH' && request.table === 'scheduler_stages'
        ? { statusCode: 400, data: { code: '23514', details: null, hint: null, message } }
        : undefined
    );

    const response = await send('PUT', path, body);

    await expectError(response, 400, 'invalid_request', 'Stage fields do not match the stage type');
    expect(stageUpdates()).toHaveLength(1);
  });

  it.each([
    ['the new version and the settings', { task_group_version: 2, settings: { voice: 'bright' } }, 2],
    ['the new version only', { task_group_version: 2 }, 2],
    ['the settings only, which are stored for the version the stage has', { settings: { voice: 'bright' } }, 1],
  ])('returns 400 naming the version when the database rejects the stage because the version was removed after the check: %s', async (_, body, version) => {
    seedStages();
    failStageWrite('PATCH', TASK_GROUP_FOREIGN_KEY_MESSAGE);

    const response = await send('PUT', taskGroupStagePath, body);

    await expectError(response, 400, 'invalid_request', `Task group 'newscast' version ${version} is not registered`);
    // The registry was read and the version was there, then the database rejected the write
    expect(supabase.requestsOf('GET', 'task_groups')).toHaveLength(1);
    expect(stageUpdates()).toHaveLength(1);
  });

  it('keeps the wording for a crawler that does not exist on a crawler stage', async () => {
    seedStages();
    failStageWrite('PATCH', CRAWLER_FOREIGN_KEY_MESSAGE);

    const response = await send('PUT', crawlerStagePath, { crawler_id: CRAWLER_ID });

    await expectError(response, 400, 'invalid_request', 'Referenced crawler does not exist');
    expect(stageUpdates()).toHaveLength(1);
  });

  describe('the order of the checks', () => {
    it('names stage_type before task_group_id, without reading the stage', async () => {
      seedStages();

      const response = await send('PUT', taskGroupStagePath, { task_group_id: 'digest', stage_type: 'task_group' });

      await expectError(response, 400, 'invalid_request', "Field 'stage_type' cannot be changed");
      expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(0);
    });

    it.each([
      ['settings of a task group stage', { settings: { voice: 'calm' } }],
      ['a new version of a task group stage', { task_group_version: 2 }],
      ['a crawler stage field', { crawler_id: CRAWLER_ID, fan_out_field: 'items' }],
      ['a field of a crawler stage alone', { fan_out_field: 'items' }],
      ['settings that would be wrong for a task group stage', { settings: [] }],
      ['a crawler_id that would be wrong for a crawler stage', { crawler_id: 'not-a-uuid' }],
    ])('returns 404 for a stage that does not exist whatever the body is: %s', async (_, body) => {
      seed();

      const response = await send('PUT', taskGroupStagePath, body);

      await expectError(response, 404, 'not_found', 'Stage not found');
      expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(1);
      expect(supabase.requestsOf('GET', 'crawler_permissions')).toHaveLength(0);
      expect(supabase.requestsOf('GET', 'task_groups')).toHaveLength(0);
      expect(stageUpdates()).toHaveLength(0);
    });

    it.each([
      ['settings', { crawler_id: CRAWLER_ID, settings: { voice: 'calm' } }],
      ['task_group_version', { crawler_id: CRAWLER_ID, task_group_version: 1 }],
    ])("rejects '%s' on a crawler stage before it looks at the crawler permission", async (field, body) => {
      seedStages();
      // A permission check that came first would answer 403 instead
      supabase.tables.crawler_permissions = [];

      const response = await send('PUT', crawlerStagePath, body);

      await expectError(response, 400, 'invalid_request', `Field '${field}' is not allowed on a crawler stage`);
      expect(supabase.requestsOf('GET', 'crawler_permissions')).toHaveLength(0);
      expect(stageUpdates()).toHaveLength(0);
    });

    it('names task_group_version before settings on a crawler stage', async () => {
      seedStages();

      const response = await send('PUT', crawlerStagePath, { settings: { voice: 'calm' }, task_group_version: 2 });

      await expectError(response, 400, 'invalid_request', "Field 'task_group_version' is not allowed on a crawler stage");
    });
  });
});

describe('GET /schedulers/:id/runs/:runID stage runs', () => {
  it('includes the stage runs by stage order with their progress, without input and output', async () => {
    const stageRun = (overrides: Row) => ({
      run_id: RUN_ID,
      stage_id: CRAWLER_STAGE_ID,
      status: 'completed',
      started_at: '2026-10-05T22:00:00.000Z',
      completed_at: '2026-10-05T22:01:00.000Z',
      input: { secret: 'input' },
      output: { secret: 'output' },
      error: null,
      items_total: null,
      items_succeeded: null,
      items_failed: null,
      task_group_id: null,
      task_group_version: null,
      progress: null,
      created_at: '2026-10-05T22:00:00.000Z',
      ...overrides,
    });
    seed({
      scheduler_runs: [{
        id: RUN_ID,
        scheduler_id: SCHEDULER_ID,
        status: 'running',
        started_at: '2026-10-05T22:00:00.000Z',
        completed_at: null,
        result: null,
        error: null,
        triggered_by: 'manual',
        scheduled_for: null,
        created_at: '2026-10-05T22:00:00.000Z',
      }],
      scheduler_stage_runs: [
        stageRun({
          id: '00000000-0000-0000-0000-000000000052',
          stage_id: TASK_GROUP_STAGE_ID,
          stage_order: 1,
          status: 'running',
          completed_at: null,
          task_group_id: 'newscast',
          task_group_version: 1,
          progress: { message: 'Writing', completed: 1, total: 3, reported_at: '2026-10-05T22:05:00.000Z' },
        }),
        stageRun({ id: '00000000-0000-0000-0000-000000000051', stage_order: 0 }),
      ],
    });

    const response = await send('GET', `/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}`);

    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; stage_runs: Row[] };
    expect(body.id).toBe(RUN_ID);
    expect(body.stage_runs.map((stageRunSummary) => stageRunSummary.stage_order)).toEqual([0, 1]);
    expect(body.stage_runs[1].progress).toEqual({ message: 'Writing', completed: 1, total: 3, reported_at: '2026-10-05T22:05:00.000Z' });
    expect(body.stage_runs[1]).toMatchObject({ task_group_id: 'newscast', task_group_version: 1, status: 'running' });
    for (const stageRunSummary of body.stage_runs) {
      expect(stageRunSummary).not.toHaveProperty('input');
      expect(stageRunSummary).not.toHaveProperty('output');
    }
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('gives an empty list for a run without stage runs, even when another run has some', async () => {
    seed({
      scheduler_runs: [runRow()],
      scheduler_stage_runs: [stageRunRow({ run_id: OTHER_RUN_ID })],
    });

    const response = await send('GET', `/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}`);

    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; stage_runs: unknown[] };
    expect(body.id).toBe(RUN_ID);
    expect(body.stage_runs).toEqual([]);
    expect(supabase.requestsOf('GET', 'scheduler_stage_runs')).toHaveLength(1);
  });

  it('returns 404 without reading the stage runs when the run does not exist', async () => {
    seed({ scheduler_runs: [], scheduler_stage_runs: [stageRunRow()] });

    const response = await send('GET', `/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}`);

    await expectError(response, 404, 'not_found', 'Run not found');
    expect(supabase.requestsOf('GET', 'scheduler_runs')).toHaveLength(1);
    expect(supabase.requestsOf('GET', 'scheduler_stage_runs')).toHaveLength(0);
  });

  it('puts no stage runs in the list of runs, and does not read them', async () => {
    seed({ scheduler_runs: [runRow()], scheduler_stage_runs: [stageRunRow()] });

    const response = await send('GET', `/schedulers/${SCHEDULER_ID}/runs`);

    expect(response.status).toBe(200);
    const body = await response.json() as { data: Row[] };
    expect(body.data.map((listedRun) => listedRun.id)).toEqual([RUN_ID]);
    for (const listedRun of body.data) {
      expect(listedRun).not.toHaveProperty('stage_runs');
    }
    expect(supabase.requestsOf('GET', 'scheduler_stage_runs')).toHaveLength(0);
  });
});
