import { describe, it, expect, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { SchedulerStageRow } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import { signJWT, type CrawlerLogEntry, type CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { ServiceBindingCrawlerExecutionClient, type CrawlerExecutionClient } from '../sources/crawler-execution-client.ts';
import { limitCrawlerLogs } from '../sources/crawler-logs.ts';
import { executeFanOut, executeStage, type CrawlerStageRow } from '../sources/stage-runner.ts';
import { executeScheduler, type ExecutorDependencies } from '../sources/scheduler-executor.ts';
import { resolveHTTPStatus } from '../sources/handlers/scheduler-execution.ts';
import { runScheduledPipeline, type ScheduledPipelineStep } from '../sources/scheduled-pipeline.ts';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

// The logs of crawler stages (design 2026-10-13, section 8): the run() call with the user and the
// run, the logs on stage runs, fan-out merging, the stage run detail route and the run summary.

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const OTHER_USER_UUID = '00000000-0000-0000-0000-000000000002';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const OTHER_SCHEDULER_ID = '00000000-0000-0000-0000-000000000011';
const STAGE_ID = '00000000-0000-0000-0000-000000000020';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const OTHER_RUN_ID = '00000000-0000-0000-0000-000000000041';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

function stage(overrides: Partial<SchedulerStageRow> = {}): CrawlerStageRow {
  return {
    id: STAGE_ID,
    scheduler_id: SCHEDULER_ID,
    stage_type: 'crawler',
    crawler_id: CRAWLER_ID,
    task_group_id: null,
    task_group_version: null,
    settings: null,
    stage_order: 0,
    input_schema: { url: { type: 'string', default: 'https://example.com' } },
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as CrawlerStageRow;
}

function entry(message: string, level: CrawlerLogEntry['level'] = 'log'): CrawlerLogEntry {
  return { level, message, timestamp: '2026-10-13T00:00:00.000Z' };
}

function completed(result: unknown, logs: CrawlerLogEntry[] = [], logsTruncated = false): CrawlerRunOutcome {
  return { status: 'completed', type: 'data', result, logs, logs_truncated: logsTruncated };
}

function failed(error: string, logs: CrawlerLogEntry[] = [], logsTruncated = false): CrawlerRunOutcome {
  return { status: 'failed', type: 'data', error_code: 'execution_failed', error, error_description: error, logs, logs_truncated: logsTruncated };
}

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), createChild: vi.fn().mockReturnThis() } as unknown as Logger;
}

function createDependencies(run: CrawlerExecutionClient['run']): ExecutorDependencies & { crawlerExecutionClient: { run: ReturnType<typeof vi.fn> } } {
  return {
    supabaseClient: createSupabaseClient({ supabaseURL: env.SUPABASE_URL, supabaseSecretKey: env.SUPABASE_SECRET_KEY }),
    crawlerExecutionClient: { run: vi.fn(run) },
    logger: createLogger(),
    userUUID: USER_UUID,
  };
}

function seedScheduler(status = 'pending') {
  supabase.tables.schedulers = [{
    id: SCHEDULER_ID,
    user_uuid: USER_UUID,
    name: 'Scheduler',
    cron_expression: '0 * * * *',
    timezone: 'UTC',
    is_enabled: true,
    last_run_at: null,
    next_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }];
  supabase.tables.scheduler_runs = [{
    id: RUN_ID,
    scheduler_id: SCHEDULER_ID,
    status,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-13T00:00:00Z',
  }];
}

function stageRuns(): Row[] {
  return supabase.tables.scheduler_stage_runs ?? [];
}

