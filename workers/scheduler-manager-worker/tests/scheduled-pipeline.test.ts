import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import type { CrawlerExecutionClient } from '../sources/crawler-execution-client.ts';
import { runScheduledPipeline } from '../sources/scheduled-pipeline.ts';
import type { ScheduledPipelineDependencies, ScheduledPipelineStep } from '../sources/scheduled-pipeline.ts';
import type { TaskGroupStartRequest, TaskGroupWorker } from '../sources/task-group-worker.ts';
import { completeTaskGroupRun, failTaskGroupRun } from '../sources/task-group-reports.ts';

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
  task_groups: Row[];
  /** Runs before a row is inserted into scheduler_runs, to simulate a concurrent writer or a failure */
  beforeInsertRun?: (row: Row) => { statusCode: number; data: unknown } | undefined;
  /** Runs before an update of scheduler_stage_runs is applied, to simulate a report arriving in between */
  beforeUpdateStageRuns?: (query: URLSearchParams) => void;
}

interface SupabaseRequest {
  method: string;
  table: keyof Omit<FakeDatabase, 'beforeInsertRun' | 'beforeUpdateStageRuns'>;
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

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function sortRows(rows: Row[], order: string | null): Row[] {
  if (order === null) return rows;
  const [column, direction] = order.split('.');
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => compareValues(left[column], right[column]) * sign);
}

function limitRows(rows: Row[], limit: string | null): Row[] {
  return limit === null ? rows : rows.slice(0, Number(limit));
}

// .single() asks PostgREST for one object; a list, or a maybeSingle on a GET, asks for an array
function asksForSingleObject(headers: unknown): boolean {
  let entries: [string, string][];
  if (headers instanceof Headers) {
    entries = [...headers.entries()];
  } else if (Array.isArray(headers)) {
    entries = [];
    for (let index = 0; index + 1 < headers.length; index += 2) {
      entries.push([String(headers[index]), String(headers[index + 1])]);
    }
  } else {
    entries = Object.entries((headers ?? {}) as Record<string, string>);
  }
  return entries.some(([name, value]) => name.toLowerCase() === 'accept' && value.includes('vnd.pgrst.object'));
}

