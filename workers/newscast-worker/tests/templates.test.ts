import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import migrationText from '../../../packages/supabase-connector/migrations/016_create_newscast_tables.sql?raw';
import {
  addRow,
  fetchWorker,
  sessionToken,
  uniqueUUID,
  useInMemorySupabase,
  type Row,
} from './http-harness.ts';

// POST /newscasts/schedulers: the scheduler of a newscast template, made through the public API of the
// scheduler (the stand-in of vitest.config.ts) with the Authorization of the caller, and remembered for the
// next request.

const supabase = useInMemorySupabase();
const schedulerManager = (env as unknown as { SCHEDULER_MANAGER: Fetcher }).SCHEDULER_MANAGER;

const SYSTEM_USER_UUID = '00000000-0000-0000-0000-000000000001';
const SOURCES = ['geeknews', 'url', 'text'] as const;

interface User {
  userUUID: string;
  /** The header the tests send, so a test can compare it with what the scheduler received */
  authorization: string;
}

interface SchedulerRequest {
  method: string;
  route: string;
  schedulerID?: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

interface StoredStage {
  id: string;
  scheduler_id: string;
  stage_type: string;
  stage_order: number;
  [field: string]: unknown;
}

interface StoredScheduler {
  id: string;
  name: string;
  cron_expression: string | null;
  is_enabled: boolean;
  stages: StoredStage[];
}

interface Created {
  scheduler_id: string;
  form_stage_id: string;
  newscast_stage_id: string;
  source: string;
}

async function newUser(): Promise<User> {
  const userUUID = uniqueUUID();
  return { userUUID, authorization: `Bearer ${await sessionToken(userUUID)}` };
}

async function standIn(path: string, init?: RequestInit): Promise<unknown> {
  return (await schedulerManager.fetch(`https://stand-in.example.com${path}`, init)).json();
}

async function schedulerRequestsOf(user: User): Promise<SchedulerRequest[]> {
  return await standIn(`/__test__/requests?userID=${user.userUUID}`) as SchedulerRequest[];
}

async function schedulersOf(user: User): Promise<StoredScheduler[]> {
  return await standIn(`/__test__/schedulers?userID=${user.userUUID}`) as StoredScheduler[];
}

async function failSchedulerRequests(user: User, failures: Record<string, unknown>): Promise<void> {
  await standIn('/__test__/configure', { method: 'POST', body: JSON.stringify({ userID: user.userUUID, failures }) });
}

function routesOf(requests: SchedulerRequest[]): string[] {
  return requests.map((request) => request.route);
}

async function requestScheduler(user: User, source: unknown): Promise<Response> {
  return fetchWorker('/newscasts/schedulers', { method: 'POST', authorization: user.authorization, body: { source } });
}

async function createdBy(user: User, source: string): Promise<Created> {
  const response = await requestScheduler(user, source);
  expect(response.status).toBe(200);
  return await response.json() as Created;
}

function memoryOf(user: User, source?: string): Row[] {
  return (supabase.tables.newscast_schedulers ?? []).filter(
    (row) => row.user_uuid === user.userUUID && (source === undefined || row.source === source),
  );
}

function addGeekNewsList(overrides: Row = {}): Row {
  return addRow(supabase, 'crawlers', { id: uniqueUUID(), user_uuid: SYSTEM_USER_UUID, name: 'geeknews-list', ...overrides });
}

/** A scheduler a user already has, made through the scheduler API itself, with a form stage and a newscast stage */
async function makeUsableScheduler(user: User): Promise<Created> {
  const post = async (path: string, body: unknown): Promise<{ id: string }> => {
    const response = await schedulerManager.fetch(`https://scheduler-manager.internal${path}`, {
      method: 'POST',
      headers: { Authorization: user.authorization },
      body: JSON.stringify(body),
    });
    return await response.json() as { id: string };
  };
  const scheduler = await post('/schedulers', { name: 'Newscast from a URL', is_enabled: false });
  const form = await post(`/schedulers/${scheduler.id}/stages`, { stage_type: 'form', stage_order: 0, settings: {} });
  const newscast = await post(`/schedulers/${scheduler.id}/stages`, {
    stage_type: 'task_group',
    task_group_id: 'newscast',
    task_group_version: 1,
    stage_order: 1,
    settings: {},
  });
  return { scheduler_id: scheduler.id, form_stage_id: form.id, newscast_stage_id: newscast.id, source: 'url' };
}

describe('authentication and the body', () => {
  it('answers 401 without a session, reading and calling nothing', async () => {
    const response = await fetchWorker('/newscasts/schedulers', { method: 'POST', body: { source: 'url' } });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized', error_description: 'Valid authentication is required' });
    expect(supabase.requests).toEqual([]);
  });

  it('refuses a media token as a session', async () => {
    const user = uniqueUUID();
    const token = await sessionToken(user, { jid: uniqueUUID() });

    const response = await fetchWorker('/newscasts/schedulers', { method: 'POST', authorization: `Bearer ${token}`, body: { source: 'url' } });

    expect(response.status).toBe(401);
    expect(supabase.requests).toEqual([]);
  });

  it('answers 405 to a method other than POST, and does not read the path as a newscast ID', async () => {
    const response = await fetchWorker('/newscasts/schedulers', { userUUID: uniqueUUID() });

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(supabase.requests).toEqual([]);
  });

  it.each([
    ['no body', undefined],
    ['a body that is not JSON', 'not json'],
    ['a body without a source', {}],
    ['a source that is not a string', { source: 5 }],
    ['an unknown source', { source: 'rss' }],
    ['a source in another case', { source: 'GeekNews' }],
  ])('answers 400 to %s and creates nothing', async (_name, body) => {
    const user = await newUser();

    const response = await fetchWorker('/newscasts/schedulers', { method: 'POST', authorization: user.authorization, body });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_source', error_description: "source must be 'geeknews', 'url' or 'text'." });
    expect(supabase.requests).toEqual([]);
    expect(await schedulerRequestsOf(user)).toEqual([]);
  });
});

describe('making the scheduler of a template', () => {
  it('makes the url template: a form and the newscast group, with no schedule, turned off', async () => {
    const user = await newUser();

    const response = await requestScheduler(user, 'url');

    expect(response.status).toBe(200);
    const created = await response.json() as Created;
    expect(Object.keys(created).sort()).toEqual(['form_stage_id', 'newscast_stage_id', 'scheduler_id', 'source']);
    expect(created.source).toBe('url');
    const [scheduler, ...others] = await schedulersOf(user);
    expect(others).toEqual([]);
    expect(scheduler).toMatchObject({ id: created.scheduler_id, name: 'Newscast from a URL', cron_expression: null, is_enabled: false });
    expect(scheduler.stages.map((stage) => [stage.stage_order, stage.stage_type, stage.id])).toEqual([
      [0, 'form', created.form_stage_id],
      [1, 'task_group', created.newscast_stage_id],
    ]);
  });

  it('gives the form of the url template: a required http(s) URL of up to 2048 characters, with 30 minutes to answer', async () => {
    const user = await newUser();
    await createdBy(user, 'url');

    const [{ stages: [form] }] = await schedulersOf(user);

    expect(form).toMatchObject({
      stage_type: 'form',
      settings: {
        timeout_minutes: 30,
        form: {
          type: 'object',
          properties: { url: { type: 'string', 'x-widget': 'text', format: 'uri', maxLength: 2048 } },
          required: ['url'],
        },
      },
    });
  });

  it('gives the form of the text template: a title of up to 200 characters, and a required text of up to 24,000', async () => {
    const user = await newUser();
    const created = await createdBy(user, 'text');

    const [scheduler] = await schedulersOf(user);

    expect(scheduler.name).toBe('Newscast from text');
    expect(scheduler.stages.map((stage) => stage.id)).toEqual([created.form_stage_id, created.newscast_stage_id]);
    expect(scheduler.stages[0]).toMatchObject({
      stage_type: 'form',
      settings: {
        timeout_minutes: 30,
        form: {
          type: 'object',
          properties: {
            title: { type: 'string', 'x-widget': 'text', maxLength: 200 },
            text: { type: 'string', 'x-widget': 'textarea', maxLength: 24_000 },
          },
          required: ['text'],
        },
      },
    });
  });

  it('gives the newscast stage the registered task group, version 1, with the default of every setting', async () => {
    const user = await newUser();
    await createdBy(user, 'url');

    const [{ stages: [, newscast] }] = await schedulersOf(user);

    expect(newscast).toMatchObject({ stage_type: 'task_group', task_group_id: 'newscast', task_group_version: 1 });
    // The defaults are those the migration registers with the task group, not a copy that can drift
    const jsonLiterals = [...migrationText.matchAll(/'(\{[\s\S]*?\})'::jsonb/g)].map((match) => JSON.parse(match[1]) as {
      properties?: Record<string, { default: unknown }>;
    });
    const settingsSchema = jsonLiterals.find((schema) => schema.properties?.tts_model !== undefined);
    expect(settingsSchema?.properties).toBeDefined();
    expect(newscast.settings).toEqual(Object.fromEntries(Object.entries(settingsSchema!.properties!).map(([key, { default: value }]) => [key, value])));
  });

  it('sends the Authorization of the caller to the scheduler unchanged, on every request', async () => {
    const user = await newUser();

    await createdBy(user, 'text');

    const requests = await schedulerRequestsOf(user);
    expect(routesOf(requests)).toEqual(['POST /schedulers', 'POST /schedulers/:id/stages', 'POST /schedulers/:id/stages']);
    expect(requests.every((request) => request.authorization === user.authorization)).toBe(true);
    expect(requests.slice(1).map((request) => request.body?.stage_order)).toEqual([0, 1]);
    expect(requests[0].body).toEqual({ name: 'Newscast from text', is_enabled: false });
  });

  it('remembers the scheduler for the user and the source', async () => {
    const user = await newUser();

    const created = await createdBy(user, 'text');

    expect(memoryOf(user)).toEqual([expect.objectContaining({ user_uuid: user.userUUID, source: 'text', scheduler_id: created.scheduler_id })]);
  });

  describe('of every source', () => {
    it.each(SOURCES)('has the stages of the %s template in the contract of the form stage', async (source) => {
      addGeekNewsList();
      const user = await newUser();
      await createdBy(user, source);

      const [scheduler] = await schedulersOf(user);

      const forms = scheduler.stages.filter((stage) => stage.stage_type === 'form');
      expect(forms).toHaveLength(1);
      const settings = forms[0].settings as { form: { type: string; properties: Record<string, Record<string, unknown>>; required?: string[] }; timeout_minutes: number };
      expect(Object.keys(settings).sort()).toEqual(['form', 'timeout_minutes']);
      expect(settings.timeout_minutes).toBe(30);
      expect(settings.form.type).toBe('object');
      for (const field of settings.form.required ?? []) {
        expect(Object.keys(settings.form.properties)).toContain(field);
      }
      for (const [name, property] of Object.entries(settings.form.properties)) {
        const widget = property['x-widget'] as string;
        expect(['checkboxes', 'radio', 'select', 'text', 'textarea', 'number', 'toggle'], `${name} widget`).toContain(widget);
        const types: Record<string, string[]> = {
          checkboxes: ['array'],
          radio: ['string', 'number', 'integer'],
          select: ['string', 'number', 'integer'],
          text: ['string'],
          textarea: ['string'],
          number: ['number', 'integer'],
          toggle: ['boolean'],
        };
        expect(types[widget], `${name} type`).toContain(property.type);
        if (widget === 'checkboxes' || widget === 'radio' || widget === 'select') {
          expect(property['x-options'] !== undefined || property.enum !== undefined, `${name} choices`).toBe(true);
        }
        if (property.format !== undefined) {
          expect(property.format, `${name} format`).toBe('uri');
          expect(widget).toBe('text');
        }
        if (property['x-options'] !== undefined) {
          const options = property['x-options'] as { from: string; label: string; description?: string; value?: string };
          expect(options.from).toMatch(/^\$/);
          expect(typeof options.label).toBe('string');
        }
      }
      // The last stage is the newscast group, which the form feeds
      expect(scheduler.stages.at(-1)).toMatchObject({ stage_type: 'task_group', task_group_id: 'newscast' });
      expect(scheduler.stages.map((stage) => stage.stage_order)).toEqual(scheduler.stages.map((_, index) => index));
    });
  });
});

describe('the geeknews template', () => {
  it('makes the crawler stage of geeknews-list, the form that picks articles, and the newscast group', async () => {
    const crawler = addGeekNewsList();
    const user = await newUser();

    const created = await createdBy(user, 'geeknews');

    const [scheduler] = await schedulersOf(user);
    expect(scheduler.name).toBe('Newscast from GeekNews');
    expect(scheduler.stages.map((stage) => [stage.stage_order, stage.stage_type])).toEqual([[0, 'crawler'], [1, 'form'], [2, 'task_group']]);
    expect(scheduler.stages[0]).toMatchObject({
      crawler_id: crawler.id,
      input_schema: { url: { type: 'string', default: 'https://news.hada.io/' } },
    });
    expect(scheduler.stages[1]).toMatchObject({
      id: created.form_stage_id,
      settings: {
        timeout_minutes: 30,
        form: {
          type: 'object',
          properties: {
            articles: {
              type: 'array',
              'x-widget': 'checkboxes',
              'x-options': { from: '$', label: 'title', description: 'originalUrl' },
              minItems: 1,
              maxItems: 10,
            },
          },
          required: ['articles'],
        },
      },
    });
    expect(scheduler.stages[2].id).toBe(created.newscast_stage_id);
  });

  it('looks the crawler up among the system crawlers by name', async () => {
    const crawler = addGeekNewsList();
    addGeekNewsList({ user_uuid: uniqueUUID() });
    addGeekNewsList({ name: 'article-content' });
    const user = await newUser();

    await createdBy(user, 'geeknews');

    const lookups = supabase.requestsOf('GET', 'crawlers');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].query.get('user_uuid')).toBe(`eq.${SYSTEM_USER_UUID}`);
    expect(lookups[0].query.get('name')).toBe('eq.geeknews-list');
    const [scheduler] = await schedulersOf(user);
    expect(scheduler.stages[0].crawler_id).toBe(crawler.id);
  });

