import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { SchedulerStageRow } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import type { CrawlerLogEntry, CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { ServiceBindingCrawlerExecutionClient, type CrawlerExecutionClient } from '../sources/crawler-execution-client.ts';
import { resolveHTTPStatus } from '../sources/handlers/scheduler-execution.ts';
import { executePipelineStage, executeScheduler, type ExecutorDependencies } from '../sources/scheduler-executor.ts';
import { type ScheduledPipelineStep, runScheduledPipeline } from '../sources/scheduled-pipeline.ts';
import { executeFanOut, executeStage, type CrawlerStageRow } from '../sources/stage-runner.ts';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

// The logs of the crawlers on stage runs: the cases beyond crawler-run-logs.test.ts, for a stage, a failed
// stage, a fan-out stage, a scheduled run, the client of the crawler manager and the status of a failed run.

const USER_UUID = '00000000-0000-0000-0000-000000000001';
const OWNER_UUID = '00000000-0000-0000-0000-000000000007';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const STAGE_ID = '00000000-0000-0000-0000-000000000020';
const STAGE_ID_2 = '00000000-0000-0000-0000-000000000021';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const CRAWLER_ID_2 = '00000000-0000-0000-0000-000000000031';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const SCHEDULED_FOR = '2026-10-13T00:00:00.000Z';
const CONTEXT = { userUUID: USER_UUID, runID: RUN_ID };

const supabase = useInMemorySupabase('https://supabase.example.com');

function entry(message: string, level: CrawlerLogEntry['level'] = 'log'): CrawlerLogEntry {
  return { level, message, timestamp: '2026-10-13T00:00:00.000Z' };
}

function completed(result: unknown, logs: CrawlerLogEntry[] = [], logsTruncated = false): CrawlerRunOutcome {
  return { status: 'completed', type: 'data', result, logs, logs_truncated: logsTruncated };
}

function failed(error: string, logs: CrawlerLogEntry[] = [], logsTruncated = false): CrawlerRunOutcome {
  return { status: 'failed', type: 'data', error_code: 'execution_failed', error, error_description: error, logs, logs_truncated: logsTruncated };
}

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
    input_schema: {},
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as CrawlerStageRow;
}

function createDependencies(outcomes: (CrawlerRunOutcome | Error | string)[] = []) {
  const queue = [...outcomes];
  const run = vi.fn(async () => {
    const next = queue.shift() ?? completed(null);
    if (typeof next === 'string') throw next;
    if (next instanceof Error) throw next;
    return next;
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), createChild: vi.fn().mockReturnThis() };
  const dependencies: ExecutorDependencies = {
    supabaseClient: createSupabaseClient({ supabaseURL: env.SUPABASE_URL, supabaseSecretKey: env.SUPABASE_SECRET_KEY }),
    crawlerExecutionClient: { run } as CrawlerExecutionClient,
    logger: logger as unknown as Logger,
    userUUID: USER_UUID,
  };
  return { dependencies, run, logger };
}

function seedRun(ownerUUID = USER_UUID) {
  supabase.tables.schedulers = [{
    id: SCHEDULER_ID,
    user_uuid: ownerUUID,
    name: 'Scheduler',
    cron_expression: '0 9 * * *',
    timezone: 'Asia/Seoul',
    is_enabled: true,
    last_run_at: null,
    next_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }];
  supabase.tables.scheduler_runs = [{
    id: RUN_ID,
    scheduler_id: SCHEDULER_ID,
    status: 'running',
    started_at: '2026-10-13T00:00:00.000Z',
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-13T00:00:00.000Z',
  }];
}

function stageRuns(): Row[] {
  return supabase.tables.scheduler_stage_runs ?? [];
}

