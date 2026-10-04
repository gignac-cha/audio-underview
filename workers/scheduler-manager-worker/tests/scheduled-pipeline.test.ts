import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import type { CrawlerExecutionClient } from '../sources/crawler-execution-client.ts';
import type { ExecutorDependencies } from '../sources/scheduler-executor.ts';
import { runScheduledPipeline } from '../sources/scheduled-pipeline.ts';
import type { ScheduledPipelineStep } from '../sources/scheduled-pipeline.ts';

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const STAGE_ID = '00000000-0000-0000-0000-000000000020';
const STAGE_ID_2 = '00000000-0000-0000-0000-000000000021';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const CRAWLER_ID_2 = '00000000-0000-0000-0000-000000000031';
const EXISTING_RUN_ID = '00000000-0000-0000-0000-000000000040';
const SCHEDULED_FOR = '2026-10-05T22:00:00.000Z';

const RECORD_STEP_OPTIONS = {
  retries: { limit: 5, delay: '3 seconds', backoff: 'exponential' },
  timeout: '1 minute',
};
const EXECUTE_STEP_OPTIONS = {
  retries: { limit: 0, delay: 0 },
  timeout: '15 minutes',
};

const ACTIVE_RUN_INDEX = 'scheduler_runs_one_active_per_scheduler';
const OCCURRENCE_INDEX = 'scheduler_runs_scheduled_occurrence_unique_index';

type Row = Record<string, unknown>;

