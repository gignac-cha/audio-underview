import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { signJWT } from '@audio-underview/worker-tools';
import worker, { type Environment } from '../sources/index.ts';
import { checkFormStageSettings } from '../sources/form-definition.ts';
import { resolveForm } from '../sources/form-resolution.ts';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

// The routes of form stages: saving a form stage, and answering or cancelling a form stage run
// that waits for its answer.

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const WORKER_URL = 'https://worker.example.com';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const OTHER_USER_UUID = '00000000-0000-0000-0000-000000000002';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const OTHER_SCHEDULER_ID = '00000000-0000-0000-0000-000000000011';
const CRAWLER_STAGE_ID = '00000000-0000-0000-0000-000000000020';
const FORM_STAGE_ID = '00000000-0000-0000-0000-000000000021';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const OTHER_RUN_ID = '00000000-0000-0000-0000-000000000041';
const CRAWLER_STAGE_RUN_ID = '00000000-0000-0000-0000-000000000050';
const FORM_STAGE_RUN_ID = '00000000-0000-0000-0000-000000000051';
const SCHEDULED_FOR = '2026-10-25T22:00:00.000Z';

const ARTICLES = [
  { title: 'First', discussionUrl: 'https://news.hada.io/topic?id=1', originalUrl: 'https://a.example.com/1' },
  { title: 'Second', discussionUrl: 'https://news.hada.io/topic?id=2', originalUrl: 'https://a.example.com/2' },
  { title: 'Third', discussionUrl: 'https://news.hada.io/topic?id=3', originalUrl: 'https://a.example.com/3' },
];

const ARTICLES_FORM = {
  type: 'object',
  properties: {
    articles: {
      type: 'array',
      'x-widget': 'checkboxes',
      'x-options': { from: '$', label: 'title', description: 'originalUrl' },
      minItems: 1,
      maxItems: 2,
    },
    note: { type: 'string', 'x-widget': 'text', maxLength: 5 },
  },
  required: ['articles'],
};

const ARTICLES_SETTINGS = { form: ARTICLES_FORM, timeout_minutes: 30 };

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

async function send(method: string, path: string, body?: unknown, options: { userUUID?: string; environment?: Environment; rawBody?: string } = {}): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ sub: options.userUUID ?? USER_UUID, iat: now, exp: now + 86400 }, JWT_SECRET);
  const request = new Request(`${WORKER_URL}${path}`, {
    method,
    headers: { Origin: 'https://example.com', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return worker.fetch(request, options.environment ?? env);
}

async function expectError(response: Response, status: number, error: string, description: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error, error_description: description });
}