describe('a crawler stage', () => {
  it('runs the crawler for the user and the run, and records the output with the logs', async () => {
    seedScheduler();
    const logs = [entry('first'), entry('second', 'warn')];
    const dependencies = createDependencies(async () => completed({ title: 'A' }, logs, true));

    const result = await executeStage(dependencies, RUN_ID, stage(), { url: 'https://example.com' });

    expect(dependencies.crawlerExecutionClient.run).toHaveBeenCalledWith(CRAWLER_ID, { url: 'https://example.com' }, { userUUID: USER_UUID, runID: RUN_ID });
    expect(result.output).toEqual({ title: 'A' });
    expect(stageRuns()[0]).toMatchObject({ status: 'completed', output: { title: 'A' }, logs, logs_truncated: true });
  });

  it('records a failed outcome once with its error and logs, then fails the run with that error', async () => {
    seedScheduler();
    const logs = [entry('before the failure'), entry('Error: boom\n    at crawler', 'error')];
    const error = 'CodeRunner error 422: [execution_failed] boom';
    const dependencies = createDependencies(async () => failed(error, logs));

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID, undefined, [stage()]);

    const stageRunUpdates = supabase.requestsOf('PATCH', 'scheduler_stage_runs');
    expect(stageRunUpdates).toHaveLength(1);
    expect(stageRunUpdates[0].body).toMatchObject({ status: 'failed', error, logs, logs_truncated: false });
    expect(stageRuns()[0]).toMatchObject({ status: 'failed', error, logs });
    expect(supabase.tables.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
    expect(resolveHTTPStatus('failed', error)).toBe(502);
  });

  it('records no logs when the call itself throws, as before', async () => {
    seedScheduler();
    const dependencies = createDependencies(async () => {
      throw new Error('Crawler 00000000-0000-0000-0000-000000000030 not found');
    });

    await expect(executeStage(dependencies, RUN_ID, stage(), {})).rejects.toThrow('not found');

    const update = supabase.requestsOf('PATCH', 'scheduler_stage_runs')[0].body as Row;
    expect(update).toMatchObject({ status: 'failed', error: 'Crawler 00000000-0000-0000-0000-000000000030 not found' });
    expect(update).not.toHaveProperty('logs');
  });
});