describe('executeStage', () => {
  it('records an empty list of logs, not cut, for a crawler that logged nothing', async () => {
    seedRun();
    const { dependencies } = createDependencies([completed(null)]);

    await executeStage(dependencies, RUN_ID, stage(), {});

    expect(stageRuns()[0]).toMatchObject({ status: 'completed', output: null, logs: [], logs_truncated: false });
  });

  it('records a failed outcome once, with its error, logs and whether they were cut, and throws the error', async () => {
    seedRun();
    const error = 'CodeRunner error 422: [execution_failed] boom';
    const { dependencies } = createDependencies([failed(error, [entry('before'), entry('Error: boom', 'error')], true)]);

    await expect(executeStage(dependencies, RUN_ID, stage(), {})).rejects.toThrow(new Error(error));

    expect(stageRuns()).toHaveLength(1);
    expect(stageRuns()[0]).toMatchObject({
      status: 'failed',
      error,
      logs: [entry('before'), entry('Error: boom', 'error')],
      logs_truncated: true,
      completed_at: expect.any(String),
    });
    expect(supabase.requestsOf('POST', 'scheduler_stage_runs')).toHaveLength(1);
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(1);
  });

  it('throws the text of a failed outcome as it is, also the text of a web crawler without a URL', async () => {
    seedRun();
    const message = `Crawler ${CRAWLER_ID}: no URL available. Provide url in input or set a default in input_schema.`;
    const { dependencies } = createDependencies([failed(message)]);

    await expect(executeStage(dependencies, RUN_ID, stage(), {})).rejects.toThrow(new Error(message));
  });

  it('records no logs and throws the error as it was when the call itself fails', async () => {
    seedRun();
    const { dependencies } = createDependencies([new Error('Crawler 1 not found')]);

    await expect(executeStage(dependencies, RUN_ID, stage(), {})).rejects.toThrow('Crawler 1 not found');

    expect(stageRuns()[0]).toMatchObject({ status: 'failed', error: 'Crawler 1 not found' });
    expect(stageRuns()[0]).not.toHaveProperty('logs');
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(1);
  });

  it('still throws the error of a failed outcome when its stage run cannot be updated', async () => {
    seedRun();
    const { dependencies, logger } = createDependencies([failed('CodeRunner error 422: [execution_failed] boom', [entry('before')])]);
    supabase.intercept = (request) => (request.method === 'PATCH' ? { statusCode: 500, data: { message: 'update failed' } } : undefined);

    await expect(executeStage(dependencies, RUN_ID, stage(), {})).rejects.toThrow('CodeRunner error 422: [execution_failed] boom');

    expect(logger.error).toHaveBeenCalledWith('Failed to update stage run status after error', expect.any(Error), expect.anything());
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(1);
  });

  it('records the failure of a completed outcome whose stage run cannot be updated', async () => {
    seedRun();
    const { dependencies } = createDependencies([completed({ ok: true }, [entry('x')])]);
    let updates = 0;
    supabase.intercept = (request) => {
      if (request.method !== 'PATCH') return undefined;
      updates += 1;
      return updates === 1 ? { statusCode: 500, data: { message: 'update failed' } } : undefined;
    };

    await expect(executeStage(dependencies, RUN_ID, stage(), {})).rejects.toThrow('Failed to update scheduler stage run');

    expect(updates).toBe(2);
    expect(stageRuns()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('Failed to update scheduler stage run') });
  });
});