  it('subscribes the user to the crawler before it makes the scheduler', async () => {
    const crawler = addGeekNewsList();
    const user = await newUser();

    await createdBy(user, 'geeknews');

    expect(supabase.tables.crawler_permissions).toEqual([
      expect.objectContaining({ crawler_id: crawler.id, user_uuid: user.userUUID, level: 'subscriber' }),
    ]);
  });

  it('makes no scheduler when the subscription fails', async () => {
    addGeekNewsList();
    const user = await newUser();
    supabase.intercept = (request) =>
      request.method === 'POST' && request.table === 'crawler_permissions'
        ? { statusCode: 500, data: { code: 'XX000', details: null, hint: null, message: 'permission store is down' } }
        : undefined;

    const response = await requestScheduler(user, 'geeknews');

    expect(response.status).toBe(500);
    expect(await schedulerRequestsOf(user)).toEqual([]);
    expect(memoryOf(user)).toEqual([]);
  });

  it('does not subscribe a user who has a permission on the crawler, whatever its level', async () => {
    const crawler = addGeekNewsList();
    const user = await newUser();
    const permission = addRow(supabase, 'crawler_permissions', { id: uniqueUUID(), crawler_id: crawler.id, user_uuid: user.userUUID, level: 'owner' });

    await createdBy(user, 'geeknews');

    expect(supabase.tables.crawler_permissions).toEqual([permission]);
    expect(supabase.requestsOf('POST', 'crawler_permissions')).toEqual([]);
  });