describe('a fan-out stage', () => {
  it('runs every item for the user and the run, and puts item_index on the logs of each item', async () => {
    seedScheduler();
    const dependencies = createDependencies(async (_crawlerID, item) => completed(`done ${item}`, [entry(`working on ${item}`)]));

    const result = await executeFanOut(dependencies, RUN_ID, stage({ fan_out_field: 'items' }), ['a', 'b']);

    expect(dependencies.crawlerExecutionClient.run.mock.calls).toEqual([
      [CRAWLER_ID, 'a', { userUUID: USER_UUID, runID: RUN_ID }],
      [CRAWLER_ID, 'b', { userUUID: USER_UUID, runID: RUN_ID }],
    ]);
    expect(result.logs).toEqual([
      { ...entry('working on a'), item_index: 0 },
      { ...entry('working on b'), item_index: 1 },
    ]);
    expect(result.logsTruncated).toBe(false);
  });

  it('adds an error entry for an item that failed or threw, after the logs of a failed item', async () => {
    seedScheduler();
    const dependencies = createDependencies(async (_crawlerID, item) => {
      if (item === 'failing') return failed('CodeRunner error 422: [execution_failed] bad item', [entry('trying')]);
      if (item === 'throwing') throw new Error('Crawler manager is unreachable');
      return completed('ok', [entry('fine')]);
    });

    const result = await executeFanOut(dependencies, RUN_ID, stage({ fan_out_field: 'items', fan_out_strategy: 'preserve' }), ['good', 'failing', 'throwing']);

    expect(result).toMatchObject({ status: 'partially_failed', itemsSucceeded: 1, itemsFailed: 2, results: ['ok', null, null] });
    expect(result.logs.map(({ level, message, item_index }) => [level, message, item_index])).toEqual([
      ['log', 'fine', 0],
      ['log', 'trying', 1],
      ['error', 'CodeRunner error 422: [execution_failed] bad item', 1],
      ['error', 'Crawler manager is unreachable', 2],
    ]);
    for (const logEntry of result.logs) {
      expect(new Date(logEntry.timestamp).toISOString()).toBe(logEntry.timestamp);
    }
  });

  it('keeps the logs in item order whatever order the items end in', async () => {
    seedScheduler();
    const dependencies = createDependencies(async (_crawlerID, item) => {
      await new Promise((resolve) => setTimeout(resolve, item === 0 ? 30 : 1));
      return completed(item, [entry(`item ${item}`)]);
    });

    const result = await executeFanOut(dependencies, RUN_ID, stage({ fan_out_field: 'items' }), [0, 1, 2], 3);

    expect(result.logs.map((logEntry) => logEntry.item_index)).toEqual([0, 1, 2]);
  });

  it('cuts the merged logs to the limits of one run and replaces NUL', async () => {
    seedScheduler();
    const dependencies = createDependencies(async (_crawlerID, item) => completed(item, [entry(`${'x'.repeat(30_000)}\u0000${item}`)]));

    const result = await executeFanOut(dependencies, RUN_ID, stage({ fan_out_field: 'items' }), [0, 1, 2]);

    // Two entries of 30,002 characters cost 60,132; the third has 5,404 left, 5,340 for its message
    expect(result.logs).toHaveLength(3);
    expect(result.logs[0].message).toBe(`${'x'.repeat(30_000)}�0`);
    expect(result.logs[2].message).toBe('x'.repeat(5_340));
    expect(result.logsTruncated).toBe(true);
  });

  it('keeps at most 1000 entries over all the items', async () => {
    seedScheduler();
    const dependencies = createDependencies(async () => completed(null, Array.from({ length: 600 }, () => entry(''))));

    const result = await executeFanOut(dependencies, RUN_ID, stage({ fan_out_field: 'items' }), [0, 1]);

    expect(result.logs).toHaveLength(1000);
    expect(result.logs[999].item_index).toBe(1);
    expect(result.logsTruncated).toBe(true);
  });

  it('is truncated when the logs of one item were', async () => {
    seedScheduler();
    const dependencies = createDependencies(async () => completed(null, [entry('short')], true));

    const result = await executeFanOut(dependencies, RUN_ID, stage({ fan_out_field: 'items' }), [0]);

    expect(result.logsTruncated).toBe(true);
  });

  it('records the merged logs on the stage run', async () => {
    seedScheduler();
    const dependencies = createDependencies(async (_crawlerID, item) => completed(item, [entry(`item ${item}`)]));

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID, undefined, [
      stage({ input_schema: { items: { type: 'array', default: ['a', 'b'] } }, fan_out_field: 'items' }),
    ]);

    expect(stageRuns()[0]).toMatchObject({
      status: 'completed',
      output: ['a', 'b'],
      logs: [
        { ...entry('item a'), item_index: 0 },
        { ...entry('item b'), item_index: 1 },
      ],
      logs_truncated: false,
    });
  });
});

describe('a scheduled run', () => {
  it('runs every crawler stage, fan-out items included, for the owner of the scheduler and the run', async () => {
    seedScheduler();
    supabase.tables.scheduler_runs = [];
    supabase.tables.scheduler_stages = [
      stage({ id: STAGE_ID, stage_order: 0 }) as unknown as Row,
      stage({ id: '00000000-0000-0000-0000-000000000021', stage_order: 1, fan_out_field: 'items', input_schema: {} }) as unknown as Row,
    ];
    const run = vi.fn(async (_crawlerID: string, input: unknown) => (
      input !== null && typeof input === 'object' && 'url' in input ? completed({ items: ['x', 'y'] }) : completed(input)
    ));
    const step: ScheduledPipelineStep = {
      do: async (_name, _options, callback) => callback(),
      waitForEvent: async () => {
        throw new Error('no task group here');
      },
    };

    const result = await runScheduledPipeline({
      supabaseClient: createSupabaseClient({ supabaseURL: env.SUPABASE_URL, supabaseSecretKey: env.SUPABASE_SECRET_KEY }),
      crawlerExecutionClient: { run },
      logger: createLogger(),
      resolveTaskGroupWorker: () => undefined,
    }, { schedulerID: SCHEDULER_ID, scheduledFor: '2026-10-13T01:00:00.000Z' }, step);

    expect(result).toMatchObject({ outcome: 'started', status: 'completed' });
    const runID = supabase.tables.scheduler_runs[0].id;
    expect(run.mock.calls.map((call) => call[2])).toEqual([
      { userUUID: USER_UUID, runID },
      { userUUID: USER_UUID, runID },
      { userUUID: USER_UUID, runID },
    ]);
  });
});