describe('executeFanOut', () => {
  it('writes the failure of an item whose call threw something that is not an Error as its text', async () => {
    const { dependencies, run } = createDependencies();
    run.mockResolvedValueOnce(completed('ok')).mockRejectedValueOnce(new Error('connection lost')).mockRejectedValueOnce('plain string');

    const result = await executeFanOut(dependencies, RUN_ID, stage(), ['a', 'b', 'c']);

    expect(result.logs).toEqual([
      { level: 'error', message: 'connection lost', timestamp: expect.any(String), item_index: 1 },
      { level: 'error', message: 'plain string', timestamp: expect.any(String), item_index: 2 },
    ]);
    expect(result.itemsFailed).toBe(2);
  });

  it('keeps the failure texts of every item when all fail', async () => {
    const { dependencies } = createDependencies([failed('first failed'), failed('second failed')]);

    const result = await executeFanOut(dependencies, RUN_ID, stage(), ['a', 'b']);

    expect(result.status).toBe('failed');
    expect(result.logs.map((logEntry) => [logEntry.item_index, logEntry.message])).toEqual([[0, 'first failed'], [1, 'second failed']]);
  });

  it('puts its own item_index on the logs of an item, whatever the crawler wrote', async () => {
    const { dependencies } = createDependencies([completed('a', [{ ...entry('x'), item_index: 99 }])]);

    const result = await executeFanOut(dependencies, RUN_ID, stage(), ['a']);

    expect(result.logs[0].item_index).toBe(0);
  });

  it('replaces NUL characters and lone surrogates in the failure texts and the logs', async () => {
    const { dependencies } = createDependencies([failed('bad\u0000text', [entry('with\u0000nul'), entry('lone \ud800 end')])]);

    const result = await executeFanOut(dependencies, RUN_ID, stage(), ['a']);

    expect(result.logs.map((logEntry) => logEntry.message)).toEqual(['with�nul', 'lone � end', 'bad�text']);
    expect(JSON.stringify(result.logs)).not.toContain('\\u0000');
  });

  it('counts the failure entries among the 1000 it keeps, and says the logs were cut', async () => {
    const { dependencies, run } = createDependencies();
    // One character each: 65 per entry, so the count of entries is what stops them
    run.mockImplementation(async () => failed('f'));

    const result = await executeFanOut(dependencies, RUN_ID, stage(), Array.from({ length: 1100 }, (_, index) => index));

    expect(result.logs).toHaveLength(1000);
    expect(result.logsTruncated).toBe(true);
    expect(result.status).toBe('failed');

    const exact = await executeFanOut(dependencies, RUN_ID, stage(), Array.from({ length: 700 }, (_, index) => index));
    expect(exact.logs).toHaveLength(700);
    expect(exact.logsTruncated).toBe(false);
  });

  it('does not cut a surrogate pair in half at the limit of the merged logs', async () => {
    const { dependencies } = createDependencies([completed(0, [entry('a'.repeat(65_536 - 64 - 64 - 1)), entry('\u{1F600}tail')])]);

    const result = await executeFanOut(dependencies, RUN_ID, stage(), [0]);

    expect(result.logs).toHaveLength(2);
    expect(result.logs[1].message).toBe('');
    expect(result.logs[1].message.isWellFormed()).toBe(true);
    expect(result.logsTruncated).toBe(true);
  });

  it('does not change the entries the crawler manager answered', async () => {
    const original = entry('keep');
    const { dependencies } = createDependencies([completed(0, [original])]);

    await executeFanOut(dependencies, RUN_ID, stage(), [0]);

    expect(original).toEqual({ level: 'log', message: 'keep', timestamp: '2026-10-13T00:00:00.000Z' });
  });

  it('has no logs, and is completed, for no items', async () => {
    const { dependencies, run } = createDependencies();

    const result = await executeFanOut(dependencies, RUN_ID, stage(), []);

    expect(result).toMatchObject({ logs: [], logsTruncated: false, status: 'completed' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('executePipelineStage with a fan-out stage', () => {
  it('records the merged logs, the counts and the status of a partly failed stage on the stage run', async () => {
    seedRun();
    const { dependencies } = createDependencies([completed('a', [entry('item 0')]), failed('item 1 failed', [entry('item 1')])]);

    const result = await executePipelineStage(dependencies, RUN_ID, stage({ fan_out_field: 'items' }), { items: ['a', 'b'] });

    expect(result.partiallyFailed).toBe(true);
    expect(stageRuns()).toHaveLength(1);
    expect(stageRuns()[0]).toMatchObject({
      status: 'partially_failed',
      output: ['a'],
      items_total: 2,
      items_succeeded: 1,
      items_failed: 1,
      logs: [
        { ...entry('item 0'), item_index: 0 },
        { ...entry('item 1'), item_index: 1 },
        { level: 'error', message: 'item 1 failed', timestamp: expect.any(String), item_index: 1 },
      ],
      logs_truncated: false,
    });
  });

  it('records the logs of a fan-out stage where every item failed, then throws', async () => {
    seedRun();
    const { dependencies } = createDependencies([failed('first failed'), failed('second failed')]);

    await expect(executePipelineStage(dependencies, RUN_ID, stage({ fan_out_field: 'items' }), { items: ['a', 'b'] })).rejects.toThrow(
      'Stage 0: all fan-out items failed',
    );

    expect(stageRuns()[0]).toMatchObject({
      status: 'failed',
      logs: [
        { level: 'error', message: 'first failed', timestamp: expect.any(String), item_index: 0 },
        { level: 'error', message: 'second failed', timestamp: expect.any(String), item_index: 1 },
      ],
      logs_truncated: false,
    });
  });

  it('records an empty list of logs, and runs nothing, for a fan-out stage without items', async () => {
    seedRun();
    const { dependencies, run } = createDependencies();

    await executePipelineStage(dependencies, RUN_ID, stage({ fan_out_field: 'items' }), { items: [] });

    expect(run).not.toHaveBeenCalled();
    expect(stageRuns()[0]).toMatchObject({ status: 'completed', output: [], items_total: 0, logs: [], logs_truncated: false });
  });

  it('passes the user and the run for every item', async () => {
    seedRun();
    const { dependencies, run } = createDependencies([completed(1), completed(2)]);

    await executePipelineStage(dependencies, RUN_ID, stage({ fan_out_field: 'items' }), { items: ['a', 'b'] });

    expect(run.mock.calls.map((call) => (call as unknown[])[2])).toEqual([CONTEXT, CONTEXT]);
  });
});

describe('executeScheduler', () => {
  it('fails the whole run with the text of the failed crawler, keeps the logs on its stage run, and does not start the stage after it', async () => {
    seedRun();
    const { dependencies } = createDependencies([failed('CodeRunner error 422: [execution_failed] boom', [entry('before the failure')])]);

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID, undefined, [stage(), stage({ id: STAGE_ID_2, stage_order: 1 })]);

    expect(supabase.tables.scheduler_runs[0]).toMatchObject({ status: 'failed', error: 'CodeRunner error 422: [execution_failed] boom' });
    expect(stageRuns()).toHaveLength(1);
    expect(stageRuns()[0]).toMatchObject({ status: 'failed', logs: [entry('before the failure')] });
  });

  it('gives each stage its own logs', async () => {
    seedRun();
    const { dependencies } = createDependencies([completed({ items: ['a'] }, [entry('stage zero')]), completed('done', [entry('stage one')])]);

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID, undefined, [
      stage(),
      stage({ id: STAGE_ID_2, stage_order: 1, fan_out_field: 'items' }),
    ]);

    expect(supabase.tables.scheduler_runs[0]).toMatchObject({ status: 'completed' });
    expect(stageRuns().map((stageRun) => stageRun.logs)).toEqual([[entry('stage zero')], [{ ...entry('stage one'), item_index: 0 }]]);
  });
});

describe('a scheduled run', () => {
  const step: ScheduledPipelineStep = {
    do: async (_name, _options, callback) => callback(),
    waitForEvent: async () => ({}),
  };

  function seedStages(stages: Row[]) {
    supabase.tables.schedulers = [{
      id: SCHEDULER_ID,
      user_uuid: OWNER_UUID,
      name: 'Scheduled',
      cron_expression: '0 9 * * *',
      timezone: 'Asia/Seoul',
      is_enabled: true,
      last_run_at: null,
      next_run_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }];
    supabase.tables.scheduler_stages = stages;
  }

  function stageRow(overrides: Partial<SchedulerStageRow> = {}): Row {
    return { ...stage({ input_schema: { url: { type: 'string', default: 'https://example.com' } }, ...overrides }) } as unknown as Row;
  }

  function pipelineDependencies(outcomes: CrawlerRunOutcome[]) {
    const queue = [...outcomes];
    const run = vi.fn(async () => queue.shift() as CrawlerRunOutcome);
    return {
      run,
      dependencies: {
        supabaseClient: createSupabaseClient({ supabaseURL: env.SUPABASE_URL, supabaseSecretKey: env.SUPABASE_SECRET_KEY }),
        crawlerExecutionClient: { run } as CrawlerExecutionClient,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), createChild: vi.fn().mockReturnThis() } as unknown as Logger,
        resolveTaskGroupWorker: () => undefined,
      },
    };
  }

  it('runs the crawlers for the owner of the scheduler and the run, and records their logs on the stage runs', async () => {
    seedStages([stageRow(), stageRow({ id: STAGE_ID_2, crawler_id: CRAWLER_ID_2, stage_order: 1, input_schema: {} })]);
    const { dependencies, run } = pipelineDependencies([
      completed({ urls: ['https://a.com'] }, [entry('first stage')]),
      completed({ published: true }, [entry('second stage')], true),
    ]);

    const result = await runScheduledPipeline(dependencies, { schedulerID: SCHEDULER_ID, scheduledFor: SCHEDULED_FOR }, step);

    const runRow = supabase.tables.scheduler_runs[0];
    expect(result).toEqual({ outcome: 'started', runID: runRow.id, status: 'completed' });
    expect(run).toHaveBeenNthCalledWith(1, CRAWLER_ID, { url: 'https://example.com' }, { userUUID: OWNER_UUID, runID: runRow.id });
    expect(run).toHaveBeenNthCalledWith(2, CRAWLER_ID_2, { urls: ['https://a.com'] }, { userUUID: OWNER_UUID, runID: runRow.id });
    expect(stageRuns().map((stageRun) => [stageRun.status, stageRun.logs, stageRun.logs_truncated])).toEqual([
      ['completed', [entry('first stage')], false],
      ['completed', [entry('second stage')], true],
    ]);
  });

  it('fails the run with the error of a crawler that failed, keeps its logs, and does not run the stages after it', async () => {
    seedStages([stageRow(), stageRow({ id: STAGE_ID_2, crawler_id: CRAWLER_ID_2, stage_order: 1, input_schema: {} })]);
    const { dependencies, run } = pipelineDependencies([failed('CodeRunner error 422: [execution_failed] boom', [entry('before the failure')])]);

    const result = await runScheduledPipeline(dependencies, { schedulerID: SCHEDULER_ID, scheduledFor: SCHEDULED_FOR }, step);

    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(supabase.tables.scheduler_runs[0]).toMatchObject({ status: 'failed', error: 'CodeRunner error 422: [execution_failed] boom' });
    expect(stageRuns()).toHaveLength(1);
    expect(stageRuns()[0]).toMatchObject({
      status: 'failed',
      error: 'CodeRunner error 422: [execution_failed] boom',
      logs: [entry('before the failure')],
    });
  });

  it('records the merged logs of a fan-out stage with the index of each item', async () => {
    seedStages([stageRow(), stageRow({ id: STAGE_ID_2, crawler_id: CRAWLER_ID_2, stage_order: 1, input_schema: {}, fan_out_field: 'items' })]);
    const { dependencies } = pipelineDependencies([
      completed({ items: ['a', 'b'] }),
      completed('ok-a', [entry('item a')]),
      failed('item b failed', [entry('item b')]),
    ]);

    const result = await runScheduledPipeline(dependencies, { schedulerID: SCHEDULER_ID, scheduledFor: SCHEDULED_FOR }, step);

    expect(result).toMatchObject({ status: 'partially_failed' });
    expect(stageRuns()[1]).toMatchObject({
      status: 'partially_failed',
      logs: [
        { ...entry('item a'), item_index: 0 },
        { ...entry('item b'), item_index: 1 },
        { level: 'error', message: 'item b failed', timestamp: expect.any(String), item_index: 1 },
      ],
      logs_truncated: false,
    });
  });
});

describe('ServiceBindingCrawlerExecutionClient', () => {
  const run = (answer: unknown) => new ServiceBindingCrawlerExecutionClient({ runCrawler: vi.fn(async () => answer) } as unknown as Service)
    .run(CRAWLER_ID, {}, CONTEXT);

  it('asks the crawler manager to run the crawler with the input and the context, and returns the outcome', async () => {
    const outcome = completed({ title: 'Example' }, [entry('hello')]);
    const runCrawler = vi.fn(async () => outcome);

    const result = await new ServiceBindingCrawlerExecutionClient({ runCrawler } as unknown as Service).run(CRAWLER_ID, { url: 'https://example.com' }, CONTEXT);

    expect(runCrawler).toHaveBeenCalledWith(CRAWLER_ID, { url: 'https://example.com' }, CONTEXT);
    expect(result).toEqual(outcome);
  });

  it('returns a failed outcome with its logs instead of throwing', async () => {
    const outcome = failed('CodeRunner error 422: [execution_failed] boom', [entry('Error: boom', 'error')], true);

    await expect(run(outcome)).resolves.toEqual(outcome);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['text', 'text'],
    ['the old shape', { type: 'data', result: 1 }],
    ['an outcome without logs', { status: 'completed', type: 'data', result: 1, logs_truncated: false }],
    ['an outcome with logs that are not a list', { status: 'completed', type: 'data', result: 1, logs: 'x', logs_truncated: false }],
    ['an outcome without logs_truncated', { status: 'completed', type: 'data', result: 1, logs: [] }],
    ['a failed outcome without an error', { status: 'failed', type: 'data', logs: [], logs_truncated: false }],
  ])('throws Invalid CrawlerRunOutcome for %s', async (_label, answer) => {
    await expect(run(answer)).rejects.toThrow(/^Invalid CrawlerRunOutcome:/);
  });

  it('lets what the crawler manager throws through as it is', async () => {
    const binding = { runCrawler: vi.fn().mockRejectedValue(new Error('Crawler 1 not found')) } as unknown as Service;

    await expect(new ServiceBindingCrawlerExecutionClient(binding).run(CRAWLER_ID, {}, CONTEXT)).rejects.toThrow('Crawler 1 not found');
  });

  it('no longer asks for executeCrawler, which runs without a user', async () => {
    const executeCrawler = vi.fn();
    const runCrawler = vi.fn(async () => completed(null));

    await new ServiceBindingCrawlerExecutionClient({ executeCrawler, runCrawler } as unknown as Service).run(CRAWLER_ID, {}, CONTEXT);

    expect(executeCrawler).not.toHaveBeenCalled();
    expect(runCrawler).toHaveBeenCalledTimes(1);
  });
});

describe('resolveHTTPStatus', () => {
  it('answers 502 for an answer of the crawler manager that is not an outcome, also inside a stage text', () => {
    expect(resolveHTTPStatus('failed', 'Invalid CrawlerRunOutcome: expected object')).toBe(502);
    expect(resolveHTTPStatus('failed', "Invalid CrawlerRunOutcome: expected status 'completed' or 'failed', got 'undefined'")).toBe(502);
    expect(resolveHTTPStatus('failed', 'Stage 0: Invalid CrawlerRunOutcome: missing result field')).toBe(502);
    expect(resolveHTTPStatus('failed', 'Invalid CrawlerExecuteResult: expected object')).toBe(502);
  });

  it('answers the status each failure of the runtime has always had', () => {
    expect(resolveHTTPStatus('failed', 'CodeRunner error 422: [execution_failed] boom')).toBe(502);
    expect(resolveHTTPStatus('failed', 'CodeRunner error 502: [invalid_response] Expected the page body as a string')).toBe(502);
    expect(resolveHTTPStatus('failed', "CodeRunner error 400: [invalid_request] Field 'url' must be a valid URL")).toBe(502);
    expect(resolveHTTPStatus('failed', 'CodeRunner error 504: [server_error] Server returned 504')).toBe(502);
    expect(resolveHTTPStatus('failed', 'CodeRunner error 422: [execution_timeout] Code execution timed out after 300000ms')).toBe(408);
    expect(resolveHTTPStatus('failed', 'CodeRunner error 422: [execution_timeout] Code execution timed out: CPU time limit of 30000ms exceeded')).toBe(408);
    expect(resolveHTTPStatus('failed', 'Pipeline execution timed out after 5 minutes')).toBe(408);
    expect(resolveHTTPStatus('failed', `Crawler ${CRAWLER_ID}: no URL available. Provide url in input or set a default in input_schema.`)).toBe(500);
    expect(resolveHTTPStatus('failed', 'Environment variables could not be read: vault responded 503 vault_unavailable')).toBe(500);
  });

  it('answers the status the other failures have always had', () => {
    expect(resolveHTTPStatus('failed', 'Invalid input_schema: expected object, got string')).toBe(422);
    expect(resolveHTTPStatus('failed', 'Stage 1: fan_out_field "links" not found in input')).toBe(422);
    expect(resolveHTTPStatus('failed', 'Failed to list scheduler stages: connection reset')).toBe(500);
    expect(resolveHTTPStatus('failed', 'something else')).toBe(500);
  });

  it('answers 200 for a run that did not fail', () => {
    expect(resolveHTTPStatus('completed', null)).toBe(200);
    expect(resolveHTTPStatus('partially_failed', 'some item failed')).toBe(200);
    expect(resolveHTTPStatus('failed', null)).toBe(200);
    expect(resolveHTTPStatus('failed', undefined)).toBe(200);
  });
});
