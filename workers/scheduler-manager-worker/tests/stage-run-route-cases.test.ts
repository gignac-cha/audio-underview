import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { signJWT } from '@audio-underview/worker-tools';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

// GET /schedulers/:id/runs/:runID/stage-runs/:stageRunID and the stage run summaries of the run:
// the cases beyond crawler-run-logs.test.ts.

const WORKER_URL = 'https://worker.example.com';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const OTHER_USER_UUID = '00000000-0000-0000-0000-000000000002';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const OTHER_SCHEDULER_ID = '00000000-0000-0000-0000-000000000011';
const STAGE_ID = '00000000-0000-0000-0000-000000000020';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const OTHER_RUN_ID = '00000000-0000-0000-0000-000000000041';
const OTHER_SCHEDULERS_RUN_ID = '00000000-0000-0000-0000-000000000042';
const STAGE_RUN_ID = '00000000-0000-0000-0000-000000000050';
const OTHER_STAGE_RUN_ID = '00000000-0000-0000-0000-000000000051';
const OTHER_SCHEDULERS_STAGE_RUN_ID = '00000000-0000-0000-0000-000000000052';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';

const supabase = useInMemorySupabase('https://supabase.example.com');

const LOGS = [
  { level: 'log', message: 'hello', timestamp: '2026-10-13T00:00:00.000Z' },
  { level: 'error', message: 'Error: boom\n  at crawler.js:1', timestamp: '2026-10-13T00:00:01.000Z', item_index: 2 },
];

async function get(path: string, userUUID: string | null = USER_UUID, method = 'GET'): Promise<Response> {
  const headers = new Headers({ Origin: 'https://example.com' });
  if (userUUID !== null) {
    const now = Math.floor(Date.now() / 1000);
    headers.set('Authorization', `Bearer ${await signJWT({ sub: userUUID, iat: now, exp: now + 86400 }, JWT_SECRET)}`);
  }
  return SELF.fetch(new Request(`${WORKER_URL}${path}`, { method, headers }));
}

function runRow(id: string, schedulerID: string): Row {
  return {
    id,
    scheduler_id: schedulerID,
    status: 'completed',
    started_at: '2026-10-13T00:00:00.000Z',
    completed_at: '2026-10-13T00:01:00.000Z',
    result: { done: true },
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-13T00:00:00.000Z',
  };
}