function noSingleRowError(rowCount: number) {
  return {
    statusCode: 406,
    data: { code: 'PGRST116', details: `The result contains ${rowCount} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' },
  };
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
      task_group_id: null,
      task_group_version: null,
      progress: null,
      created_at: now,
      ...body,
    };
    database.scheduler_stage_runs.push(row);
    return { statusCode: 201, data: row };
  }

  throw new Error(`Fake Supabase does not insert into ${table}`);
}

function handleSupabaseRequest(method: string, path: string, rawBody: string, headers: unknown): { statusCode: number; data: unknown } {
  const url = new URL(path, SUPABASE_ORIGIN);
  const table = url.pathname.replace('/rest/v1/', '') as SupabaseRequest['table'];
  const body = rawBody === '' ? undefined : JSON.parse(rawBody) as Row;
  supabaseRequests.push({ method, table, query: url.searchParams, body, step: activeStep });

  const rows = database[table];
  const single = asksForSingleObject(headers);

  if (method === 'GET') {
    const matched = limitRows(
      sortRows(rows.filter((row) => matchesFilters(row, url.searchParams)), url.searchParams.get('order')),
      url.searchParams.get('limit'),
    );
    if (single) {
      return matched.length === 1 ? { statusCode: 200, data: matched[0] } : noSingleRowError(matched.length);
    }
    // A list or a maybeSingle, both of which read an array
    return { statusCode: 200, data: matched };
  }

  if (method === 'POST') {
    return insertRow(table, body ?? {});
  }

  if (method === 'PATCH') {
    if (table === 'scheduler_stage_runs') database.beforeUpdateStageRuns?.(url.searchParams);
    const matched = rows.filter((row) => matchesFilters(row, url.searchParams));
    // .select().single() changes exactly one row; failActiveSchedulerStageRuns changes any number, none included
    if (single && matched.length !== 1) {
      return noSingleRowError(matched.length);
    }
    for (const row of matched) {
      Object.assign(row, body);
    }
    return { statusCode: 200, data: single ? matched[0] : matched };
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
  /** The options of step.do, or those of step.waitForEvent */
  options: WorkflowStepConfig | WaitForEventOptions;
  result?: unknown;
}

interface WaitForEventOptions {
  type: string;
  timeout: string;
}

interface FakeStepOptions {
  /** Steps that fail on their own, for example by timing out, without running their callback */
  throwingSteps?: Record<string, Error>;
  /** Runs before a step's callback */
  beforeStep?: (name: string) => void;
  /** Stands for the wait: may report to the scheduler, or throw like a timeout. Resolves at once when absent. */
  onWaitForEvent?: (name: string, options: WaitForEventOptions) => Promise<void> | void;
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
    async waitForEvent(name: string, waitOptions: WaitForEventOptions): Promise<unknown> {
      steps.push({ name, options: waitOptions });
      activeStep = name;
      try {
        await options.onWaitForEvent?.(name, waitOptions);
      } finally {
        activeStep = null;
      }
      return { type: waitOptions.type, payload: {}, timestamp: new Date() };
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

function createDependencies(taskGroupWorkers: Record<string, TaskGroupWorker> = {}): {
  dependencies: ScheduledPipelineDependencies;
  crawlerExecutionClient: ReturnType<typeof createCrawlerExecutionClient>;
} {
  const crawlerExecutionClient = createCrawlerExecutionClient();
  const supabaseClient = createSupabaseClient({
    supabaseURL: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
  });
  return {
    dependencies: {
      supabaseClient,
      crawlerExecutionClient,
      logger: createMockLogger(),
      resolveTaskGroupWorker: (binding: string) => taskGroupWorkers[binding],
    },
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
        const { statusCode, data } = handleSupabaseRequest(method, String(options.path), String(options.body ?? ''), options.headers);
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
    task_groups: [],
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

// --- Task group stages ---

const TASK_GROUP_STAGE_ID = '00000000-0000-0000-0000-000000000022';
const STAGE_ID_3 = '00000000-0000-0000-0000-000000000023';
const EXISTING_STAGE_RUN_ID = '00000000-0000-0000-0000-000000000050';
const SCHEDULED_RUN_INSTANCE_ID = `${SCHEDULER_ID}-29853960`;
const TASK_GROUP_START_STEP_OPTIONS = {
  retries: { limit: 0, delay: 0 },
  timeout: '5 minutes',
};

function taskGroupRow(overrides: Row = {}): Row {
  return {
    id: 'newscast',
    version: 1,
    input_schema: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' } } },
      required: ['urls'],
    },
    settings_schema: { type: 'object' },
    output_schema: {
      type: 'object',
      properties: { episode: { type: 'string' } },
      required: ['episode'],
    },
    worker_binding: 'NEWSCAST',
    created_at: '2026-10-04T00:00:00Z',
    ...overrides,
  };
}

// The group's first stage takes {} as its input
const firstStageTaskGroup = taskGroupRow({ input_schema: { type: 'object' } });

function taskGroupStageRow(overrides: Row = {}): Row {
  return stageRow({
    id: TASK_GROUP_STAGE_ID,
    stage_type: 'task_group',
    crawler_id: null,
    task_group_id: 'newscast',
    task_group_version: 1,
    settings: { voice: 'calm' },
    input_schema: {},
    output_schema: {},
    ...overrides,
  });
}

function stageRunRow(overrides: Row = {}): Row {
  return {
    id: EXISTING_STAGE_RUN_ID,
    run_id: EXISTING_RUN_ID,
    stage_id: TASK_GROUP_STAGE_ID,
    stage_order: 0,
    status: 'running',
    started_at: '2026-10-05T22:00:00.000Z',
    completed_at: null,
    input: {},
    output: null,
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    task_group_id: 'newscast',
    task_group_version: 1,
    progress: null,
    created_at: '2026-10-05T22:00:00.000Z',
    ...overrides,
  };
}

function createTaskGroupWorker(implementation: (request: TaskGroupStartRequest) => Promise<void> = async () => {}) {
  return { startTaskGroupRun: vi.fn(implementation) };
}

// The Workflow binding the reports wake instances through
function createReportWorkflow() {
  const events: { instanceID: string; type: string; payload: unknown }[] = [];
  const get = vi.fn(async (instanceID: string) => ({
    id: instanceID,
    sendEvent: async (event: { type: string; payload: unknown }) => {
      events.push({ instanceID, ...event });
    },
  }));
  return { get, events };
}

function reportDependenciesOf(dependencies: ScheduledPipelineDependencies, workflow: ReturnType<typeof createReportWorkflow>) {
  return {
    supabaseClient: dependencies.supabaseClient,
    workflow: workflow as unknown as Pick<Workflow, 'get'>,
    logger: createMockLogger(),
  };
}

function stageRunIDOfEvent(options: WaitForEventOptions): string {
  return options.type.slice('task-group-finished-'.length);
}

// While the run waits, the group reports its output
function completeWhileWaiting(
  dependencies: ScheduledPipelineDependencies,
  workflow: ReturnType<typeof createReportWorkflow>,
  output: unknown,
): FakeStepOptions['onWaitForEvent'] {
  return async (_, options) => {
    await completeTaskGroupRun(reportDependenciesOf(dependencies, workflow), stageRunIDOfEvent(options), output);
  };
}

function findStageRun(stageID: string): Row | undefined {
  return database.scheduler_stage_runs.find((stageRun) => stageRun.stage_id === stageID);
}

describe('runScheduledPipeline with task group stages', () => {
  it('runs a crawler, a task group and a crawler, chaining outputs through the stage runs', async () => {
    database.scheduler_stages = [
      stageRow({ id: STAGE_ID, crawler_id: CRAWLER_ID, stage_order: 0 }),
      taskGroupStageRow({ stage_order: 1 }),
      stageRow({ id: STAGE_ID_3, crawler_id: CRAWLER_ID_2, stage_order: 2, input_schema: {} }),
    ];
    database.task_groups = [taskGroupRow()];
    const worker = createTaskGroupWorker();
    const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: worker });
    respondWith(crawlerExecutionClient, { urls: ['https://a.com'] }, { published: true });
    const workflow = createReportWorkflow();
    const step = createFakeStep({ onWaitForEvent: completeWhileWaiting(dependencies, workflow, { episode: 'group-output' }) });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(stepNames(step)).toEqual([
      'begin-run',
      'load-stages',
      'stage-0',
      'stage-1',
      'stage-1-finished',
      'stage-1-result',
      'stage-2',
      'finish-run',
    ]);

    // The group gets the previous stage's output, the stage's settings and the scheduler's owner
    const groupStageRun = findStageRun(TASK_GROUP_STAGE_ID)!;
    expect(worker.startTaskGroupRun).toHaveBeenCalledTimes(1);
    expect(worker.startTaskGroupRun).toHaveBeenCalledWith({
      stageRunID: groupStageRun.id,
      taskGroupID: 'newscast',
      taskGroupVersion: 1,
      input: { urls: ['https://a.com'] },
      settings: { voice: 'calm' },
      userUUID: USER_UUID,
    });
    expect(groupStageRun).toMatchObject({
      stage_order: 1,
      status: 'completed',
      input: { urls: ['https://a.com'] },
      output: { episode: 'group-output' },
      task_group_id: 'newscast',
      task_group_version: 1,
    });

    // The next stage gets the output the group reported
    expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(2, CRAWLER_ID_2, { episode: 'group-output' });
    expect(workflow.events).toEqual([{
      instanceID: SCHEDULED_RUN_INSTANCE_ID,
      type: `task-group-finished-${groupStageRun.id}`,
      payload: { stageRunID: groupStageRun.id },
    }]);

    const run = database.scheduler_runs[0];
    expect(result).toEqual({ outcome: 'started', runID: run.id, status: 'completed' });
    expect(run).toMatchObject({ status: 'completed', result: { published: true }, error: null });

    // No step result carries the group's output
    for (const recorded of step.steps) {
      expect(JSON.stringify(recorded.result ?? null)).not.toContain('group-output');
    }
  });

  it("stores the group's output as the run result when the group is the last stage", async () => {
    database.scheduler_stages = [
      stageRow({ id: STAGE_ID, crawler_id: CRAWLER_ID, stage_order: 0 }),
      taskGroupStageRow({ stage_order: 1 }),
    ];
    database.task_groups = [taskGroupRow()];
    const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: createTaskGroupWorker() });
    respondWith(crawlerExecutionClient, { urls: ['https://a.com'] });
    const workflow = createReportWorkflow();
    const step = createFakeStep({ onWaitForEvent: completeWhileWaiting(dependencies, workflow, { episode: 'last' }) });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(result).toMatchObject({ outcome: 'started', status: 'completed' });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'completed', result: { episode: 'last' } });
  });

  it('gives the group {} when it is the first stage, and uses the start, wait and record options', async () => {
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0 })];
    database.task_groups = [firstStageTaskGroup];
    const worker = createTaskGroupWorker();
    const { dependencies } = createDependencies({ NEWSCAST: worker });
    const workflow = createReportWorkflow();
    const step = createFakeStep({ onWaitForEvent: completeWhileWaiting(dependencies, workflow, { episode: 'first' }) });

    await runScheduledPipeline(dependencies, parameters, step);

    expect(worker.startTaskGroupRun).toHaveBeenCalledWith(expect.objectContaining({ input: {} }));
    const groupStageRun = findStageRun(TASK_GROUP_STAGE_ID)!;
    expect(groupStageRun).toMatchObject({ input: {}, task_group_id: 'newscast', task_group_version: 1 });

    expect(step.steps.map(({ name, options }) => ({ name, options }))).toEqual([
      { name: 'begin-run', options: RECORD_STEP_OPTIONS },
      { name: 'load-stages', options: RECORD_STEP_OPTIONS },
      { name: 'stage-0', options: TASK_GROUP_START_STEP_OPTIONS },
      { name: 'stage-0-finished', options: { type: `task-group-finished-${groupStageRun.id}`, timeout: '60 minutes' } },
      { name: 'stage-0-result', options: RECORD_STEP_OPTIONS },
      { name: 'finish-run', options: RECORD_STEP_OPTIONS },
    ]);
  });

  it('records a failed stage run without starting the group when the input does not match the input format', async () => {
    database.scheduler_stages = [
      stageRow({ id: STAGE_ID, crawler_id: CRAWLER_ID, stage_order: 0 }),
      taskGroupStageRow({ stage_order: 1 }),
      stageRow({ id: STAGE_ID_3, crawler_id: CRAWLER_ID_2, stage_order: 2, input_schema: {} }),
    ];
    database.task_groups = [taskGroupRow()];
    const worker = createTaskGroupWorker();
    const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: worker });
    respondWith(crawlerExecutionClient, { titles: ['A'] });
    const onWaitForEvent = vi.fn();
    const step = createFakeStep({ onWaitForEvent });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 1: input does not match the task group input format: $.urls is required';
    expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-1', 'finish-run']);
    expect(stepResult(step, 'stage-1')).toEqual({ status: 'failed', error });
    expect(worker.startTaskGroupRun).not.toHaveBeenCalled();
    expect(onWaitForEvent).not.toHaveBeenCalled();
    expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(1);

    expect(findStageRun(TASK_GROUP_STAGE_ID)).toMatchObject({
      status: 'failed',
      error,
      input: { titles: ['A'] },
      task_group_id: 'newscast',
      task_group_version: 1,
      started_at: expect.any(String),
      completed_at: expect.any(String),
    });
    // Created as failed from the start, never as running
    expect(requestsOf('POST', 'scheduler_stage_runs').map((request) => request.body?.status)).toEqual(['running', 'failed']);

    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
  });

  it('fails with a failed stage run when the input format cannot be read', async () => {
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0 })];
    database.task_groups = [taskGroupRow({ input_schema: { type: 'object', oneOf: [] } })];
    const worker = createTaskGroupWorker();
    const { dependencies } = createDependencies({ NEWSCAST: worker });
    const step = createFakeStep();

    await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 0: task group input format cannot be read';
    expect(stepResult(step, 'stage-0')).toEqual({ status: 'failed', error });
    expect(worker.startTaskGroupRun).not.toHaveBeenCalled();
    expect(findStageRun(TASK_GROUP_STAGE_ID)).toMatchObject({ status: 'failed', error });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
  });

  it('fails without a stage run when the task group version is not registered', async () => {
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0, task_group_version: 2 })];
    database.task_groups = [firstStageTaskGroup];
    const worker = createTaskGroupWorker();
    const { dependencies } = createDependencies({ NEWSCAST: worker });
    const step = createFakeStep();

    await runScheduledPipeline(dependencies, parameters, step);

    const error = "Stage 0: task group 'newscast' version 2 is not registered";
    expect(stepResult(step, 'stage-0')).toEqual({ status: 'failed', error });
    expect(worker.startTaskGroupRun).not.toHaveBeenCalled();
    expect(database.scheduler_stage_runs).toHaveLength(0);
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
  });

  it('fails with a failed stage run when the binding of the group worker is missing', async () => {
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0 })];
    database.task_groups = [firstStageTaskGroup];
    const { dependencies } = createDependencies({});
    const onWaitForEvent = vi.fn();
    const step = createFakeStep({ onWaitForEvent });

    await runScheduledPipeline(dependencies, parameters, step);

    const error = "Stage 0: task group worker 'NEWSCAST' is not connected";
    expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'finish-run']);
    expect(stepResult(step, 'stage-0')).toEqual({ status: 'failed', error });
    expect(onWaitForEvent).not.toHaveBeenCalled();
    expect(findStageRun(TASK_GROUP_STAGE_ID)).toMatchObject({
      status: 'failed',
      error,
      task_group_id: 'newscast',
      task_group_version: 1,
    });
    expect(requestsOf('POST', 'scheduler_stage_runs').map((request) => request.body?.status)).toEqual(['failed']);
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
  });

  it('fails the stage run when startTaskGroupRun throws', async () => {
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0 })];
    database.task_groups = [firstStageTaskGroup];
    const worker = createTaskGroupWorker(async () => {
      throw new Error('worker is down');
    });
    const { dependencies } = createDependencies({ NEWSCAST: worker });
    const onWaitForEvent = vi.fn();
    const step = createFakeStep({ onWaitForEvent });

    await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 0: task group could not be started: worker is down';
    expect(stepResult(step, 'stage-0')).toEqual({ status: 'failed', error });
    expect(onWaitForEvent).not.toHaveBeenCalled();
    expect(findStageRun(TASK_GROUP_STAGE_ID)).toMatchObject({ status: 'failed', error, completed_at: expect.any(String) });
    // The stage run was running while the group was called, and is failed only while still running
    const stageRunUpdates = requestsOf('PATCH', 'scheduler_stage_runs').filter((request) => request.step === 'stage-0');
    expect(stageRunUpdates).toHaveLength(1);
    expect(stageRunUpdates[0].query.get('status')).toBe('in.(running)');
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
  });

  it('starts the group again for the running stage run a previous attempt created, without a new stage run', async () => {
    database.scheduler_runs = [runRow({ status: 'running', triggered_by: 'schedule', scheduled_for: SCHEDULED_FOR })];
    // The stage moved to version 2 after the stage run started with version 1
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0, task_group_version: 2 })];
    database.task_groups = [firstStageTaskGroup, taskGroupRow({ version: 2, worker_binding: 'NEWSCAST_TWO' })];
    database.scheduler_stage_runs = [stageRunRow({ input: { from: 'first attempt' } })];
    const worker = createTaskGroupWorker();
    const { dependencies } = createDependencies({ NEWSCAST: worker });
    const workflow = createReportWorkflow();
    const step = createFakeStep({ onWaitForEvent: completeWhileWaiting(dependencies, workflow, { episode: 'again' }) });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(requestsOf('POST', 'scheduler_stage_runs')).toHaveLength(0);
    expect(worker.startTaskGroupRun).toHaveBeenCalledWith({
      stageRunID: EXISTING_STAGE_RUN_ID,
      taskGroupID: 'newscast',
      taskGroupVersion: 1,
      input: { from: 'first attempt' },
      settings: { voice: 'calm' },
      userUUID: USER_UUID,
    });
    expect(stepResult(step, 'stage-0')).toEqual({ status: 'waiting', stageRunID: EXISTING_STAGE_RUN_ID });
    expect(result).toEqual({ outcome: 'started', runID: EXISTING_RUN_ID, status: 'completed' });
    expect(findRun(EXISTING_RUN_ID)).toMatchObject({ status: 'completed', result: { episode: 'again' } });
  });

  it('reads the result without starting the group or waiting when a previous attempt left an ended stage run', async () => {
    database.scheduler_runs = [runRow({ status: 'running', triggered_by: 'schedule', scheduled_for: SCHEDULED_FOR })];
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0 })];
    database.task_groups = [firstStageTaskGroup];
    database.scheduler_stage_runs = [stageRunRow({ status: 'completed', output: { episode: 'earlier' }, completed_at: '2026-10-05T22:30:00.000Z' })];
    const worker = createTaskGroupWorker();
    const { dependencies } = createDependencies({ NEWSCAST: worker });
    const onWaitForEvent = vi.fn();
    const step = createFakeStep({ onWaitForEvent });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-0-result', 'finish-run']);
    expect(stepResult(step, 'stage-0')).toEqual({ status: 'settled', stageRunID: EXISTING_STAGE_RUN_ID });
    expect(worker.startTaskGroupRun).not.toHaveBeenCalled();
    expect(onWaitForEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'started', runID: EXISTING_RUN_ID, status: 'completed' });
    expect(findRun(EXISTING_RUN_ID)).toMatchObject({ status: 'completed', result: { episode: 'earlier' } });
  });

  it('fails the run with the error the group reports', async () => {
    database.scheduler_stages = [
      taskGroupStageRow({ stage_order: 0 }),
      stageRow({ id: STAGE_ID_3, crawler_id: CRAWLER_ID_2, stage_order: 1, input_schema: {} }),
    ];
    database.task_groups = [firstStageTaskGroup];
    const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: createTaskGroupWorker() });
    const workflow = createReportWorkflow();
    const step = createFakeStep({
      onWaitForEvent: async (_, options) => {
        await failTaskGroupRun(reportDependenciesOf(dependencies, workflow), stageRunIDOfEvent(options), 'voice model unavailable');
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 0: task group failed: voice model unavailable';
    expect(stepResult(step, 'stage-0-result')).toEqual({ status: 'failed', error });
    expect(crawlerExecutionClient.execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
  });

  it('fails a stage run still running when the wait times out', async () => {
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0 })];
    database.task_groups = [firstStageTaskGroup];
    const { dependencies } = createDependencies({ NEWSCAST: createTaskGroupWorker() });
    const step = createFakeStep({
      onWaitForEvent: () => {
        throw new Error('Workflow waitForEvent timed out');
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 0: task group did not finish within 60 minutes';
    expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-0-finished', 'stage-0-result', 'finish-run']);
    expect(stepResult(step, 'stage-0-result')).toEqual({ status: 'failed', error });
    expect(findStageRun(TASK_GROUP_STAGE_ID)).toMatchObject({ status: 'failed', error, completed_at: expect.any(String) });
    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      'Task group stage was not reported finished',
      expect.objectContaining({ error: 'Workflow waitForEvent timed out' }),
      { function: 'runScheduledPipeline' },
    );
  });

  it('goes on to the next stage when the wait throws but the stage run already completed', async () => {
    database.scheduler_stages = [
      taskGroupStageRow({ stage_order: 0 }),
      stageRow({ id: STAGE_ID_3, crawler_id: CRAWLER_ID_2, stage_order: 1, input_schema: {} }),
    ];
    database.task_groups = [firstStageTaskGroup];
    const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: createTaskGroupWorker() });
    respondWith(crawlerExecutionClient, { published: true });
    const workflow = createReportWorkflow();
    const completeReport = completeWhileWaiting(dependencies, workflow, { episode: 'late' })!;
    const step = createFakeStep({
      onWaitForEvent: async (name, options) => {
        await completeReport(name, options);
        throw new Error('Workflow waitForEvent timed out');
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(stepResult(step, 'stage-0-result')).toEqual({ status: 'completed', stageRunID: expect.any(String) });
    expect(crawlerExecutionClient.execute).toHaveBeenCalledWith(CRAWLER_ID_2, { episode: 'late' });
    expect(result).toMatchObject({ outcome: 'started', status: 'completed' });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'completed', result: { published: true } });
  });

  it('reads the stage run again when a report completed it after the result step read it as running', async () => {
    database.scheduler_stages = [
      taskGroupStageRow({ stage_order: 0 }),
      stageRow({ id: STAGE_ID_3, crawler_id: CRAWLER_ID_2, stage_order: 1, input_schema: {} }),
    ];
    database.task_groups = [firstStageTaskGroup];
    const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: createTaskGroupWorker() });
    respondWith(crawlerExecutionClient, { published: true });
    const step = createFakeStep({
      onWaitForEvent: () => {
        throw new Error('Workflow waitForEvent timed out');
      },
      beforeStep: (name) => {
        if (name !== 'stage-0-result') return;
        // The report lands after the result step read the stage run, and before its update is applied
        database.beforeUpdateStageRuns = () => {
          database.beforeUpdateStageRuns = undefined;
          Object.assign(findStageRun(TASK_GROUP_STAGE_ID)!, {
            status: 'completed',
            output: { episode: 'reported in between' },
            completed_at: '2026-10-05T22:30:00.000Z',
          });
        };
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const groupStageRun = findStageRun(TASK_GROUP_STAGE_ID)!;
    expect(stepResult(step, 'stage-0-result')).toEqual({ status: 'completed', stageRunID: groupStageRun.id });
    expect(stepNames(step)).toEqual([
      'begin-run',
      'load-stages',
      'stage-0',
      'stage-0-finished',
      'stage-0-result',
      'stage-1',
      'finish-run',
    ]);

    // The result step read the stage run as running, tried to fail it only while running, then read it again
    const resultStepRequests = supabaseRequests.filter((request) => request.step === 'stage-0-result');
    expect(resultStepRequests.map((request) => `${request.method} ${request.table}`)).toEqual([
      'GET scheduler_stage_runs',
      'PATCH scheduler_stage_runs',
      'GET scheduler_stage_runs',
    ]);
    expect(resultStepRequests[1].query.get('status')).toBe('in.(running)');
    expect(groupStageRun).toMatchObject({
      status: 'completed',
      output: { episode: 'reported in between' },
      error: null,
      completed_at: '2026-10-05T22:30:00.000Z',
    });

    // The next stage gets the output that arrived in between
    expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(1);
    expect(crawlerExecutionClient.execute).toHaveBeenCalledWith(CRAWLER_ID_2, { episode: 'reported in between' });
    expect(result).toMatchObject({ outcome: 'started', status: 'completed' });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'completed', result: { published: true }, error: null });
  });

  it('fails when the stage run was removed before the result step', async () => {
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0 })];
    database.task_groups = [firstStageTaskGroup];
    const { dependencies } = createDependencies({ NEWSCAST: createTaskGroupWorker() });
    const step = createFakeStep({
      onWaitForEvent: () => {
        // The stage was deleted while the group worked
        database.scheduler_stage_runs = [];
      },
    });

    await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 0: stage run record was removed';
    expect(stepResult(step, 'stage-0-result')).toEqual({ status: 'failed', error });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
  });

  it('closes the stage runs still in progress in finish-run when a step itself throws', async () => {
    database.scheduler_stages = [taskGroupStageRow({ stage_order: 0 })];
    database.task_groups = [firstStageTaskGroup];
    const { dependencies } = createDependencies({ NEWSCAST: createTaskGroupWorker() });
    const step = createFakeStep({ throwingSteps: { 'stage-0-result': new Error('Step stage-0-result timed out') } });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error: 'Step stage-0-result timed out' });
    expect(findStageRun(TASK_GROUP_STAGE_ID)).toMatchObject({
      status: 'failed',
      error: 'Run ended before this stage finished',
      completed_at: expect.any(String),
    });
  });

  it('closes a stage run left in progress in finish-run even when the run completes', async () => {
    database.scheduler_stages = [stageRow({ id: STAGE_ID, crawler_id: CRAWLER_ID, stage_order: 0 })];
    const { dependencies } = createDependencies();
    // A stage run another attempt left pending
    const step = createFakeStep({
      beforeStep: (name) => {
        if (name === 'finish-run') {
          database.scheduler_stage_runs.push(stageRunRow({
            id: EXISTING_STAGE_RUN_ID,
            run_id: database.scheduler_runs[0].id,
            stage_id: STAGE_ID,
            status: 'pending',
            task_group_id: null,
            task_group_version: null,
          }));
        }
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(result).toMatchObject({ outcome: 'started', status: 'completed' });
    const closeRequests = requestsOf('PATCH', 'scheduler_stage_runs').filter((request) => request.step === 'finish-run');
    expect(closeRequests).toHaveLength(1);
    expect(closeRequests[0].query.get('run_id')).toBe(`eq.${database.scheduler_runs[0].id}`);
    expect(closeRequests[0].query.get('status')).toBe('in.(pending,running)');
    expect(database.scheduler_stage_runs.find((stageRun) => stageRun.id === EXISTING_STAGE_RUN_ID)).toMatchObject({
      status: 'failed',
      error: 'Run ended before this stage finished',
    });
    // The crawler stage run that completed keeps its result
    expect(findStageRun(STAGE_ID)).toMatchObject({ status: 'completed' });
  });

  it('fails the stage without throwing out of its step when the output of the stage before it cannot be read', async () => {
    database.scheduler_stages = [
      stageRow({ id: STAGE_ID, crawler_id: CRAWLER_ID, stage_order: 0 }),
      taskGroupStageRow({ stage_order: 1 }),
      stageRow({ id: STAGE_ID_3, crawler_id: CRAWLER_ID_2, stage_order: 2, input_schema: {} }),
    ];
    database.task_groups = [taskGroupRow()];
    const worker = createTaskGroupWorker();
    const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: worker });
    respondWith(crawlerExecutionClient, { urls: ['https://a.com'] });
    const onWaitForEvent = vi.fn();
    const step = createFakeStep({
      onWaitForEvent,
      // The first stage run disappears before the task group stage reads it
      beforeStep: (name) => {
        if (name === 'stage-1') database.scheduler_stage_runs = [];
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 1: previous stage output not found';
    expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-1', 'finish-run']);
    // Returned by the step, not thrown out of it
    expect(stepResult(step, 'stage-1')).toEqual({ status: 'failed', error });
    expect(worker.startTaskGroupRun).not.toHaveBeenCalled();
    expect(onWaitForEvent).not.toHaveBeenCalled();
    expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(database.scheduler_runs[0]).toMatchObject({ status: 'failed', error });
  });

  describe('when the start step runs again', () => {
    // The occurrence a previous attempt of the start step began, and the stage run that attempt left
    function seedPreviousAttempt(stageRunOverrides: Row = {}) {
      database.scheduler_runs = [runRow({ status: 'running', triggered_by: 'schedule', scheduled_for: SCHEDULED_FOR })];
      database.scheduler_stage_runs = [stageRunRow(stageRunOverrides)];
    }

    // The stage itself moved to version 2, which is registered and whose worker is connected
    it.each([
      [
        'the version it recorded is no longer registered',
        [taskGroupRow({ version: 2, input_schema: { type: 'object' } })],
        'NEWSCAST',
        "Stage 0: task group 'newscast' version 1 is not registered",
      ],
      [
        'the worker of the version it recorded is not connected',
        // Version 1 runs on NEWSCAST, which is gone
        [firstStageTaskGroup, taskGroupRow({ version: 2, worker_binding: 'NEWSCAST_TWO' })],
        'NEWSCAST_TWO',
        "Stage 0: task group worker 'NEWSCAST' is not connected",
      ],
    ])('fails the running stage run and the run when %s', async (_, taskGroups, versionTwoBinding, error) => {
      seedPreviousAttempt();
      database.scheduler_stages = [taskGroupStageRow({ stage_order: 0, task_group_version: 2 })];
      database.task_groups = taskGroups;
      const versionTwoWorker = createTaskGroupWorker();
      const { dependencies } = createDependencies({ [versionTwoBinding]: versionTwoWorker });
      const onWaitForEvent = vi.fn();
      const step = createFakeStep({ onWaitForEvent });

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'finish-run']);
      expect(stepResult(step, 'stage-0')).toEqual({ status: 'failed', error });
      expect(versionTwoWorker.startTaskGroupRun).not.toHaveBeenCalled();
      expect(onWaitForEvent).not.toHaveBeenCalled();

      // The stage run the previous attempt left is failed, only while still running, and no other is made
      expect(requestsOf('POST', 'scheduler_stage_runs')).toHaveLength(0);
      expect(database.scheduler_stage_runs).toEqual([stageRunRow({ status: 'failed', error, completed_at: expect.any(String) })]);
      const stageRunUpdates = requestsOf('PATCH', 'scheduler_stage_runs').filter((request) => request.step === 'stage-0');
      expect(stageRunUpdates).toHaveLength(1);
      expect(stageRunUpdates[0].query.get('id')).toBe(`eq.${EXISTING_STAGE_RUN_ID}`);
      expect(stageRunUpdates[0].query.get('status')).toBe('in.(running)');

      expect(result).toEqual({ outcome: 'started', runID: EXISTING_RUN_ID, status: 'failed' });
      expect(findRun(EXISTING_RUN_ID)).toMatchObject({ status: 'failed', error });
    });

    it('fails the run with the error of a stage run that already failed, without starting the group or waiting', async () => {
      const failedStageRunOverrides = {
        status: 'failed',
        completed_at: '2026-10-05T22:30:00.000Z',
        error: 'Stage 0: task group failed: out of quota',
      };
      seedPreviousAttempt(failedStageRunOverrides);
      database.scheduler_stages = [
        taskGroupStageRow({ stage_order: 0 }),
        stageRow({ id: STAGE_ID_3, crawler_id: CRAWLER_ID_2, stage_order: 1, input_schema: {} }),
      ];
      database.task_groups = [firstStageTaskGroup];
      const worker = createTaskGroupWorker();
      const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: worker });
      const onWaitForEvent = vi.fn();
      const step = createFakeStep({ onWaitForEvent });

      const result = await runScheduledPipeline(dependencies, parameters, step);

      const error = 'Stage 0: task group failed: out of quota';
      expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-0-result', 'finish-run']);
      expect(stepResult(step, 'stage-0')).toEqual({ status: 'settled', stageRunID: EXISTING_STAGE_RUN_ID });
      expect(stepResult(step, 'stage-0-result')).toEqual({ status: 'failed', error });
      expect(worker.startTaskGroupRun).not.toHaveBeenCalled();
      expect(onWaitForEvent).not.toHaveBeenCalled();
      expect(crawlerExecutionClient.execute).not.toHaveBeenCalled();
      // The stage run stays as it ended
      expect(database.scheduler_stage_runs).toEqual([stageRunRow(failedStageRunOverrides)]);
      expect(result).toEqual({ outcome: 'started', runID: EXISTING_RUN_ID, status: 'failed' });
      expect(findRun(EXISTING_RUN_ID)).toMatchObject({ status: 'failed', error });
    });
  });

  describe('step boundaries', () => {
    const crawlerGroupCrawlerStages = () => [
      stageRow({ id: STAGE_ID, crawler_id: CRAWLER_ID, stage_order: 0 }),
      taskGroupStageRow({ stage_order: 1 }),
      stageRow({ id: STAGE_ID_3, crawler_id: CRAWLER_ID_2, stage_order: 2, input_schema: {} }),
    ];

    it('puts no stage output in any step result', async () => {
      database.scheduler_stages = crawlerGroupCrawlerStages();
      database.task_groups = [taskGroupRow()];
      const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: createTaskGroupWorker() });
      respondWith(crawlerExecutionClient, { urls: ['first-stage-output'] }, { marker: 'third-stage-output' });
      const workflow = createReportWorkflow();
      const step = createFakeStep({
        onWaitForEvent: completeWhileWaiting(dependencies, workflow, { episode: 'second-stage-output' }),
      });

      await runScheduledPipeline(dependencies, parameters, step);

      expect(database.scheduler_runs[0]).toMatchObject({ status: 'completed', result: { marker: 'third-stage-output' } });
      expect(findStageRun(TASK_GROUP_STAGE_ID)).toMatchObject({
        input: { urls: ['first-stage-output'] },
        output: { episode: 'second-stage-output' },
      });
      expect(step.steps).toHaveLength(8);
      for (const recorded of step.steps) {
        expect(JSON.stringify(recorded.result ?? null)).not.toContain('stage-output');
      }
    });

    it('makes every database request of the instance and the call to the group inside a step', async () => {
      database.scheduler_stages = crawlerGroupCrawlerStages();
      database.task_groups = [taskGroupRow()];
      const groupCallSteps: (string | null)[] = [];
      const worker = createTaskGroupWorker(async () => {
        groupCallSteps.push(activeStep);
      });
      const { dependencies, crawlerExecutionClient } = createDependencies({ NEWSCAST: worker });
      respondWith(crawlerExecutionClient, { urls: ['https://a.com'] }, { published: true });
      const workflow = createReportWorkflow();
      const step = createFakeStep({ onWaitForEvent: completeWhileWaiting(dependencies, workflow, { episode: 'Episode 1' }) });

      await runScheduledPipeline(dependencies, parameters, step);

      expect(database.scheduler_runs[0]).toMatchObject({ status: 'completed' });
      // The requests made while the instance waits are the group's report, sent from outside the instance
      const reportRequests = supabaseRequests.filter((request) => request.step === 'stage-1-finished');
      const instanceRequests = supabaseRequests.filter((request) => request.step !== 'stage-1-finished');
      expect(reportRequests.length).toBeGreaterThan(0);
      expect(instanceRequests.length).toBeGreaterThan(0);
      expect(instanceRequests.filter((request) => request.step === null)).toEqual([]);
      expect(groupCallSteps).toEqual(['stage-1']);
      expect(crawlerExecutionClient.steps).toEqual(['stage-0', 'stage-2']);
    });
  });

  describe('manual run', () => {
    const manualParameters = { schedulerID: SCHEDULER_ID, runID: EXISTING_RUN_ID };

    it('starts the pending run and runs its stages, waking the manual instance', async () => {
      database.scheduler_runs = [runRow({ status: 'pending', started_at: null })];
      database.scheduler_stages = [taskGroupStageRow({ stage_order: 0 })];
      database.task_groups = [firstStageTaskGroup];
      const { dependencies } = createDependencies({ NEWSCAST: createTaskGroupWorker() });
      const workflow = createReportWorkflow();
      const step = createFakeStep({ onWaitForEvent: completeWhileWaiting(dependencies, workflow, { episode: 'manual' }) });

      const result = await runScheduledPipeline(dependencies, manualParameters, step);

      expect(result).toEqual({ outcome: 'started', runID: EXISTING_RUN_ID, status: 'completed' });
      const runUpdates = requestsOf('PATCH', 'scheduler_runs');
      expect(runUpdates[0].body).toEqual({ status: 'running', started_at: expect.any(String) });
      expect(runUpdates[0].query.get('status')).toBe('in.(pending)');
      expect(requestsOf('POST', 'scheduler_runs')).toHaveLength(0);
      expect(findRun(EXISTING_RUN_ID)).toMatchObject({ status: 'completed', result: { episode: 'manual' } });
      expect(workflow.events.map((event) => event.instanceID)).toEqual([`manual-${EXISTING_RUN_ID}`]);
    });

    it('runs a scheduler that is disabled and has no cron expression', async () => {
      database.schedulers = [schedulerRow({ is_enabled: false, cron_expression: null })];
      database.scheduler_runs = [runRow({ status: 'pending', started_at: null })];
      database.scheduler_stages = [stageRow({ stage_order: 0 })];
      const { dependencies, crawlerExecutionClient } = createDependencies();

      const result = await runScheduledPipeline(dependencies, manualParameters, createFakeStep());

      expect(result).toEqual({ outcome: 'started', runID: EXISTING_RUN_ID, status: 'completed' });
      expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(1);
    });

    it('continues a run a previous attempt already started', async () => {
      database.scheduler_runs = [runRow({ status: 'running' })];
      database.scheduler_stages = [stageRow({ stage_order: 0 })];
      const { dependencies } = createDependencies();

      const result = await runScheduledPipeline(dependencies, manualParameters, createFakeStep());

      expect(result).toEqual({ outcome: 'started', runID: EXISTING_RUN_ID, status: 'completed' });
      expect(requestsOf('PATCH', 'scheduler_runs').map((request) => request.body?.status)).toEqual(['completed']);
    });

    it.each([
      ['the run does not exist', [], [schedulerRow()], { outcome: 'cancelled' }],
      ['the scheduler does not exist', [runRow({ status: 'pending' })], [], { outcome: 'cancelled' }],
      ['the run already completed', [runRow({ status: 'completed' })], [schedulerRow()], { outcome: 'finished' }],
      ['the run already failed', [runRow({ status: 'failed' })], [schedulerRow()], { outcome: 'finished' }],
    ])('does not run when %s', async (_, runs, schedulers, expected) => {
      database.schedulers = schedulers;
      database.scheduler_runs = runs;
      database.scheduler_stages = [stageRow({ stage_order: 0 })];
      const { dependencies, crawlerExecutionClient } = createDependencies();
      const step = createFakeStep();

      const result = await runScheduledPipeline(dependencies, manualParameters, step);

      expect(result).toEqual(expected);
      expect(stepNames(step)).toEqual(['begin-run']);
      expect(requestsOf('PATCH', 'scheduler_runs')).toHaveLength(0);
      expect(crawlerExecutionClient.execute).not.toHaveBeenCalled();
    });
  });
});
