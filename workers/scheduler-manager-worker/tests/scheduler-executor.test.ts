import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { SchedulerStageRow } from '@audio-underview/supabase-connector';
import type { CrawlerExecutionClient } from '../sources/crawler-execution-client.ts';
import type { Logger } from '@audio-underview/logger';
import { executeScheduler } from '../sources/scheduler-executor.ts';
import type { ExecutorDependencies } from '../sources/scheduler-executor.ts';

const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const STAGE_ID = '00000000-0000-0000-0000-000000000020';
const STAGE_ID_2 = '00000000-0000-0000-0000-000000000021';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const CRAWLER_ID_2 = '00000000-0000-0000-0000-000000000031';
const STAGE_RUN_ID = '00000000-0000-0000-0000-000000000050';
const STAGE_RUN_ID_2 = '00000000-0000-0000-0000-000000000051';

function mockStage(overrides: Partial<SchedulerStageRow> = {}): SchedulerStageRow {
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
  } as SchedulerStageRow;
}

function mockRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    scheduler_id: SCHEDULER_ID,
    status: 'running',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    result: null,
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockSchedulerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULER_ID,
    user_uuid: USER_UUID,
    name: 'Test Scheduler',
    cron_expression: null,
    is_enabled: true,
    last_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockStageRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: STAGE_RUN_ID,
    run_id: RUN_ID,
    stage_id: STAGE_ID,
    stage_order: 0,
    status: 'running',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    input: null,
    output: null,
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// --- Supabase mock helpers ---

function mockListSchedulerStages(stages: SchedulerStageRow[]) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/scheduler_stages/, method: 'GET' })
    .reply(200, JSON.stringify(stages));
}

function mockUpdateSchedulerRun(overrides: Record<string, unknown> = {}) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/scheduler_runs/, method: 'PATCH' })
    .reply(200, JSON.stringify(mockRunRow(overrides)));
}

function mockUpdateScheduler(overrides: Record<string, unknown> = {}) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'PATCH' })
    .reply(200, JSON.stringify(mockSchedulerRow(overrides)));
}

function mockCreateStageRun(overrides: Record<string, unknown> = {}) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/scheduler_stage_runs/, method: 'POST' })
    .reply(201, JSON.stringify(mockStageRunRow(overrides)));
}

function mockUpdateStageRun(overrides: Record<string, unknown> = {}) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/scheduler_stage_runs/, method: 'PATCH' })
    .reply(200, JSON.stringify(mockStageRunRow(overrides)));
}

function mockUpdateSchedulerRunError() {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/scheduler_runs/, method: 'PATCH' })
    .reply(500, JSON.stringify({ message: 'Internal Server Error' }));
}

// --- Crawler execution client mock ---

function createMockCrawlerExecutionClient(
  results: unknown[] = [],
): CrawlerExecutionClient & { execute: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(async () => {
      const result = results[callIndex] ?? { extracted: 'data' };
      callIndex++;
      return { type: 'data' as const, result };
    }),
  };
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