function stageRunRow(id: string, runID: string, overrides: Row = {}): Row {
  return {
    id,
    run_id: runID,
    stage_id: STAGE_ID,
    stage_order: 0,
    status: 'completed',
    started_at: '2026-10-13T00:00:00.000Z',
    completed_at: '2026-10-13T00:00:30.000Z',
    input: { url: 'https://example.com', large: 'input' },
    output: { title: 'Example', large: 'output' },
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    task_group_id: null,
    task_group_version: null,
    progress: null,
    logs: LOGS,
    logs_truncated: true,
    created_at: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

function scheduler(id: string, userUUID: string, name: string): Row {
  return {
    id,
    user_uuid: userUUID,
    name,
    cron_expression: null,
    timezone: 'Asia/Seoul',
    is_enabled: true,
    last_run_at: null,
    next_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function seed() {
  supabase.tables.schedulers = [scheduler(SCHEDULER_ID, USER_UUID, 'Mine'), scheduler(OTHER_SCHEDULER_ID, OTHER_USER_UUID, 'Theirs')];
  supabase.tables.scheduler_runs = [
    runRow(RUN_ID, SCHEDULER_ID),
    runRow(OTHER_RUN_ID, SCHEDULER_ID),
    runRow(OTHER_SCHEDULERS_RUN_ID, OTHER_SCHEDULER_ID),
  ];
  supabase.tables.scheduler_stage_runs = [
    stageRunRow(STAGE_RUN_ID, RUN_ID),
    stageRunRow(OTHER_STAGE_RUN_ID, OTHER_RUN_ID),
    stageRunRow(OTHER_SCHEDULERS_STAGE_RUN_ID, OTHER_SCHEDULERS_RUN_ID),
  ];
}

describe('GET /schedulers/:id/runs/:runID/stage-runs/:stageRunID', () => {
  it('gives the whole stage run to the owner: input, output, logs and the progress of a task group too', async () => {
    seed();
    const progress = { message: 'Writing', completed: 1, total: 3, reported_at: '2026-10-13T00:00:10.000Z' };
    supabase.tables.scheduler_stage_runs[0] = stageRunRow(STAGE_RUN_ID, RUN_ID, { task_group_id: 'newscast', task_group_version: 1, progress });

    const response = await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${STAGE_RUN_ID}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: STAGE_RUN_ID,
      run_id: RUN_ID,
      stage_id: STAGE_ID,
      stage_order: 0,
      status: 'completed',
      started_at: '2026-10-13T00:00:00.000Z',
      completed_at: '2026-10-13T00:00:30.000Z',
      input: { url: 'https://example.com', large: 'input' },
      output: { title: 'Example', large: 'output' },
      error: null,
      items_total: null,
      items_succeeded: null,
      items_failed: null,
      task_group_id: 'newscast',
      task_group_version: 1,
      progress,
      logs: LOGS,
      logs_truncated: true,
      created_at: '2026-10-13T00:00:00.000Z',
    });
  });

  it('gives the logs of a stage run that has none as null', async () => {
    seed();
    supabase.tables.scheduler_stage_runs[0] = stageRunRow(STAGE_RUN_ID, RUN_ID, { logs: null, logs_truncated: false });

    const response = await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${STAGE_RUN_ID}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ logs: null, logs_truncated: false });
  });

  it('answers 404 Stage run not found for a stage run of another run, also of the same scheduler', async () => {
    seed();

    const response = await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${OTHER_STAGE_RUN_ID}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', error_description: 'Stage run not found' });
  });

  it('answers 404 for a run that is not the scheduler\'s and for a run or a stage run that does not exist', async () => {
    seed();

    for (const path of [
      `/schedulers/${SCHEDULER_ID}/runs/${OTHER_SCHEDULERS_RUN_ID}/stage-runs/${OTHER_SCHEDULERS_STAGE_RUN_ID}`,
      `/schedulers/${SCHEDULER_ID}/runs/00000000-0000-0000-0000-0000000000ff/stage-runs/${STAGE_RUN_ID}`,
      `/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/00000000-0000-0000-0000-0000000000ff`,
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect((await response.json() as { error: string }).error, path).toBe('not_found');
    }
  });

  it('shows nothing of the scheduler of another user, with either path', async () => {
    seed();

    const theirs = await get(`/schedulers/${OTHER_SCHEDULER_ID}/runs/${OTHER_SCHEDULERS_RUN_ID}/stage-runs/${OTHER_SCHEDULERS_STAGE_RUN_ID}`);
    const mine = await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${STAGE_RUN_ID}`, OTHER_USER_UUID);

    expect(theirs.status).toBe(404);
    expect(await theirs.text()).not.toContain('large');
    expect(mine.status).toBe(404);
    expect(await mine.text()).not.toContain('large');
  });

  it('answers 404 for an ID that is not a UUID, 401 without a token, and 405 for the other methods', async () => {
    seed();

    expect((await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/not-a-uuid`)).status).toBe(404);
    expect((await get(`/schedulers/${SCHEDULER_ID}/runs/not-a-uuid/stage-runs/${STAGE_RUN_ID}`)).status).toBe(404);
    expect((await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${STAGE_RUN_ID}`, null)).status).toBe(401);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${STAGE_RUN_ID}`, USER_UUID, method);
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toContain('GET');
    }
  });

  it('is listed in the help', async () => {
    const response = await SELF.fetch(new Request(`${WORKER_URL}/`, { headers: { Origin: 'https://example.com' } }));

    const help = await response.json() as { endpoints: { method: string; path: string }[] };
    expect(help.endpoints).toContainEqual(expect.objectContaining({ method: 'GET', path: '/schedulers/:id/runs/:runID/stage-runs/:stageRunID' }));
  });
});

describe('GET /schedulers/:id/runs/:runID', () => {
  it('lists the stage runs without their input, output and logs, and says whether the logs were cut', async () => {
    seed();

    const response = await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}`);

    expect(response.status).toBe(200);
    const body = await response.json() as { stage_runs: Record<string, unknown>[] };
    expect(body.stage_runs).toHaveLength(1);
    const summary = body.stage_runs[0];
    expect(summary).not.toHaveProperty('input');
    expect(summary).not.toHaveProperty('output');
    expect(summary).not.toHaveProperty('logs');
    expect(summary).toMatchObject({ id: STAGE_RUN_ID, status: 'completed', logs_truncated: true, progress: null });
    expect(JSON.stringify(body)).not.toContain('large');
    expect(JSON.stringify(body)).not.toContain('hello');
  });
});