function schedulerRow(id: string, userUUID: string): Row {
  return {
    id,
    user_uuid: userUUID,
    name: 'Newscast from GeekNews',
    cron_expression: null,
    timezone: 'Asia/Seoul',
    is_enabled: false,
    last_run_at: null,
    next_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function stageRow(overrides: Row = {}): Row {
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

function formStageRow(overrides: Row = {}): Row {
  return stageRow({ id: FORM_STAGE_ID, stage_type: 'form', crawler_id: null, settings: ARTICLES_SETTINGS, stage_order: 1, ...overrides });
}

function runRow(overrides: Row = {}): Row {
  return {
    id: RUN_ID,
    scheduler_id: SCHEDULER_ID,
    status: 'running',
    started_at: '2026-10-26T00:00:00.000Z',
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-26T00:00:00.000Z',
    ...overrides,
  };
}

// The form the stage run stored when the run reached the stage
function storedForm(settings: unknown, input: unknown): Row {
  const check = checkFormStageSettings(settings);
  if (!check.valid) throw new Error(check.description);
  const resolution = resolveForm(check.settings.form, input);
  if (!resolution.resolved) throw new Error(`No choices for ${resolution.fieldName}`);
  return { schema: resolution.form.schema, fields: resolution.form.fields, expires_at: '2026-10-26T00:31:00.000Z' };
}

function stageRunRow(overrides: Row = {}): Row {
  return {
    id: CRAWLER_STAGE_RUN_ID,
    run_id: RUN_ID,
    stage_id: CRAWLER_STAGE_ID,
    stage_order: 0,
    status: 'completed',
    started_at: '2026-10-26T00:00:00.000Z',
    completed_at: '2026-10-26T00:01:00.000Z',
    input: { url: 'https://news.hada.io/' },
    output: ARTICLES,
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    task_group_id: null,
    task_group_version: null,
    progress: null,
    form: null,
    created_at: '2026-10-26T00:00:00.000Z',
    ...overrides,
  };
}

function formStageRunRow(overrides: Row = {}): Row {
  return stageRunRow({
    id: FORM_STAGE_RUN_ID,
    stage_id: FORM_STAGE_ID,
    stage_order: 1,
    status: 'waiting',
    started_at: '2026-10-26T00:01:00.000Z',
    completed_at: null,
    input: ARTICLES,
    output: null,
    form: storedForm(ARTICLES_SETTINGS, ARTICLES),
    created_at: '2026-10-26T00:01:00.000Z',
    ...overrides,
  });
}

function seed(tables: Record<string, Row[]> = {}) {
  supabase.tables.schedulers = [schedulerRow(SCHEDULER_ID, USER_UUID), schedulerRow(OTHER_SCHEDULER_ID, OTHER_USER_UUID)];
  supabase.tables.crawler_permissions = [];
  supabase.tables.task_groups = [];
  supabase.tables.scheduler_stages = [stageRow(), formStageRow()];
  supabase.tables.scheduler_runs = [runRow(), runRow({ id: OTHER_RUN_ID, scheduler_id: OTHER_SCHEDULER_ID })];
  supabase.tables.scheduler_stage_runs = [stageRunRow(), formStageRunRow()];
  for (const [table, rows] of Object.entries(tables)) {
    supabase.tables[table] = rows;
  }
}

function findStageRun(id: string): Row | undefined {
  return supabase.tables.scheduler_stage_runs.find((stageRun) => stageRun.id === id);
}

// The Workflow binding the routes wake instances through. getError fails the first failingGets
// reads of an instance, or every read without failingGets.
function createWorkflow(options: { getError?: Error; failingGets?: number } = {}) {
  const events: { instanceID: string; type: string; payload: unknown }[] = [];
  let failedGets = 0;
  const get = vi.fn(async (instanceID: string) => {
    if (options.getError !== undefined && failedGets < (options.failingGets ?? Number.POSITIVE_INFINITY)) {
      failedGets += 1;
      throw options.getError;
    }
    return {
      id: instanceID,
      sendEvent: async (event: { type: string; payload: unknown }) => {
        events.push({ instanceID, ...event });
      },
    };
  });
  const environment = { ...env, SCHEDULER_RUN_WORKFLOW: { get } } as unknown as Environment;
  return { get, events, environment };
}

function stageRunActionPath(action: 'answer' | 'cancel', schedulerID = SCHEDULER_ID, runID = RUN_ID, stageRunID = FORM_STAGE_RUN_ID): string {
  return `/schedulers/${schedulerID}/runs/${runID}/stage-runs/${stageRunID}/${action}`;
}

describe('POST /schedulers/:id/stages with a form stage', () => {
  const path = `/schedulers/${SCHEDULER_ID}/stages`;
  const validFormStage = { stage_type: 'form', settings: ARTICLES_SETTINGS, stage_order: 1 };

  it('stores a form stage with its settings, without a crawler or a task group', async () => {
    seed({ scheduler_stages: [] });

    const response = await send('POST', path, validFormStage);

    expect(response.status).toBe(201);
    const inserts = supabase.requestsOf('POST', 'scheduler_stages');
    expect(inserts.map((request) => request.body)).toEqual([{
      scheduler_id: SCHEDULER_ID,
      stage_type: 'form',
      crawler_id: null,
      settings: ARTICLES_SETTINGS,
      stage_order: 1,
      input_schema: {},
    }]);
    expect(await response.json()).toMatchObject({ stage_type: 'form', settings: ARTICLES_SETTINGS, stage_order: 1 });
    expect(supabase.requestsOf('GET', 'crawler_permissions')).toHaveLength(0);
    expect(supabase.requestsOf('GET', 'task_groups')).toHaveLength(0);
  });

  it('stores the settings without timeout_minutes as they are', async () => {
    seed({ scheduler_stages: [] });

    const response = await send('POST', path, { ...validFormStage, settings: { form: ARTICLES_FORM } });

    expect(response.status).toBe(201);
    expect(supabase.requestsOf('POST', 'scheduler_stages')[0].body?.settings).toEqual({ form: ARTICLES_FORM });
  });

  it.each([
    ['crawler_id', { crawler_id: CRAWLER_ID }],
    ['input_schema', { input_schema: {} }],
    ['output_schema', { output_schema: {} }],
    ['fan_out_field', { fan_out_field: 'items' }],
    ['fan_out_strategy', { fan_out_strategy: 'compact' }],
    ['task_group_id', { task_group_id: 'newscast' }],
    ['task_group_version', { task_group_version: 1 }],
  ])("returns 400 for '%s' on a form stage", async (field, extra) => {
    seed({ scheduler_stages: [] });

    const response = await send('POST', path, { ...validFormStage, ...extra });

    await expectError(response, 400, 'invalid_request', `Field '${field}' is not allowed on a form stage`);
    expect(supabase.requestsOf('POST', 'scheduler_stages')).toHaveLength(0);
  });

  it.each([
    ['stage_order is missing', { ...validFormStage, stage_order: undefined }, "Field 'stage_order' is required and must be a non-negative integer"],
    ['settings is missing', { ...validFormStage, settings: undefined }, "Field 'settings' is required and must be a JSON object"],
    ['settings is an array', { ...validFormStage, settings: [] }, "Field 'settings' is required and must be a JSON object"],
    ['settings has no form', { ...validFormStage, settings: { timeout_minutes: 30 } }, "Field 'settings.form' is required and must be a JSON object"],
    ['settings has another key', { ...validFormStage, settings: { ...ARTICLES_SETTINGS, verbatim: true } }, "Field 'settings.verbatim' is not allowed on a form stage"],
    ['timeout_minutes is out of range', { ...validFormStage, settings: { ...ARTICLES_SETTINGS, timeout_minutes: 600000 } }, "Field 'settings.timeout_minutes' must be an integer from 1 to 525600"],
    [
      'a widget does not fit its type',
      { ...validFormStage, settings: { form: { type: 'object', properties: { url: { type: 'number', 'x-widget': 'text' } } } } },
      "Field 'settings.form' is not a valid form: $.properties.url must have type 'string' for x-widget 'text'",
    ],
    [
      'the form has a keyword the scheduler cannot read',
      { ...validFormStage, settings: { form: { type: 'object', properties: { url: { type: 'string', 'x-widget': 'text', pattern: '^https' } } } } },
      "Field 'settings.form' is not a valid form: Schema keyword 'pattern' at $.properties.url is not supported",
    ],
  ])('returns 400 when %s', async (_, body, description) => {
    seed({ scheduler_stages: [] });

    const response = await send('POST', path, body);

    await expectError(response, 400, 'invalid_request', description);
    expect(supabase.requestsOf('POST', 'scheduler_stages')).toHaveLength(0);
  });

  it('returns 409 when a stage with the order exists', async () => {
    seed({ scheduler_stages: [] });
    supabase.intercept = (request) => (
      request.method === 'POST' && request.table === 'scheduler_stages'
        ? { statusCode: 409, data: { code: '23505', details: null, hint: null, message: 'duplicate key value violates unique constraint "scheduler_stages_scheduler_id_stage_order_key"' } }
        : undefined
    );

    const response = await send('POST', path, validFormStage);

    await expectError(response, 409, 'conflict', 'A stage with this order already exists');
  });
});

describe('PUT /schedulers/:id/stages/:stageID on a form stage', () => {
  const path = `/schedulers/${SCHEDULER_ID}/stages/${FORM_STAGE_ID}`;
  const newSettings = { form: { type: 'object', properties: { url: { type: 'string', 'x-widget': 'text', format: 'uri' } } }, timeout_minutes: 60 };

  it('changes the settings after checking them', async () => {
    seed();

    const response = await send('PUT', path, { settings: newSettings });

    expect(response.status).toBe(200);
    expect(supabase.requestsOf('PATCH', 'scheduler_stages').map((request) => request.body)).toEqual([{ settings: newSettings }]);
    expect(await response.json()).toMatchObject({ stage_type: 'form', settings: newSettings });
  });

  it.each([
    ['crawler_id is given', { crawler_id: CRAWLER_ID, settings: newSettings }, "Field 'crawler_id' is not allowed on a form stage"],
    ['input_schema is given', { input_schema: {} }, "Field 'input_schema' is not allowed on a form stage"],
    ['task_group_version is given', { task_group_version: 1 }, "Field 'task_group_version' is not allowed on a form stage"],
    ['settings is not an object', { settings: [] }, "Field 'settings' must be a JSON object"],
    ['no field is given', {}, 'At least one field must be provided for update'],
    ['the form is not valid', { settings: { form: { type: 'object', properties: {} } } }, "Field 'settings.form' is not a valid form: $.properties must have at least one field"],
  ])('returns 400 when %s', async (_, body, description) => {
    seed();

    const response = await send('PUT', path, body);

    await expectError(response, 400, 'invalid_request', description);
    expect(supabase.requestsOf('PATCH', 'scheduler_stages')).toHaveLength(0);
    expect(supabase.requestsOf('GET', 'crawler_permissions')).toHaveLength(0);
  });

  it.each(['stage_type', 'task_group_id'])('returns 400 for %s without reading the stage', async (field) => {
    seed();

    const response = await send('PUT', path, { [field]: 'form', settings: newSettings });

    await expectError(response, 400, 'invalid_request', `Field '${field}' cannot be changed`);
    expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(0);
  });

  it('returns 400 when the database rejects the fields for the stage type', async () => {
    seed();
    supabase.intercept = (request) => (
      request.method === 'PATCH' && request.table === 'scheduler_stages'
        ? { statusCode: 400, data: { code: '23514', details: null, hint: null, message: 'new row for relation "scheduler_stages" violates check constraint "scheduler_stages_type_check"' } }
        : undefined
    );

    const response = await send('PUT', path, { settings: newSettings });

    await expectError(response, 400, 'invalid_request', 'Stage fields do not match the stage type');
  });
});

describe('POST /schedulers/:id/runs/:runID/stage-runs/:stageRunID/answer', () => {
  it('stores the items the chosen numbers stand for, completes the stage run only while it waits, and wakes the run', async () => {
    seed();
    const { environment, events } = createWorkflow();

    const response = await send('POST', stageRunActionPath('answer'), { answer: { articles: [2, 0], note: 'hi' } }, { environment });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'completed' });
    expect(findStageRun(FORM_STAGE_RUN_ID)).toMatchObject({
      status: 'completed',
      completed_at: expect.any(String),
      output: { articles: [ARTICLES[2], ARTICLES[0]], note: 'hi' },
      error: null,
    });
    const updates = supabase.requestsOf('PATCH', 'scheduler_stage_runs');
    expect(updates).toHaveLength(1);
    expect(updates[0].query.get('id')).toBe(`eq.${FORM_STAGE_RUN_ID}`);
    expect(updates[0].query.get('run_id')).toBe(`eq.${RUN_ID}`);
    expect(updates[0].query.get('status')).toBe('in.(waiting)');
    expect(events).toEqual([{
      instanceID: `manual-${RUN_ID}`,
      type: `form-answered-${FORM_STAGE_RUN_ID}`,
      payload: { stageRunID: FORM_STAGE_RUN_ID },
    }]);
  });

  it("wakes the instance of the occurrence for a scheduled run", async () => {
    seed({ scheduler_runs: [runRow({ triggered_by: 'schedule', scheduled_for: SCHEDULED_FOR })] });
    const { environment, events } = createWorkflow();

    const response = await send('POST', stageRunActionPath('answer'), { answer: { articles: [1] } }, { environment });

    expect(response.status).toBe(200);
    expect(events.map((event) => event.instanceID)).toEqual([`${SCHEDULER_ID}-${Date.parse(SCHEDULED_FOR) / 60000}`]);
  });

  it('maps the answer with the stage as it is, when only a field without choices changed', async () => {
    seed({
      scheduler_stages: [stageRow(), formStageRow({
        settings: { ...ARTICLES_SETTINGS, form: { ...ARTICLES_FORM, properties: { ...ARTICLES_FORM.properties, note: { type: 'string', 'x-widget': 'textarea' } } } },
      })],
    });
    const { environment } = createWorkflow();

    const response = await send('POST', stageRunActionPath('answer'), { answer: { articles: [1] } }, { environment });

    expect(response.status).toBe(200);
    expect(findStageRun(FORM_STAGE_RUN_ID)).toMatchObject({ status: 'completed', output: { articles: [ARTICLES[1]] } });
  });

  it.each([
    ['a required field is missing', { note: 'hi' }, '$.articles', 'is required'],
    ['no choice is picked', { articles: [] }, '$.articles', 'must have at least 1 items'],
    ['too many choices are picked', { articles: [0, 1, 2] }, '$.articles', 'must have at most 2 items'],
    ['a number is not a choice', { articles: [3] }, '$.articles[0]', 'must be one of: 0, 1, 2'],
    ['a choice is a value instead of its number', { articles: ['First'] }, '$.articles[0]', 'must be of type integer'],
    ['a field is not in the form', { articles: [0], extra: true }, '$.extra', 'is not allowed'],
    ['a text is too long', { articles: [0], note: 'too long' }, '$.note', 'must be at most 5 characters long'],
    ['a number is chosen twice', { articles: [1, 1] }, '$.articles[1]', 'is chosen more than once'],
  ])('returns 400 invalid_answer with the path and the reason when %s', async (_, answer, path, reason) => {
    seed();
    const { environment, events } = createWorkflow();

    const response = await send('POST', stageRunActionPath('answer'), { answer }, { environment });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_answer',
      error_description: `The answer does not match the form: ${path} ${reason}`,
      path,
      reason,
    });
    expect(findStageRun(FORM_STAGE_RUN_ID)).toMatchObject({ status: 'waiting', output: null });
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('checks a URL of a form against format uri', async () => {
    const urlSettings = { form: { type: 'object', properties: { url: { type: 'string', 'x-widget': 'text', format: 'uri', maxLength: 2048 } }, required: ['url'] } };
    seed({
      scheduler_stages: [formStageRow({ stage_order: 0, settings: urlSettings })],
      scheduler_stage_runs: [formStageRunRow({ stage_order: 0, input: {}, form: storedForm(urlSettings, {}) })],
    });
    const { environment } = createWorkflow();

    const rejected = await send('POST', stageRunActionPath('answer'), { answer: { url: 'file:///etc/passwd' } }, { environment });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ path: '$.url', reason: 'must be an http or https URL' });

    const accepted = await send('POST', stageRunActionPath('answer'), { answer: { url: 'https://a.example.com/article' } }, { environment });
    expect(accepted.status).toBe(200);
    expect(findStageRun(FORM_STAGE_RUN_ID)).toMatchObject({ status: 'completed', output: { url: 'https://a.example.com/article' } });
  });

  it.each([
    ['the body is not JSON', undefined, '{', 'Request body must be valid JSON'],
    ['the body is an array', [], undefined, 'Request body must be a JSON object'],
    ['answer is missing', {}, undefined, "Field 'answer' is required and must be a JSON object"],
    ['answer is an array', { answer: [0] }, undefined, "Field 'answer' is required and must be a JSON object"],
    ['answer is null', { answer: null }, undefined, "Field 'answer' is required and must be a JSON object"],
  ])('returns 400 when %s, before reading the run', async (_, body, rawBody, description) => {
    seed();
    const { environment } = createWorkflow();

    const response = await send('POST', stageRunActionPath('answer'), body, { environment, rawBody });

    await expectError(response, 400, 'invalid_request', description);
    expect(supabase.requestsOf('GET', 'scheduler_runs')).toHaveLength(0);
  });

  it.each([
    ['the scheduler is another user\'s', stageRunActionPath('answer', OTHER_SCHEDULER_ID, OTHER_RUN_ID), 'Scheduler not found'],
    ['the run is one of another scheduler', stageRunActionPath('answer', SCHEDULER_ID, OTHER_RUN_ID), 'Run not found'],
    ['the run does not exist', stageRunActionPath('answer', SCHEDULER_ID, '00000000-0000-0000-0000-000000000049'), 'Run not found'],
    ['the stage run does not exist', stageRunActionPath('answer', SCHEDULER_ID, RUN_ID, '00000000-0000-0000-0000-000000000059'), 'Stage run not found'],
  ])('returns 404 when %s', async (_, path, description) => {
    seed();
    const { environment, events } = createWorkflow();

    const response = await send('POST', path, { answer: { articles: [0] } }, { environment });

    await expectError(response, 404, 'not_found', description);
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('returns 404 for a stage run of another run of the scheduler', async () => {
    seed({
      scheduler_runs: [runRow(), runRow({ id: OTHER_RUN_ID, status: 'completed' })],
      scheduler_stage_runs: [formStageRunRow({ run_id: OTHER_RUN_ID })],
    });
    const { environment } = createWorkflow();

    const response = await send('POST', stageRunActionPath('answer'), { answer: { articles: [0] } }, { environment });

    await expectError(response, 404, 'not_found', 'Stage run not found');
  });

  it.each([
    ['it was answered', formStageRunRow({ status: 'completed', output: { articles: [] } })],
    ['it was cancelled or timed out', formStageRunRow({ status: 'failed', error: 'Stage 1: no answer within 30 minutes' })],
    ['it is a crawler stage run', stageRunRow({ id: FORM_STAGE_RUN_ID, status: 'running' })],
  ])('returns 409 not_waiting when %s', async (_, stageRun) => {
    seed({ scheduler_stage_runs: [stageRun] });
    const { environment, events } = createWorkflow();

    const response = await send('POST', stageRunActionPath('answer'), { answer: { articles: [0] } }, { environment });

    await expectError(response, 409, 'not_waiting', 'This stage is not waiting for an answer');
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('returns 409 not_waiting without waking the run when the stage run ended between the read and the update', async () => {
    seed();
    const { environment, events } = createWorkflow();
    supabase.intercept = (request) => {
      if (request.method === 'PATCH' && request.table === 'scheduler_stage_runs') {
        // The wait ran out in the meantime
        Object.assign(findStageRun(FORM_STAGE_RUN_ID)!, { status: 'failed', error: 'Stage 1: no answer within 30 minutes' });
      }
      return undefined;
    };

    const response = await send('POST', stageRunActionPath('answer'), { answer: { articles: [0] } }, { environment });

    await expectError(response, 409, 'not_waiting', 'This stage is not waiting for an answer');
    expect(findStageRun(FORM_STAGE_RUN_ID)).toMatchObject({ status: 'failed', output: null });
    expect(events).toEqual([]);
  });

  it('returns 409 form_changed when the choices of the stage are not the ones the form showed', async () => {
    seed({
      scheduler_stages: [stageRow(), formStageRow({
        settings: {
          ...ARTICLES_SETTINGS,
          form: { ...ARTICLES_FORM, properties: { ...ARTICLES_FORM.properties, articles: { ...ARTICLES_FORM.properties.articles, 'x-options': { from: '$', label: 'discussionUrl' } } } },
        },
      })],
    });
    const { environment, events } = createWorkflow();

    const response = await send('POST', stageRunActionPath('answer'), { answer: { articles: [0] } }, { environment });

    await expectError(response, 409, 'form_changed', 'The form of this stage changed after the run reached it; cancel the run and run it again');
    expect(findStageRun(FORM_STAGE_RUN_ID)).toMatchObject({ status: 'waiting' });
    expect(events).toEqual([]);
  });

  it('still answers 200 when the run cannot be woken after three tries, since the answer is stored, and logs an error', async () => {
    seed();
    const { environment, get, events } = createWorkflow({ getError: new Error('instance not found') });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await send('POST', stageRunActionPath('answer'), { answer: { articles: [0] } }, { environment });

      expect(response.status).toBe(200);
      expect(findStageRun(FORM_STAGE_RUN_ID)).toMatchObject({ status: 'completed', output: { articles: [ARTICLES[0]] } });
      expect(get).toHaveBeenCalledTimes(3);
      expect(events).toEqual([]);
      expect(warnSpy.mock.calls.filter((call) => JSON.stringify(call).includes('could not be woken, trying again'))).toHaveLength(2);
      const errors = errorSpy.mock.calls.filter((call) => JSON.stringify(call).includes('could not be woken'));
      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors[0])).toContain('instance not found');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('tries again to wake the run, and wakes it once on a later try without logging an error', async () => {
    seed();
    const { environment, get, events } = createWorkflow({ getError: new Error('Workflows is busy'), failingGets: 2 });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await send('POST', stageRunActionPath('answer'), { answer: { articles: [0] } }, { environment });

      expect(response.status).toBe(200);
      expect(get).toHaveBeenCalledTimes(3);
      expect(events).toEqual([{
        instanceID: `manual-${RUN_ID}`,
        type: `form-answered-${FORM_STAGE_RUN_ID}`,
        payload: { stageRunID: FORM_STAGE_RUN_ID },
      }]);
      expect(errorSpy.mock.calls.filter((call) => JSON.stringify(call).includes('could not be woken'))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns 405 with Allow: POST for GET', async () => {
    seed();

    const response = await send('GET', stageRunActionPath('answer'));

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('returns 401 without authentication', async () => {
    const response = await worker.fetch(new Request(`${WORKER_URL}${stageRunActionPath('answer')}`, { method: 'POST', headers: { Origin: 'https://example.com' } }), env);

    expect(response.status).toBe(401);
  });

  it('returns 404 for a stage run ID that is not a UUID', async () => {
    seed();

    const response = await send('POST', stageRunActionPath('answer', SCHEDULER_ID, RUN_ID, 'not-a-uuid'), { answer: {} });

    expect(response.status).toBe(404);
  });
});

describe('POST /schedulers/:id/runs/:runID/stage-runs/:stageRunID/cancel', () => {
  it('fails the waiting stage run only while it waits, and wakes the run', async () => {
    seed();
    const { environment, events } = createWorkflow();

    const response = await send('POST', stageRunActionPath('cancel'), undefined, { environment });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'failed' });
    expect(findStageRun(FORM_STAGE_RUN_ID)).toMatchObject({
      status: 'failed',
      error: 'Stage 1: cancelled by the owner',
      completed_at: expect.any(String),
      output: null,
    });
    const updates = supabase.requestsOf('PATCH', 'scheduler_stage_runs');
    expect(updates).toHaveLength(1);
    expect(updates[0].query.get('status')).toBe('in.(waiting)');
    expect(events).toEqual([{
      instanceID: `manual-${RUN_ID}`,
      type: `form-answered-${FORM_STAGE_RUN_ID}`,
      payload: { stageRunID: FORM_STAGE_RUN_ID },
    }]);
  });

  it.each([
    ['it was answered', formStageRunRow({ status: 'completed', output: { articles: [] } })],
    ['it was cancelled', formStageRunRow({ status: 'failed', error: 'Stage 1: cancelled by the owner' })],
  ])('returns 409 not_waiting when %s', async (_, stageRun) => {
    seed({ scheduler_stage_runs: [stageRun] });
    const { environment, events } = createWorkflow();

    const response = await send('POST', stageRunActionPath('cancel'), undefined, { environment });

    await expectError(response, 409, 'not_waiting', 'This stage is not waiting for an answer');
    expect(events).toEqual([]);
  });

  it('tries again to wake the run it cancelled', async () => {
    seed();
    const { environment, get, events } = createWorkflow({ getError: new Error('Workflows is busy'), failingGets: 1 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const response = await send('POST', stageRunActionPath('cancel'), undefined, { environment });

      expect(response.status).toBe(200);
      expect(get).toHaveBeenCalledTimes(2);
      expect(events.map((event) => event.type)).toEqual([`form-answered-${FORM_STAGE_RUN_ID}`]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    ['the scheduler is another user\'s', stageRunActionPath('cancel', OTHER_SCHEDULER_ID, OTHER_RUN_ID), 'Scheduler not found'],
    ['the run is one of another scheduler', stageRunActionPath('cancel', SCHEDULER_ID, OTHER_RUN_ID), 'Run not found'],
    ['the stage run does not exist', stageRunActionPath('cancel', SCHEDULER_ID, RUN_ID, '00000000-0000-0000-0000-000000000059'), 'Stage run not found'],
  ])('returns 404 when %s', async (_, path, description) => {
    seed();
    const { environment } = createWorkflow();

    const response = await send('POST', path, undefined, { environment });

    await expectError(response, 404, 'not_found', description);
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(0);
  });

  it('returns 405 with Allow: POST for DELETE', async () => {
    seed();

    const response = await send('DELETE', stageRunActionPath('cancel'));

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('the help', () => {
  it('lists the answer and the cancel of a form stage run', async () => {
    const response = await worker.fetch(new Request(WORKER_URL, { headers: { Origin: 'https://example.com' } }), env);

    const body = await response.json() as { endpoints: { method: string; path: string }[] };
    expect(body.endpoints).toContainEqual(expect.objectContaining({ method: 'POST', path: '/schedulers/:id/runs/:runID/stage-runs/:stageRunID/answer' }));
    expect(body.endpoints).toContainEqual(expect.objectContaining({ method: 'POST', path: '/schedulers/:id/runs/:runID/stage-runs/:stageRunID/cancel' }));
  });
});