function createDependencies(crawlerResults: unknown[] = []): {
  dependencies: ExecutorDependencies;
  crawlerExecutionClient: ReturnType<typeof createMockCrawlerExecutionClient>;
  logger: ReturnType<typeof createMockLogger>;
} {
  const crawlerExecutionClient = createMockCrawlerExecutionClient(crawlerResults);
  const logger = createMockLogger();
  const supabaseClient = createSupabaseClient({
    supabaseURL: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
  });
  return {
    dependencies: { supabaseClient, crawlerExecutionClient, logger },
    crawlerExecutionClient,
    logger,
  };
}

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('executeScheduler', () => {
  it('marks run as completed with result null when stages are empty', async () => {
    const { dependencies } = createDependencies();

    // 1. updateSchedulerRun → status: 'running'
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages → empty array
    mockListSchedulerStages([]);
    // 3. updateSchedulerRun → status: 'completed', result: null
    mockUpdateSchedulerRun({ status: 'completed', result: null });
    // finally: updateScheduler → last_run_at
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(dependencies.crawlerExecutionClient.execute).not.toHaveBeenCalled();
  });

  it('executes a single stage and marks run completed with output', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies([
      { title: 'Test Page' },
    ]);

    // 1. updateSchedulerRun → status: 'running'
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages → one stage
    mockListSchedulerStages([mockStage()]);
    // 3. executeStage internals:
    //    a. createSchedulerStageRun
    mockCreateStageRun();
    //    b. crawlerExecutionClient.execute → via mock
    //    c. updateSchedulerStageRun
    mockUpdateStageRun({ status: 'completed', output: { title: 'Test Page' } });
    // 4. updateSchedulerRun → status: 'completed'
    mockUpdateSchedulerRun({ status: 'completed', result: { title: 'Test Page' } });
    // finally: updateScheduler
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(1);
    expect(crawlerExecutionClient.execute).toHaveBeenCalledWith(CRAWLER_ID, {
      url: 'https://example.com',
    });
  });

  it('chains multi-stage output: stage N output becomes stage N+1 input', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies([
      { urls: ['https://a.com', 'https://b.com'] },
      { results: [1, 2] },
    ]);

    const stage1 = mockStage({
      id: STAGE_ID,
      crawler_id: CRAWLER_ID,
      stage_order: 0,
    });
    const stage2 = mockStage({
      id: STAGE_ID_2,
      crawler_id: CRAWLER_ID_2,
      stage_order: 1,
      input_schema: {},
    });

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([stage1, stage2]);
    // 3. stage1: createStageRun + updateStageRun
    mockCreateStageRun();
    mockUpdateStageRun({ status: 'completed' });
    // 4. stage2: createStageRun + updateStageRun
    mockCreateStageRun({ id: STAGE_RUN_ID_2, stage_id: STAGE_ID_2, stage_order: 1 });
    mockUpdateStageRun({ id: STAGE_RUN_ID_2, status: 'completed' });
    // 5. updateSchedulerRun → completed
    mockUpdateSchedulerRun({ status: 'completed' });
    // finally: updateScheduler
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(2);
    // Stage 1 gets default input from input_schema
    expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(1, CRAWLER_ID, {
      url: 'https://example.com',
    });
    // Stage 2 gets output of stage 1 as input
    expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(2, CRAWLER_ID_2, {
      urls: ['https://a.com', 'https://b.com'],
    });
  });

  it('handles fan-out stage: validates fan_out_field exists and is array', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies([
      { links: ['https://a.com', 'https://b.com'] },
    ]);

    const stage1 = mockStage({ stage_order: 0 });
    const stage2 = mockStage({
      id: STAGE_ID_2,
      crawler_id: CRAWLER_ID_2,
      stage_order: 1,
      fan_out_field: 'links',
      input_schema: {},
    });

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([stage1, stage2]);
    // 3. stage1 (normal): createStageRun + updateStageRun
    mockCreateStageRun();
    mockUpdateStageRun({ status: 'completed' });
    // 4. stage2 (fan-out): createStageRun for the fan-out stage
    mockCreateStageRun({ id: STAGE_RUN_ID_2, stage_id: STAGE_ID_2, stage_order: 1 });
    // 5. executeFanOut calls crawlerExecutionClient.execute for each item
    //    (2 items from links array → 2 crawler calls, producing results for items 2 and 3)
    // 6. updateStageRun for the fan-out stage
    mockUpdateStageRun({ id: STAGE_RUN_ID_2, status: 'completed' });
    // 7. updateSchedulerRun → completed
    mockUpdateSchedulerRun({ status: 'completed' });
    // finally: updateScheduler
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    // Stage 1 + 2 fan-out items = 3 total crawler calls
    expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(3);
    expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(2, CRAWLER_ID_2, 'https://a.com');
    expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(3, CRAWLER_ID_2, 'https://b.com');
  });

  it('completes fan-out with empty array: output is []', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies([
      { links: [] },
    ]);

    const stage1 = mockStage({ stage_order: 0 });
    const stage2 = mockStage({
      id: STAGE_ID_2,
      stage_order: 1,
      fan_out_field: 'links',
      input_schema: {},
    });

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([stage1, stage2]);
    // 3. stage1 (normal): createStageRun + updateStageRun
    mockCreateStageRun();
    mockUpdateStageRun({ status: 'completed' });
    // 4. stage2 (fan-out): createStageRun
    mockCreateStageRun({ id: STAGE_RUN_ID_2, stage_id: STAGE_ID_2, stage_order: 1 });
    // 5. empty array → updateStageRun with output: []
    mockUpdateStageRun({ id: STAGE_RUN_ID_2, status: 'completed', output: [] });
    // 6. updateSchedulerRun → completed (lastOutput = [])
    mockUpdateSchedulerRun({ status: 'completed', result: [] });
    // finally: updateScheduler
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    // Only stage 1 executes via crawler; fan-out stage has empty array
    expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(1);
  });

  it('fails run when all fan-out items fail', async () => {
    const { dependencies, crawlerExecutionClient, logger } = createDependencies();

    crawlerExecutionClient.execute
      .mockReset()
      .mockImplementationOnce(async () => ({ type: 'data' as const, result: { data: 'stage1' } }))
      .mockImplementationOnce(async () => { throw new Error('fan-out item 1 failed'); })
      .mockImplementationOnce(async () => { throw new Error('fan-out item 2 failed'); });

    const stage1 = mockStage({ stage_order: 0 });
    const stage2 = mockStage({
      id: STAGE_ID_2,
      stage_order: 1,
      fan_out_field: 'items',
      input_schema: {},
    });

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([stage1, stage2]);
    // 3. stage1: createStageRun + updateStageRun
    mockCreateStageRun();
    mockUpdateStageRun({ status: 'completed' });
    // 4. stage2 fan-out: createStageRun
    mockCreateStageRun({ id: STAGE_RUN_ID_2, stage_id: STAGE_ID_2, stage_order: 1 });
    // 5. executeFanOut → all fail → status: 'failed'
    // 6. updateStageRun with status: 'failed'
    mockUpdateStageRun({ id: STAGE_RUN_ID_2, status: 'failed' });
    // 7. throw → catch block: updateSchedulerRun → status: 'failed'
    mockUpdateSchedulerRun({ status: 'failed', error: 'Stage 1: all fan-out items failed' });
    // finally: updateScheduler
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler execution failed',
      expect.any(Error),
      expect.objectContaining({ function: 'executeScheduler' }),
    );
  });

  it('sets run status to partially_failed when some fan-out items fail', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();

    crawlerExecutionClient.execute
      .mockReset()
      .mockImplementationOnce(async () => ({ type: 'data' as const, result: { items: ['a', 'b'] } }))
      .mockImplementationOnce(async () => ({ type: 'data' as const, result: 'ok-a' }))
      .mockImplementationOnce(async () => { throw new Error('item b failed'); });

    const stage1 = mockStage({ stage_order: 0 });
    const stage2 = mockStage({
      id: STAGE_ID_2,
      stage_order: 1,
      fan_out_field: 'items',
      input_schema: {},
    });

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([stage1, stage2]);
    // 3. stage1: createStageRun + updateStageRun
    mockCreateStageRun();
    mockUpdateStageRun({ status: 'completed' });
    // 4. stage2 fan-out: createStageRun
    mockCreateStageRun({ id: STAGE_RUN_ID_2, stage_id: STAGE_ID_2, stage_order: 1 });
    // 5. executeFanOut → partially_failed
    // 6. updateStageRun with status: 'partially_failed'
    mockUpdateStageRun({ id: STAGE_RUN_ID_2, status: 'partially_failed' });
    // 7. updateSchedulerRun → partially_failed (hasPartialFailure = true)
    mockUpdateSchedulerRun({ status: 'partially_failed' });
    // finally: updateScheduler
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(3);
  });

  it('marks run as failed when a stage throws an error', async () => {
    const { dependencies, crawlerExecutionClient, logger } = createDependencies();

    crawlerExecutionClient.execute
      .mockReset()
      .mockRejectedValueOnce(new Error('Crawler connection timeout'));

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([mockStage()]);
    // 3. executeStage: createStageRun
    mockCreateStageRun();
    // 4. executeStage: crawler throws → updateStageRun with error
    mockUpdateStageRun({ status: 'failed', error: 'Crawler connection timeout' });
    // 5. catch: updateSchedulerRun → failed
    mockUpdateSchedulerRun({ status: 'failed', error: 'Crawler connection timeout' });
    // finally: updateScheduler
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler execution failed',
      expect.any(Error),
      expect.objectContaining({
        function: 'executeScheduler',
        metadata: { schedulerID: SCHEDULER_ID, runID: RUN_ID },
      }),
    );
  });

  it('always updates scheduler.last_run_at in finally block', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();

    crawlerExecutionClient.execute
      .mockReset()
      .mockRejectedValueOnce(new Error('Some error'));

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([mockStage()]);
    // 3. executeStage: createStageRun
    mockCreateStageRun();
    // 4. executeStage: crawler throws → updateStageRun with error
    mockUpdateStageRun({ status: 'failed' });
    // 5. catch: updateSchedulerRun → failed
    mockUpdateSchedulerRun({ status: 'failed' });
    // finally: updateScheduler → capture request body to verify last_run_at
    let capturedBody: Record<string, unknown> | undefined;
    fetchMock
      .get('https://supabase.example.com')
      .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'PATCH' })
      .reply(200, (request: { body: string }) => {
        capturedBody = JSON.parse(request.body as string) as Record<string, unknown>;
        return { data: JSON.stringify(mockSchedulerRow()) };
      });

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(capturedBody).toBeDefined();
    expect(capturedBody!.last_run_at).toBeDefined();
    expect(typeof capturedBody!.last_run_at).toBe('string');
  });

  it('logs error but does not throw when run status update fails in catch block', async () => {
    const { dependencies, crawlerExecutionClient, logger } = createDependencies();

    crawlerExecutionClient.execute
      .mockReset()
      .mockRejectedValueOnce(new Error('Crawler failed'));

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([mockStage()]);
    // 3. executeStage: createStageRun
    mockCreateStageRun();
    // 4. executeStage: crawler throws → updateStageRun with error
    mockUpdateStageRun({ status: 'failed' });
    // 5. catch: updateSchedulerRun → HTTP 500 error
    mockUpdateSchedulerRunError();
    // finally: updateScheduler
    mockUpdateScheduler();

    // Should NOT throw even though the catch-block update failed
    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    // Should log both the original error and the update failure
    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler execution failed',
      expect.any(Error),
      expect.objectContaining({ function: 'executeScheduler' }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to update run status after error',
      expect.any(Error),
      expect.objectContaining({ function: 'executeScheduler' }),
    );
  });

  it('throws error when fan_out_field references a non-existent field', async () => {
    const { dependencies, crawlerExecutionClient, logger } = createDependencies([
      { data: 'no-links-field' },
    ]);

    const stage1 = mockStage({ stage_order: 0 });
    const stage2 = mockStage({
      id: STAGE_ID_2,
      stage_order: 1,
      fan_out_field: 'links',
      input_schema: {},
    });

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([stage1, stage2]);
    // 3. stage1: createStageRun + updateStageRun
    mockCreateStageRun();
    mockUpdateStageRun({ status: 'completed' });
    // 4. fan_out_field 'links' not found in input → throws
    // 5. catch: updateSchedulerRun → failed
    mockUpdateSchedulerRun({ status: 'failed' });
    // finally: updateScheduler
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler execution failed',
      expect.objectContaining({
        message: expect.stringContaining('fan_out_field "links" not found in input'),
      }),
      expect.objectContaining({ function: 'executeScheduler' }),
    );
  });

  it('throws error when fan_out_field references a non-array value', async () => {
    const { dependencies, crawlerExecutionClient, logger } = createDependencies([
      { links: 'not-an-array' },
    ]);

    const stage1 = mockStage({ stage_order: 0 });
    const stage2 = mockStage({
      id: STAGE_ID_2,
      stage_order: 1,
      fan_out_field: 'links',
      input_schema: {},
    });

    // 1. updateSchedulerRun → running
    mockUpdateSchedulerRun({ status: 'running' });
    // 2. listSchedulerStages
    mockListSchedulerStages([stage1, stage2]);
    // 3. stage1: createStageRun + updateStageRun
    mockCreateStageRun();
    mockUpdateStageRun({ status: 'completed' });
    // 4. fan_out_field 'links' is not array → throws
    // 5. catch: updateSchedulerRun → failed
    mockUpdateSchedulerRun({ status: 'failed' });
    // finally: updateScheduler
    mockUpdateScheduler();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(logger.error).toHaveBeenCalledWith(
      'Scheduler execution failed',
      expect.objectContaining({
        message: expect.stringContaining('fan_out_field "links" is not an array'),
      }),
      expect.objectContaining({ function: 'executeScheduler' }),
    );
  });
});