function schedulerRow(overrides: Row = {}): Row {
  return {
    id: SCHEDULER_ID,
    user_uuid: USER_UUID,
    name: 'Test Scheduler',
    cron_expression: '0 7 * * *',
    timezone: 'Asia/Seoul',
    is_enabled: true,
    last_run_at: null,
    next_run_at: '2026-10-06T22:00:00.000Z',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function stageRow(overrides: Row = {}): Row {
  return {
    id: STAGE_ID,
    scheduler_id: SCHEDULER_ID,
    crawler_id: CRAWLER_ID,
    stage_order: 0,
    input_schema: { url: { type: 'string', default: 'https://example.com' } },
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function runRow(overrides: Row = {}): Row {
  return {
    id: EXISTING_RUN_ID,
    scheduler_id: SCHEDULER_ID,
    status: 'running',
    started_at: '2026-10-05T21:55:00.000Z',
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-05T21:55:00.000Z',
    ...overrides,
  };
}

// --- Fake Supabase: a small in-memory PostgREST behind fetchMock ---

interface FakeDatabase {
  schedulers: Row[];
  scheduler_stages: Row[];
  scheduler_runs: Row[];
  scheduler_stage_runs: Row[];
  /** Runs before a row is inserted into scheduler_runs, to simulate a concurrent writer or a failure */
  beforeInsertRun?: (row: Row) => { statusCode: number; data: unknown } | undefined;
}

interface SupabaseRequest {
  method: string;
  table: keyof Omit<FakeDatabase, 'beforeInsertRun'>;
  query: URLSearchParams;
  body: Row | undefined;
  /** The step whose callback was running when the request was made */
  step: string | null;
}

let database: FakeDatabase;
let supabaseRequests: SupabaseRequest[];
let nextRowNumber: number;
let activeStep: string | null;

const NON_FILTER_PARAMETERS = new Set(['select', 'order', 'limit', 'offset', 'columns']);
const ACTIVE_STATUSES = ['pending', 'running'];

function matchesFilters(row: Row, query: URLSearchParams): boolean {
  for (const [column, filter] of query) {
    if (NON_FILTER_PARAMETERS.has(column)) continue;
    const separatorIndex = filter.indexOf('.');
    const operator = filter.slice(0, separatorIndex);
    const operand = filter.slice(separatorIndex + 1);
    const value = row[column];
    if (operator === 'eq') {
      if (String(value) !== operand) return false;
    } else if (operator === 'is' && operand === 'null') {
      if (value !== null && value !== undefined) return false;
    } else if (operator === 'in') {
      if (!operand.slice(1, -1).split(',').includes(String(value))) return false;
    } else {
      throw new Error(`Fake Supabase does not support the filter ${column}=${filter}`);
    }
  }
  return true;
}

function sortRows(rows: Row[], order: string | null): Row[] {
  if (order === null) return rows;
  const [column, direction] = order.split('.');
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => (Number(left[column]) - Number(right[column])) * sign);
}

function createRowID(): string {
  return `00000000-0000-0000-0000-${String(nextRowNumber++).padStart(12, '0')}`;
}

function duplicateKeyError(index: string) {
  return {
    statusCode: 409,
    data: { code: '23505', details: null, hint: null, message: `duplicate key value violates unique constraint "${index}"` },
  };
}

function insertRow(table: SupabaseRequest['table'], body: Row): { statusCode: number; data: unknown } {
  const now = new Date().toISOString();

  if (table === 'scheduler_runs') {
    const injected = database.beforeInsertRun?.(body);
    if (injected !== undefined) return injected;

    const row: Row = {
      id: createRowID(),
      status: 'pending',
      started_at: null,
      completed_at: null,
      result: null,
      error: null,
      triggered_by: 'manual',
      scheduled_for: null,
      created_at: now,
      ...body,
    };
    const runs = database.scheduler_runs;
    if (row.scheduled_for !== null && runs.some((run) => run.scheduler_id === row.scheduler_id && run.scheduled_for === row.scheduled_for)) {
      return duplicateKeyError(OCCURRENCE_INDEX);
    }
    if (ACTIVE_STATUSES.includes(String(row.status)) && runs.some((run) => run.scheduler_id === row.scheduler_id && ACTIVE_STATUSES.includes(String(run.status)))) {
      return duplicateKeyError(ACTIVE_RUN_INDEX);
    }
    runs.push(row);
    return { statusCode: 201, data: row };
  }

  if (table === 'scheduler_stage_runs') {
    const row: Row = {
      id: createRowID(),
      status: 'pending',
      started_at: null,
      completed_at: null,
      input: null,
      output: null,
      error: null,
      items_total: null,
      items_succeeded: null,
      items_failed: null,
      created_at: now,
      ...body,
    };
    database.scheduler_stage_runs.push(row);
    return { statusCode: 201, data: row };
  }

  throw new Error(`Fake Supabase does not insert into ${table}`);
}

function handleSupabaseRequest(method: string, path: string, rawBody: string): { statusCode: number; data: unknown } {
  const url = new URL(path, SUPABASE_ORIGIN);
  const table = url.pathname.replace('/rest/v1/', '') as SupabaseRequest['table'];
  const body = rawBody === '' ? undefined : JSON.parse(rawBody) as Row;
  supabaseRequests.push({ method, table, query: url.searchParams, body, step: activeStep });

  const rows = database[table];

  if (method === 'GET') {
    // Every GET in this flow is a list or a maybeSingle, both of which read an array
    return { statusCode: 200, data: sortRows(rows.filter((row) => matchesFilters(row, url.searchParams)), url.searchParams.get('order')) };
  }

  if (method === 'POST') {
    return insertRow(table, body ?? {});
  }

  if (method === 'PATCH') {
    // Every PATCH in this flow ends with .select().single()
    const matched = rows.filter((row) => matchesFilters(row, url.searchParams));
    if (matched.length !== 1) {
      return {
        statusCode: 406,
        data: { code: 'PGRST116', details: `The result contains ${matched.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' },
      };
    }
    Object.assign(matched[0], body);
    return { statusCode: 200, data: matched[0] };
  }

  throw new Error(`Fake Supabase does not support ${method}`);
}

function requestsOf(method: string, table: SupabaseRequest['table']): SupabaseRequest[] {
  return supabaseRequests.filter((request) => request.method === method && request.table === table);
}

function findRun(id: string): Row | undefined {
  return database.scheduler_runs.find((run) => run.id === id);
}

// --- Fake Workflow step: calls the callback at once and records every call ---

interface RecordedStep {
  name: string;
  options: WorkflowStepConfig;
  result?: unknown;
}

interface FakeStepOptions {
  /** Steps that fail on their own, for example by timing out, without running their callback */
  throwingSteps?: Record<string, Error>;
  /** Runs before a step's callback */
  beforeStep?: (name: string) => void;
}

function createFakeStep(options: FakeStepOptions = {}): ScheduledPipelineStep & { steps: RecordedStep[] } {
  const steps: RecordedStep[] = [];
  return {
    steps,
    async do<T>(name: string, stepOptions: WorkflowStepConfig, callback: () => Promise<T>): Promise<T> {
      const recorded: RecordedStep = { name, options: stepOptions };
      steps.push(recorded);

      const error = options.throwingSteps?.[name];
      if (error !== undefined) throw error;
      options.beforeStep?.(name);

      activeStep = name;
      try {
        const result = await callback();
        recorded.result = result;
        return result;
      } finally {
        activeStep = null;
      }
    },
  };
}

function stepNames(step: { steps: RecordedStep[] }): string[] {
  return step.steps.map((recorded) => recorded.name);
}

function stepResult(step: { steps: RecordedStep[] }, name: string): unknown {
  return step.steps.find((recorded) => recorded.name === name)?.result;
}

// --- Dependencies ---

function createCrawlerExecutionClient(): CrawlerExecutionClient & { execute: ReturnType<typeof vi.fn>; steps: (string | null)[] } {
  const steps: (string | null)[] = [];
  const execute = vi.fn();
  return {
    steps,
    execute: execute.mockImplementation(async () => {
      steps.push(activeStep);
      return { type: 'data' as const, result: { extracted: 'data' } };
    }),
  };
}

function respondWith(crawlerExecutionClient: ReturnType<typeof createCrawlerExecutionClient>, ...results: (unknown | Error)[]) {
  for (const result of results) {
    crawlerExecutionClient.execute.mockImplementationOnce(async () => {
      crawlerExecutionClient.steps.push(activeStep);
      if (result instanceof Error) throw result;
      return { type: 'data' as const, result };
    });
  }
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    createChild: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function createDependencies(): {
  dependencies: ExecutorDependencies;
  crawlerExecutionClient: ReturnType<typeof createCrawlerExecutionClient>;
} {
  const crawlerExecutionClient = createCrawlerExecutionClient();
  const supabaseClient = createSupabaseClient({
    supabaseURL: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
  });
  return {
    dependencies: { supabaseClient, crawlerExecutionClient, logger: createMockLogger() },
    crawlerExecutionClient,
  };
}

const parameters = { schedulerID: SCHEDULER_ID, scheduledFor: SCHEDULED_FOR };

const twoStages = [
  stageRow({ id: STAGE_ID, crawler_id: CRAWLER_ID, stage_order: 0 }),
  stageRow({ id: STAGE_ID_2, crawler_id: CRAWLER_ID_2, stage_order: 1, input_schema: {} }),
];

// The interceptors persist, so they match only while this file runs
let fakeSupabaseEnabled = false;

beforeAll(() => {
  fakeSupabaseEnabled = true;
  // Registered once for the file: every handler reads the database of the current test
  for (const method of ['GET', 'POST', 'PATCH']) {
    fetchMock
      .get(SUPABASE_ORIGIN)
      .intercept({ path: (path: string) => fakeSupabaseEnabled && path.startsWith('/rest/v1/'), method })
      .reply((options) => {
        const { statusCode, data } = handleSupabaseRequest(method, String(options.path), String(options.body ?? ''));
        return { statusCode, data: JSON.stringify(data) };
      })
      .persist();
  }
});

beforeEach(() => {
  database = {
    schedulers: [schedulerRow()],
    scheduler_stages: [],
    scheduler_runs: [],
    scheduler_stage_runs: [],
  };
  supabaseRequests = [];
  nextRowNumber = 1000;
  activeStep = null;
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
});

afterAll(() => {
  fakeSupabaseEnabled = false;
});

describe('runScheduledPipeline', () => {
  describe('begin-run', () => {
    it.each([
      ['does not exist', []],
      ['is disabled', [schedulerRow({ is_enabled: false })]],
      ['has no cron expression', [schedulerRow({ cron_expression: null })]],
    ])('cancels without creating a run when the scheduler %s', async (_, schedulers) => {
      database.schedulers = schedulers;
      database.scheduler_stages = twoStages;
      const { dependencies, crawlerExecutionClient } = createDependencies();
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(result).toEqual({ outcome: 'cancelled' });
      expect(stepNames(step)).toEqual(['begin-run']);
      expect(requestsOf('POST', 'scheduler_runs')).toHaveLength(0);
      expect(database.scheduler_runs).toHaveLength(0);
      expect(crawlerExecutionClient.execute).not.toHaveBeenCalled();
    });

    it('records a skipped run and runs no stage while a previous run is in progress', async () => {
      const activeRun = runRow({ status: 'running', triggered_by: 'manual' });
      database.scheduler_runs = [activeRun];
      database.scheduler_stages = twoStages;
      const { dependencies, crawlerExecutionClient } = createDependencies();
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(result).toEqual({ outcome: 'skipped' });
      expect(stepNames(step)).toEqual(['begin-run']);
      expect(crawlerExecutionClient.execute).not.toHaveBeenCalled();

      const inserts = requestsOf('POST', 'scheduler_runs');
      expect(inserts).toHaveLength(2);
      expect(inserts[0].body).toEqual({
        scheduler_id: SCHEDULER_ID,
        status: 'running',
        started_at: expect.any(String),
        triggered_by: 'schedule',
        scheduled_for: SCHEDULED_FOR,
      });
      expect(inserts[1].body).toEqual({
        scheduler_id: SCHEDULER_ID,
        status: 'skipped',
        triggered_by: 'schedule',
        scheduled_for: SCHEDULED_FOR,
        completed_at: expect.any(String),
        error: 'A previous run was still in progress',
      });

      expect(database.scheduler_runs).toHaveLength(2);
      expect(database.scheduler_runs[1]).toMatchObject({
        status: 'skipped',
        triggered_by: 'schedule',
        scheduled_for: SCHEDULED_FOR,
        error: 'A previous run was still in progress',
      });
      // The run in progress is not touched
      expect(findRun(EXISTING_RUN_ID)).toEqual(runRow({ status: 'running', triggered_by: 'manual' }));
      expect(requestsOf('PATCH', 'scheduler_runs')).toHaveLength(0);
      expect(requestsOf('PATCH', 'schedulers')).toHaveLength(0);
    });

    it('continues the running run of the same occurrence without creating a new one', async () => {
      database.scheduler_runs = [runRow({ status: 'running', triggered_by: 'schedule', scheduled_for: SCHEDULED_FOR })];
      database.scheduler_stages = [stageRow()];
      const { dependencies, crawlerExecutionClient } = createDependencies();
      respondWith(crawlerExecutionClient, { title: 'continued' });
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(result).toEqual({ outcome: 'started', runID: EXISTING_RUN_ID, status: 'completed' });
      expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'finish-run']);
      expect(requestsOf('POST', 'scheduler_runs')).toHaveLength(0);
      expect(database.scheduler_runs).toHaveLength(1);
      expect(findRun(EXISTING_RUN_ID)).toMatchObject({ status: 'completed', result: { title: 'continued' } });
      expect(database.scheduler_stage_runs[0]).toMatchObject({ run_id: EXISTING_RUN_ID });
    });

    it.each([
      ['completed', { outcome: 'finished' }],
      ['failed', { outcome: 'finished' }],
      ['skipped', { outcome: 'skipped' }],
    ])('does not run again when the run of the same occurrence is %s', async (status, expected) => {
      database.scheduler_runs = [runRow({ status, triggered_by: 'schedule', scheduled_for: SCHEDULED_FOR })];
      database.scheduler_stages = twoStages;
      const { dependencies, crawlerExecutionClient } = createDependencies();
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(result).toEqual(expected);
      expect(stepNames(step)).toEqual(['begin-run']);
      expect(requestsOf('POST', 'scheduler_runs')).toHaveLength(0);
      expect(requestsOf('PATCH', 'scheduler_runs')).toHaveLength(0);
      expect(crawlerExecutionClient.execute).not.toHaveBeenCalled();
    });

    it('picks up the run another attempt created between the check and the insert', async () => {
      database.scheduler_stages = [stageRow()];
      database.beforeInsertRun = (row) => {
        // Another instance of the same occurrence inserts first
        database.beforeInsertRun = undefined;
        database.scheduler_runs.push(runRow({ status: 'running', triggered_by: 'schedule', scheduled_for: row.scheduled_for }));
        return duplicateKeyError(OCCURRENCE_INDEX);
      };
      const { dependencies } = createDependencies();
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(result).toEqual({ outcome: 'started', runID: EXISTING_RUN_ID, status: 'completed' });
      expect(requestsOf('POST', 'scheduler_runs')).toHaveLength(1);
      expect(database.scheduler_runs).toHaveLength(1);
    });

    it('throws the insert error when no run exists and the error is not about a run in progress', async () => {
      database.scheduler_stages = [stageRow()];
      database.beforeInsertRun = () => ({ statusCode: 500, data: { message: 'connection reset' } });
      const { dependencies, crawlerExecutionClient } = createDependencies();
      const step = createFakeStep();

      await expect(runScheduledPipeline(dependencies, parameters, step)).rejects.toThrow(
        'Failed to create scheduler run: connection reset',
      );
      expect(stepNames(step)).toEqual(['begin-run']);
      expect(crawlerExecutionClient.execute).not.toHaveBeenCalled();
    });
  });

  describe('stages', () => {
    it('runs every stage in its own step, chains outputs through the database and completes the run', async () => {
      database.scheduler_stages = twoStages;
      const { dependencies, crawlerExecutionClient } = createDependencies();
      respondWith(crawlerExecutionClient, { urls: ['https://a.com', 'https://b.com'] }, { titles: ['A', 'B'] });
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-1', 'finish-run']);

      // The first stage gets the default input; the second gets the first stage run's output
      expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(2);
      expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(1, CRAWLER_ID, { url: 'https://example.com' });
      expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(2, CRAWLER_ID_2, { urls: ['https://a.com', 'https://b.com'] });

      const run = database.scheduler_runs[0];
      expect(result).toEqual({ outcome: 'started', runID: run.id, status: 'completed' });
      expect(run).toMatchObject({
        scheduler_id: SCHEDULER_ID,
        status: 'completed',
        triggered_by: 'schedule',
        scheduled_for: SCHEDULED_FOR,
        result: { titles: ['A', 'B'] },
        error: null,
      });
      expect(run.started_at).toEqual(expect.any(String));
      expect(run.completed_at).toEqual(expect.any(String));

      // The run is closed only while it is still active
      const runUpdates = requestsOf('PATCH', 'scheduler_runs');
      expect(runUpdates).toHaveLength(1);
      expect(runUpdates[0].query.get('status')).toBe('in.(pending,running)');

      // last_run_at is updated for the scheduler's owner
      const schedulerUpdates = requestsOf('PATCH', 'schedulers');
      expect(schedulerUpdates).toHaveLength(1);
      expect(schedulerUpdates[0].query.get('id')).toBe(`eq.${SCHEDULER_ID}`);
      expect(schedulerUpdates[0].query.get('user_uuid')).toBe(`eq.${USER_UUID}`);
      expect(schedulerUpdates[0].body).toEqual({ last_run_at: expect.any(String) });
      expect(database.schedulers[0].last_run_at).toEqual(expect.any(String));
    });

    it('uses the execute options for stage steps and the record options for the others', async () => {
      database.scheduler_stages = twoStages;
      const { dependencies } = createDependencies();
      const step = createFakeStep();

      await runScheduledPipeline(dependencies, parameters, step);

      expect(step.steps.map(({ name, options }) => ({ name, options }))).toEqual([
        { name: 'begin-run', options: RECORD_STEP_OPTIONS },
        { name: 'load-stages', options: RECORD_STEP_OPTIONS },
        { name: 'stage-0', options: EXECUTE_STEP_OPTIONS },
        { name: 'stage-1', options: EXECUTE_STEP_OPTIONS },
        { name: 'finish-run', options: RECORD_STEP_OPTIONS },
      ]);
    });

    it('fails the run without running the second stage when the first stage fails', async () => {
      database.scheduler_stages = twoStages;
      const { dependencies, crawlerExecutionClient } = createDependencies();
      respondWith(crawlerExecutionClient, new Error('crawler exploded'));
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'finish-run']);
      expect(stepResult(step, 'stage-0')).toEqual({ status: 'failed', error: 'crawler exploded' });
      expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(1);

      const run = database.scheduler_runs[0];
      expect(result).toEqual({ outcome: 'started', runID: run.id, status: 'failed' });
      expect(run).toMatchObject({ status: 'failed', error: 'crawler exploded', result: null });
      expect(run.completed_at).toEqual(expect.any(String));
      expect(database.scheduler_stage_runs).toHaveLength(1);
      expect(database.scheduler_stage_runs[0]).toMatchObject({ status: 'failed', error: 'crawler exploded' });
      expect(database.schedulers[0].last_run_at).toEqual(expect.any(String));
    });

    it('gives a partially failed run when a fan-out partly fails', async () => {
      database.scheduler_stages = [
        stageRow({ id: STAGE_ID, stage_order: 0 }),
        stageRow({ id: STAGE_ID_2, crawler_id: CRAWLER_ID_2, stage_order: 1, fan_out_field: 'items', input_schema: {} }),
      ];
      const { dependencies, crawlerExecutionClient } = createDependencies();
      respondWith(crawlerExecutionClient, { items: ['a', 'b'] }, 'ok-a', new Error('item b failed'));
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-1', 'finish-run']);
      expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(2, CRAWLER_ID_2, 'a');
      expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(3, CRAWLER_ID_2, 'b');
      expect(stepResult(step, 'stage-1')).toEqual({ status: 'partially_failed', stageRunID: expect.any(String) });

      const run = database.scheduler_runs[0];
      expect(result).toEqual({ outcome: 'started', runID: run.id, status: 'partially_failed' });
      expect(run).toMatchObject({ status: 'partially_failed', result: ['ok-a'], error: null });
    });

    it('completes the run with a null result when there are no stages', async () => {
      const { dependencies, crawlerExecutionClient } = createDependencies();
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'finish-run']);
      expect(crawlerExecutionClient.execute).not.toHaveBeenCalled();

      const run = database.scheduler_runs[0];
      expect(result).toEqual({ outcome: 'started', runID: run.id, status: 'completed' });
      expect(run).toMatchObject({ status: 'completed', result: null, error: null });
      expect(requestsOf('PATCH', 'scheduler_runs')[0].body).toEqual({
        status: 'completed',
        completed_at: expect.any(String),
        result: null,
      });
      expect(database.schedulers[0].last_run_at).toEqual(expect.any(String));
    });

    it('fails the run in finish-run when a stage step itself throws, for example on a timeout', async () => {
      database.scheduler_stages = twoStages;
      const { dependencies, crawlerExecutionClient } = createDependencies();
      const step = createFakeStep({ throwingSteps: { 'stage-0': new Error('Step stage-0 timed out') } });

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'finish-run']);
      expect(crawlerExecutionClient.execute).not.toHaveBeenCalled();

      const run = database.scheduler_runs[0];
      expect(result).toEqual({ outcome: 'started', runID: run.id, status: 'failed' });
      expect(run).toMatchObject({ status: 'failed', error: 'Step stage-0 timed out' });
      expect(stepResult(step, 'finish-run')).toEqual({ status: 'failed' });
      expect(database.schedulers[0].last_run_at).toEqual(expect.any(String));
    });

    it('fails the run when the output of the previous stage run cannot be read', async () => {
      database.scheduler_stages = twoStages;
      const { dependencies, crawlerExecutionClient } = createDependencies();
      respondWith(crawlerExecutionClient, { urls: [] });
      // The first stage run disappears before the second stage reads it
      const step = createFakeStep({
        beforeStep: (name) => {
          if (name === 'stage-1') database.scheduler_stage_runs = [];
        },
      });

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(stepResult(step, 'stage-1')).toEqual({ status: 'failed', error: 'Stage 1: previous stage output not found' });
      expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
      expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error: 'Stage 1: previous stage output not found' });
    });
  });

  describe('step boundaries', () => {
    it('puts no stage output in any step result', async () => {
      database.scheduler_stages = [
        stageRow({ id: STAGE_ID, stage_order: 0 }),
        stageRow({ id: STAGE_ID_2, crawler_id: CRAWLER_ID_2, stage_order: 1, fan_out_field: 'items', input_schema: {} }),
      ];
      const { dependencies, crawlerExecutionClient } = createDependencies();
      respondWith(crawlerExecutionClient, { items: ['first-stage-output-a'] }, { marker: 'second-stage-output' });
      const step = createFakeStep();

      await runScheduledPipeline(dependencies, parameters, step);

      expect(database.scheduler_runs[0]).toMatchObject({ status: 'completed', result: [{ marker: 'second-stage-output' }] });
      expect(step.steps).toHaveLength(5);
      for (const recorded of step.steps) {
        const serialized = JSON.stringify(recorded.result);
        expect(serialized).not.toContain('first-stage-output');
        expect(serialized).not.toContain('second-stage-output');
      }
    });

    it('makes every database request and crawler call inside a step', async () => {
      database.scheduler_stages = twoStages;
      const { dependencies, crawlerExecutionClient } = createDependencies();
      const step = createFakeStep();

      await runScheduledPipeline(dependencies, parameters, step);

      expect(supabaseRequests.length).toBeGreaterThan(0);
      expect(supabaseRequests.filter((request) => request.step === null)).toEqual([]);
      expect(crawlerExecutionClient.steps).toEqual(['stage-0', 'stage-1']);
    });
  });
});