  it('goes on when another request made the subscription between the read and the insert', async () => {
    const crawler = addGeekNewsList();
    const user = await newUser();
    supabase.intercept = (request) => {
      if (request.method !== 'POST' || request.table !== 'crawler_permissions') return undefined;
      addRow(supabase, 'crawler_permissions', { id: uniqueUUID(), crawler_id: crawler.id, user_uuid: user.userUUID, level: 'subscriber' });
      return { statusCode: 409, data: { code: '23505', details: null, hint: null, message: 'duplicate key value violates unique constraint "crawler_permissions_crawler_id_user_uuid_key"' } };
    };

    const response = await requestScheduler(user, 'geeknews');

    expect(response.status).toBe(200);
    expect(supabase.tables.crawler_permissions).toHaveLength(1);
  });

  it('answers 503 template_unavailable, making nothing, when the crawler does not exist', async () => {
    addGeekNewsList({ name: 'another-crawler' });
    const user = await newUser();

    const response = await requestScheduler(user, 'geeknews');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'template_unavailable',
      error_description: "The system crawler 'geeknews-list' does not exist.",
    });
    expect(await schedulerRequestsOf(user)).toEqual([]);
    expect(supabase.requestsOf('POST', 'crawler_permissions')).toEqual([]);
    expect(memoryOf(user)).toEqual([]);
  });

  it('does not look for the crawler or subscribe for the other templates', async () => {
    const user = await newUser();

    await createdBy(user, 'url');
    await createdBy(user, 'text');

    expect(supabase.requestsOf('GET', 'crawlers')).toEqual([]);
    expect(supabase.requestsOf('GET', 'crawler_permissions')).toEqual([]);
    expect(supabase.requestsOf('POST', 'crawler_permissions')).toEqual([]);
  });
});