describe('ServiceBindingCrawlerExecutionClient', () => {
  it('calls runCrawler with the context and checks the outcome', async () => {
    const binding = { runCrawler: vi.fn(async () => completed({ ok: true }, [entry('x')])) };
    const client = new ServiceBindingCrawlerExecutionClient(binding as unknown as Service);

    await expect(client.run(CRAWLER_ID, { a: 1 }, { userUUID: USER_UUID, runID: RUN_ID })).resolves.toEqual(completed({ ok: true }, [entry('x')]));
    expect(binding.runCrawler).toHaveBeenCalledWith(CRAWLER_ID, { a: 1 }, { userUUID: USER_UUID, runID: RUN_ID });
  });

  it('throws Invalid CrawlerRunOutcome for an answer of another shape, which the manual run answers with 502', async () => {
    const binding = { runCrawler: vi.fn(async () => ({ type: 'data', result: 'old shape' })) };
    const client = new ServiceBindingCrawlerExecutionClient(binding as unknown as Service);

    const error = await client.run(CRAWLER_ID, {}, { userUUID: USER_UUID, runID: RUN_ID }).catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Invalid CrawlerRunOutcome:/);
    expect(resolveHTTPStatus('failed', (error as Error).message)).toBe(502);
  });
});

describe('resolveHTTPStatus', () => {
  it('answers what it answered before for the errors of failed stages', () => {
    expect(resolveHTTPStatus('failed', 'CodeRunner error 422: [execution_failed] boom')).toBe(502);
    expect(resolveHTTPStatus('failed', 'CodeRunner error 422: [execution_timeout] Code execution timed out after 300000ms')).toBe(408);
    expect(resolveHTTPStatus('failed', 'CodeRunner error 422: [execution_timeout] Code execution timed out: CPU time limit of 30000ms exceeded')).toBe(408);
    expect(resolveHTTPStatus('failed', `Crawler ${CRAWLER_ID}: no URL available. Provide url in input or set a default in input_schema.`)).toBe(500);
    expect(resolveHTTPStatus('failed', 'Invalid CrawlerExecuteResult: expected object')).toBe(502);
    expect(resolveHTTPStatus('failed', 'Invalid CrawlerRunOutcome: expected object')).toBe(502);
    expect(resolveHTTPStatus('failed', 'Environment variables could not be read: vault responded 503 vault_unavailable')).toBe(500);
  });
});

describe('limitCrawlerLogs', () => {
  it('keeps logs within the limits as they are', () => {
    const logs = [entry('a'), { ...entry('b'), item_index: 3 }];

    expect(limitCrawlerLogs(logs)).toEqual({ logs, truncated: false });
  });

  it('drops an entry with no room left for its message', () => {
    const logs = Array.from({ length: 65 }, () => entry('y'.repeat(960)));

    const { logs: limited, truncated } = limitCrawlerLogs(logs);

    expect(limited).toHaveLength(64);
    expect(truncated).toBe(true);
  });

  it('does not split a surrogate pair when it cuts', () => {
    // The first entry costs 65,469, leaving 3 code units for the second message: a cut there would
    // split the second emoji, so the cut keeps the first one only
    const { logs, truncated } = limitCrawlerLogs([entry('z'.repeat(65_405)), entry('😀😀')]);

    expect(logs).toHaveLength(2);
    expect(logs[1].message).toBe('😀');
    expect(truncated).toBe(true);
  });
});

describe('GET /schedulers/:id/runs/:runID/stage-runs/:stageRunID', () => {
  async function get(path: string, userUUID = USER_UUID) {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({ sub: userUUID, iat: now, exp: now + 86400 }, JWT_SECRET);
    const response = await SELF.fetch(`https://worker.example.com${path}`, {
      headers: { Origin: 'https://example.com', Authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  function seedStageRuns() {
    seedScheduler('completed');
    supabase.tables.schedulers.push({ ...supabase.tables.schedulers[0], id: OTHER_SCHEDULER_ID });
    supabase.tables.scheduler_runs.push({ ...supabase.tables.scheduler_runs[0], id: OTHER_RUN_ID });
    const stageRun = {
      id: '00000000-0000-0000-0000-000000000050',
      run_id: RUN_ID,
      stage_id: STAGE_ID,
      stage_order: 0,
      status: 'completed',
      started_at: '2026-10-13T00:00:00Z',
      completed_at: '2026-10-13T00:00:01Z',
      input: { url: 'https://example.com' },
      output: { title: 'A' },
      error: null,
      items_total: null,
      items_succeeded: null,
      items_failed: null,
      task_group_id: null,
      task_group_version: null,
      progress: null,
      logs: [entry('fetched')],
      logs_truncated: false,
      created_at: '2026-10-13T00:00:00Z',
    };
    supabase.tables.scheduler_stage_runs = [stageRun, { ...stageRun, id: '00000000-0000-0000-0000-000000000051', run_id: OTHER_RUN_ID }];
    return stageRun;
  }

  it('answers the whole stage run, input, output and logs included, to the owner', async () => {
    const stageRun = seedStageRuns();

    const response = await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${stageRun.id}`);

    expect(response).toEqual({ status: 200, body: stageRun });
  });

  it('answers 404 to another user', async () => {
    const stageRun = seedStageRuns();

    const response = await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${stageRun.id}`, OTHER_USER_UUID);

    expect(response).toEqual({ status: 404, body: { error: 'not_found', error_description: 'Scheduler not found' } });
  });

  it('answers 404 Stage run not found for a stage run of another run', async () => {
    seedStageRuns();

    const response = await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/00000000-0000-0000-0000-000000000051`);

    expect(response).toEqual({ status: 404, body: { error: 'not_found', error_description: 'Stage run not found' } });
  });

  it('answers 404 for a run of another scheduler', async () => {
    seedStageRuns();

    const response = await get(`/schedulers/${OTHER_SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/00000000-0000-0000-0000-000000000050`);

    expect(response.status).toBe(404);
    expect(supabase.requestsOf('GET', 'scheduler_stage_runs')).toEqual([]);
  });

  it('answers 404 for an ID that is not a UUID', async () => {
    seedStageRuns();

    expect((await get(`/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/not-a-uuid`)).status).toBe(404);
  });
});

describe('GET /schedulers/:id/runs/:runID', () => {
  it('summarizes the stage runs with logs_truncated and without logs', async () => {
    seedScheduler('completed');
    supabase.tables.scheduler_stage_runs = [{
      id: '00000000-0000-0000-0000-000000000050',
      run_id: RUN_ID,
      stage_id: STAGE_ID,
      stage_order: 0,
      status: 'completed',
      input: { a: 1 },
      output: { b: 2 },
      logs: [entry('x')],
      logs_truncated: true,
      progress: null,
      created_at: '2026-10-13T00:00:00Z',
    }];
    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({ sub: USER_UUID, iat: now, exp: now + 86400 }, JWT_SECRET);

    const response = await SELF.fetch(`https://worker.example.com/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}`, {
      headers: { Origin: 'https://example.com', Authorization: `Bearer ${token}` },
    });

    const body = await response.json() as { stage_runs: Record<string, unknown>[] };
    expect(response.status).toBe(200);
    expect(body.stage_runs).toHaveLength(1);
    expect(body.stage_runs[0]).toMatchObject({ id: '00000000-0000-0000-0000-000000000050', logs_truncated: true });
    expect(body.stage_runs[0]).not.toHaveProperty('logs');
    expect(body.stage_runs[0]).not.toHaveProperty('input');
    expect(body.stage_runs[0]).not.toHaveProperty('output');
  });
});