describe('using the scheduler again', () => {
  it('answers the same scheduler and stages to the next request, making nothing', async () => {
    const user = await newUser();
    const first = await createdBy(user, 'url');
    const before = (await schedulerRequestsOf(user)).length;

    const second = await createdBy(user, 'url');

    expect(second).toEqual(first);
    expect(routesOf((await schedulerRequestsOf(user)).slice(before))).toEqual(['GET /schedulers/:id', 'GET /schedulers/:id/stages']);
    expect(await schedulersOf(user)).toHaveLength(1);
    expect(memoryOf(user)).toHaveLength(1);
  });

  it('asks the scheduler with the Authorization of the caller', async () => {
    const user = await newUser();
    await createdBy(user, 'url');
    const before = (await schedulerRequestsOf(user)).length;

    await createdBy(user, 'url');

    const requests = (await schedulerRequestsOf(user)).slice(before);
    expect(requests.map((request) => request.authorization)).toEqual([user.authorization, user.authorization]);
  });

  it('keeps a scheduler for each source and for each user', async () => {
    addGeekNewsList();
    const user = await newUser();
    const other = await newUser();

    const created = [
      await createdBy(user, 'geeknews'),
      await createdBy(user, 'url'),
      await createdBy(user, 'text'),
      await createdBy(other, 'url'),
    ];

    expect(new Set(created.map((entry) => entry.scheduler_id)).size).toBe(4);
    expect(memoryOf(user).map((row) => row.source).sort()).toEqual(['geeknews', 'text', 'url']);
    expect(memoryOf(other, 'url')).toHaveLength(1);
    expect(await createdBy(user, 'url')).toEqual(created[1]);
    expect(await createdBy(other, 'url')).toEqual(created[3]);
  });

  it('makes a new scheduler, and remembers it in place of the old one, when the old one was deleted', async () => {
    const user = await newUser();
    const first = await createdBy(user, 'url');
    await standIn('/__test__/forget', { method: 'POST', body: JSON.stringify({ schedulerID: first.scheduler_id }) });

    const second = await createdBy(user, 'url');

    expect(second.scheduler_id).not.toBe(first.scheduler_id);
    expect(second.form_stage_id).not.toBe(first.form_stage_id);
    expect(memoryOf(user)).toEqual([expect.objectContaining({ source: 'url', scheduler_id: second.scheduler_id })]);
    expect(await createdBy(user, 'url')).toEqual(second);
  });

  it('makes a new scheduler when the old one lost its newscast stage, and when it lost its form', async () => {
    const user = await newUser();
    const first = await createdBy(user, 'url');
    await standIn('/__test__/remove-stage', { method: 'POST', body: JSON.stringify({ stageID: first.newscast_stage_id }) });

    const second = await createdBy(user, 'url');
    await standIn('/__test__/remove-stage', { method: 'POST', body: JSON.stringify({ stageID: second.form_stage_id }) });
    const third = await createdBy(user, 'url');

    expect(new Set([first.scheduler_id, second.scheduler_id, third.scheduler_id]).size).toBe(3);
    expect(memoryOf(user)).toEqual([expect.objectContaining({ scheduler_id: third.scheduler_id })]);
  });

  it('uses a scheduler the user made by hand with a form and a newscast stage, if it is the remembered one', async () => {
    const user = await newUser();
    const own = await makeUsableScheduler(user);
    addRow(supabase, 'newscast_schedulers', { user_uuid: user.userUUID, source: 'url', scheduler_id: own.scheduler_id, created_at: '2026-10-26T00:00:00.000Z' });

    const created = await createdBy(user, 'url');

    expect(created).toEqual(own);
    expect(await schedulersOf(user)).toHaveLength(1);
  });

  it.each([
    ['cannot be reached', { status: 'unreachable' }, 503, 'scheduler_unavailable'],
    ['fails', { status: 500, body: { error: 'server_error', error_description: 'An unexpected error occurred' } }, 502, 'scheduler_failed'],
  ])('makes no second scheduler when the scheduler %s while it looks for the first', async (_name, failure, status, error) => {
    const user = await newUser();
    const first = await createdBy(user, 'url');
    const before = (await schedulerRequestsOf(user)).length;
    await failSchedulerRequests(user, { 'GET /schedulers/:id': failure });

    const response = await requestScheduler(user, 'url');

    expect(response.status).toBe(status);
    expect((await response.json() as { error: string }).error).toBe(error);
    expect(routesOf((await schedulerRequestsOf(user)).slice(before))).toEqual(['GET /schedulers/:id']);
    expect(memoryOf(user)).toEqual([expect.objectContaining({ scheduler_id: first.scheduler_id })]);
    expect(await schedulersOf(user)).toHaveLength(1);
  });

  it('makes no second scheduler when it cannot list the stages of the first', async () => {
    const user = await newUser();
    await createdBy(user, 'url');
    await failSchedulerRequests(user, { 'GET /schedulers/:id/stages': { status: 'unreachable' } });

    const response = await requestScheduler(user, 'url');

    expect(response.status).toBe(503);
    expect(await schedulersOf(user)).toHaveLength(1);
  });
});

describe('when the scheduler fails', () => {
  it('answers 503 scheduler_unavailable when it cannot be reached, remembering nothing', async () => {
    const user = await newUser();
    await failSchedulerRequests(user, { 'POST /schedulers': { status: 'unreachable' } });

    const response = await requestScheduler(user, 'url');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'scheduler_unavailable',
      error_description: 'The scheduler could not be reached. Try again in a moment.',
    });
    expect(memoryOf(user)).toEqual([]);
  });

  it('answers 502 scheduler_rejected with the reason of the scheduler, deletes the scheduler it made, and remembers nothing', async () => {
    const user = await newUser();
    await failSchedulerRequests(user, {
      'POST /schedulers/:id/stages': [null, { status: 400, body: { error: 'invalid_request', error_description: "Field 'stage_type' must be 'crawler' or 'task_group'" } }],
    });

    const response = await requestScheduler(user, 'url');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'scheduler_rejected',
      error_description: "The scheduler answered 400: Field 'stage_type' must be 'crawler' or 'task_group'",
    });
    expect(await schedulersOf(user)).toEqual([]);
    expect(routesOf(await schedulerRequestsOf(user))).toEqual([
      'POST /schedulers',
      'POST /schedulers/:id/stages',
      'POST /schedulers/:id/stages',
      'DELETE /schedulers/:id',
    ]);
    expect(memoryOf(user)).toEqual([]);
  });

  it('answers 502 scheduler_failed when the scheduler answers with a server error', async () => {
    const user = await newUser();
    await failSchedulerRequests(user, { 'POST /schedulers': { status: 500, body: { error: 'server_error', error_description: 'An unexpected error occurred' } } });

    const response = await requestScheduler(user, 'url');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'scheduler_failed',
      error_description: 'The scheduler answered 500: An unexpected error occurred',
    });
  });

  it('answers 502 scheduler_failed when the scheduler gives no ID for what it made', async () => {
    const user = await newUser();
    await failSchedulerRequests(user, { 'POST /schedulers': { status: 201, body: {} } });

    const response = await requestScheduler(user, 'url');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'scheduler_failed',
      error_description: 'The scheduler answered without the ID of the scheduler.',
    });
    expect(memoryOf(user)).toEqual([]);
  });

  it('does not pass on more than the start of a long reason', async () => {
    const user = await newUser();
    await failSchedulerRequests(user, { 'POST /schedulers': { status: 400, body: { error_description: 'x'.repeat(2_000) } } });

    const response = await requestScheduler(user, 'url');

    const { error_description: description } = await response.json() as { error_description: string };
    expect(description).toBe(`The scheduler answered 400: ${'x'.repeat(300)}`);
  });

  it('answers the failure of the stage, though the scheduler it made cannot be deleted', async () => {
    const user = await newUser();
    await failSchedulerRequests(user, {
      'POST /schedulers/:id/stages': { status: 500 },
      'DELETE /schedulers/:id': { status: 'unreachable' },
    });

    const response = await requestScheduler(user, 'url');

    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toBe('scheduler_failed');
    expect(memoryOf(user)).toEqual([]);
  });

  it('deletes the scheduler it made when it cannot remember it', async () => {
    const user = await newUser();
    supabase.intercept = (request) =>
      request.method === 'POST' && request.table === 'newscast_schedulers'
        ? { statusCode: 500, data: { code: 'XX000', details: null, hint: null, message: 'store is down' } }
        : undefined;

    const response = await requestScheduler(user, 'url');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_error', error_description: 'An unexpected error occurred' });
    expect(await schedulersOf(user)).toEqual([]);
  });

  it('makes a second scheduler later for a user whose first could not be made', async () => {
    const user = await newUser();
    await failSchedulerRequests(user, { 'POST /schedulers': [{ status: 'unreachable' }, null] });

    expect((await requestScheduler(user, 'url')).status).toBe(503);
    const created = await createdBy(user, 'url');

    expect(await schedulersOf(user)).toHaveLength(1);
    expect(memoryOf(user)).toEqual([expect.objectContaining({ scheduler_id: created.scheduler_id })]);
  });
});

describe('two requests for the same source at once', () => {
  it('keeps the scheduler that was remembered first, deleting the one the later request made', async () => {
    const user = await newUser();
    const winner = await makeUsableScheduler(user);
    // The other request remembers its scheduler after this one has made its own and before this one remembers it
    supabase.intercept = (request) => {
      if (request.method === 'POST' && request.table === 'newscast_schedulers') {
        addRow(supabase, 'newscast_schedulers', { user_uuid: user.userUUID, source: 'url', scheduler_id: winner.scheduler_id, created_at: '2026-10-26T00:00:00.000Z' });
      }
      return undefined;
    };

    const created = await createdBy(user, 'url');

    expect(created).toEqual(winner);
    expect((await schedulersOf(user)).map((scheduler) => scheduler.id)).toEqual([winner.scheduler_id]);
    expect(memoryOf(user)).toEqual([expect.objectContaining({ scheduler_id: winner.scheduler_id })]);
  });

  it('keeps its own scheduler when the one remembered first cannot be used', async () => {
    const user = await newUser();
    const broken = await makeUsableScheduler(user);
    await standIn('/__test__/remove-stage', { method: 'POST', body: JSON.stringify({ stageID: broken.form_stage_id }) });
    supabase.intercept = (request) => {
      if (request.method === 'POST' && request.table === 'newscast_schedulers') {
        addRow(supabase, 'newscast_schedulers', { user_uuid: user.userUUID, source: 'url', scheduler_id: broken.scheduler_id, created_at: '2026-10-26T00:00:00.000Z' });
      }
      return undefined;
    };

    const created = await createdBy(user, 'url');

    expect(created.scheduler_id).not.toBe(broken.scheduler_id);
    expect(await schedulersOf(user)).toHaveLength(2);
    // The next request heals the memory
    supabase.intercept = undefined;
    const healed = await createdBy(user, 'url');
    expect(healed.scheduler_id).not.toBe(broken.scheduler_id);
    expect(memoryOf(user)).toEqual([expect.objectContaining({ scheduler_id: healed.scheduler_id })]);
  });
});
