import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { SchedulerStageRow } from '@audio-underview/supabase-connector';
import type { CrawlerExecutionClient } from '../sources/crawler-execution-client.ts';
import type { Logger } from '@audio-underview/logger';
import {
  resolveDefaultInput,
  executeStage,
  executeFanOut,
} from '../sources/stage-runner.ts';
import type { StageRunnerDependencies } from '../sources/stage-runner.ts';

const MOCK_SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const MOCK_STAGE_ID = '00000000-0000-0000-0000-000000000020';
const MOCK_CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const MOCK_RUN_ID = '00000000-0000-0000-0000-000000000040';
const MOCK_STAGE_RUN_ID = '00000000-0000-0000-0000-000000000050';

function mockStage(overrides: Partial<SchedulerStageRow> = {}): SchedulerStageRow {
  return {
    id: MOCK_STAGE_ID,
    scheduler_id: MOCK_SCHEDULER_ID,
    crawler_id: MOCK_CRAWLER_ID,
    stage_order: 0,
    input_schema: { url: { type: 'string', default: 'https://example.com' } },
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as SchedulerStageRow;
}

function mockStageRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MOCK_STAGE_RUN_ID,
    run_id: MOCK_RUN_ID,
    stage_id: MOCK_STAGE_ID,
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

function mockSupabaseStageRunCreate(overrides: Record<string, unknown> = {}) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/scheduler_stage_runs/, method: 'POST' })
    .reply(201, JSON.stringify(mockStageRunRow(overrides)));
}

function mockSupabaseStageRunUpdate(overrides: Record<string, unknown> = {}) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/scheduler_stage_runs/, method: 'PATCH' })
    .reply(200, JSON.stringify(mockStageRunRow(overrides)));
}

function createMockCrawlerExecutionClient(): CrawlerExecutionClient & {
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    execute: vi.fn(),
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

function createDependencies(
  crawlerExecutionClient?: CrawlerExecutionClient,
): { dependencies: StageRunnerDependencies; crawlerExecutionClient: ReturnType<typeof createMockCrawlerExecutionClient>; logger: ReturnType<typeof createMockLogger> } {
  const client = (crawlerExecutionClient as ReturnType<typeof createMockCrawlerExecutionClient>) ?? createMockCrawlerExecutionClient();
  const logger = createMockLogger();
  const supabaseClient = createSupabaseClient({
    supabaseURL: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
  });
  return {
    dependencies: { supabaseClient, crawlerExecutionClient: client, logger },
    crawlerExecutionClient: client,
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

describe('resolveDefaultInput', () => {
  it('extracts default values from descriptor format', () => {
    const schema = {
      url: { type: 'string', default: 'https://example.com' },
      count: { type: 'number', default: 10 },
    };
    const result = resolveDefaultInput(schema);
    expect(result).toEqual({
      url: 'https://example.com',
      count: 10,
    });
  });

  it('skips fields without default', () => {
    const schema = {
      url: { type: 'string', default: 'https://example.com' },
      query: { type: 'string' },
    };
    const result = resolveDefaultInput(schema);
    expect(result).toEqual({ url: 'https://example.com' });
    expect(result).not.toHaveProperty('query');
  });

  it('returns empty object for schema with no defaults', () => {
    const schema = {
      url: { type: 'string' },
      query: { type: 'string' },
    };
    const result = resolveDefaultInput(schema);
    expect(result).toEqual({});
  });

  it('handles empty schema', () => {
    const result = resolveDefaultInput({});
    expect(result).toEqual({});
  });

  it('ignores non-object field values', () => {
    const schema = {
      url: 'not-an-object',
      count: 42,
      flag: null,
    };
    const result = resolveDefaultInput(schema as Record<string, unknown>);
    expect(result).toEqual({});
  });

  it('handles default value of null', () => {
    const schema = {
      optional: { type: 'string', default: null },
    };
    const result = resolveDefaultInput(schema);
    expect(result).toEqual({ optional: null });
  });

  it('handles default value of false', () => {
    const schema = {
      enabled: { type: 'boolean', default: false },
    };
    const result = resolveDefaultInput(schema);
    expect(result).toEqual({ enabled: false });
  });
});

describe('executeStage', () => {
  it('calls crawlerExecutionClient.execute and returns output with stageRun', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();
    const stage = mockStage();
    const input = { url: 'https://example.com' };
    const crawlerResult = { items: [1, 2, 3] };

    crawlerExecutionClient.execute.mockResolvedValue({ type: 'data', result: crawlerResult });

    mockSupabaseStageRunCreate();
    mockSupabaseStageRunUpdate({ status: 'completed', output: crawlerResult });

    const result = await executeStage(dependencies, MOCK_RUN_ID, stage, input);

    expect(crawlerExecutionClient.execute).toHaveBeenCalledWith(MOCK_CRAWLER_ID, input);
    expect(result.output).toEqual(crawlerResult);
    expect(result.stageRun.status).toBe('completed');
  });

  it('creates stage_run with status running then updates to completed', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();
    const stage = mockStage();
    const crawlerResult = { data: 'test' };

    crawlerExecutionClient.execute.mockResolvedValue({ type: 'data', result: crawlerResult });

    mockSupabaseStageRunCreate({ status: 'running' });
    mockSupabaseStageRunUpdate({ status: 'completed', output: crawlerResult });

    const result = await executeStage(dependencies, MOCK_RUN_ID, stage, {});

    expect(result.stageRun.id).toBe(MOCK_STAGE_RUN_ID);
    expect(result.output).toEqual(crawlerResult);
  });

  it('updates stage_run to failed and re-throws on error', async () => {
    const { dependencies, crawlerExecutionClient, logger } = createDependencies();
    const stage = mockStage();
    const executionError = new Error('Crawler execution failed');

    crawlerExecutionClient.execute.mockRejectedValue(executionError);

    mockSupabaseStageRunCreate({ status: 'running' });
    mockSupabaseStageRunUpdate({ status: 'failed', error: 'Crawler execution failed' });

    await expect(executeStage(dependencies, MOCK_RUN_ID, stage, {})).rejects.toThrow(
      'Crawler execution failed',
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Stage execution failed',
      executionError,
      expect.objectContaining({
        function: 'executeStage',
        metadata: { stageID: MOCK_STAGE_ID, stageOrder: 0 },
      }),
    );
  });

  it('passes stage.crawler_id to crawlerExecutionClient.execute', async () => {
    const customCrawlerID = '00000000-0000-0000-0000-999999999999';
    const { dependencies, crawlerExecutionClient } = createDependencies();
    const stage = mockStage({ crawler_id: customCrawlerID });

    crawlerExecutionClient.execute.mockResolvedValue({ type: 'web', result: {} });

    mockSupabaseStageRunCreate();
    mockSupabaseStageRunUpdate({ status: 'completed' });

    await executeStage(dependencies, MOCK_RUN_ID, stage, { key: 'value' });

    expect(crawlerExecutionClient.execute).toHaveBeenCalledWith(customCrawlerID, { key: 'value' });
  });

  it('falls back to original stageRun if update returns null', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();
    const stage = mockStage();

    crawlerExecutionClient.execute.mockResolvedValue({ type: 'data', result: 'output' });

    mockSupabaseStageRunCreate({ status: 'running' });

    // Simulate PGRST116 (no rows updated) → supabase returns 406
    fetchMock
      .get('https://supabase.example.com')
      .intercept({ path: /^\/rest\/v1\/scheduler_stage_runs/, method: 'PATCH' })
      .reply(406, JSON.stringify({
        code: 'PGRST116',
        details: 'The result contains 0 rows',
        hint: null,
        message: 'JSON object requested, multiple (or no) rows returned',
      }));

    const result = await executeStage(dependencies, MOCK_RUN_ID, stage, {});

    // When updateSchedulerStageRun returns null, fallback to original stageRun
    expect(result.stageRun.id).toBe(MOCK_STAGE_RUN_ID);
    expect(result.stageRun.status).toBe('running');
  });
});

describe('executeFanOut', () => {
  it('executes each item sequentially and returns all results', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();
    const stage = mockStage();
    const items = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];

    crawlerExecutionClient.execute
      .mockResolvedValueOnce({ type: 'data', result: 'result-a' })
      .mockResolvedValueOnce({ type: 'data', result: 'result-b' })
      .mockResolvedValueOnce({ type: 'data', result: 'result-c' });

    const result = await executeFanOut(dependencies, stage, items);

    expect(result.results).toEqual(['result-a', 'result-b', 'result-c']);
    expect(result.itemsTotal).toBe(3);
    expect(result.itemsSucceeded).toBe(3);
    expect(result.itemsFailed).toBe(0);
    expect(result.status).toBe('completed');
  });

  it('returns completed status when all items succeed', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();
    const stage = mockStage();

    crawlerExecutionClient.execute.mockResolvedValue({ type: 'data', result: 'ok' });

    const result = await executeFanOut(dependencies, stage, [{ a: 1 }, { a: 2 }]);

    expect(result.status).toBe('completed');
    expect(result.itemsFailed).toBe(0);
    expect(result.itemsSucceeded).toBe(2);
  });

  it('returns partially_failed when some items fail', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();
    const stage = mockStage();

    crawlerExecutionClient.execute
      .mockResolvedValueOnce({ type: 'data', result: 'ok' })
      .mockRejectedValueOnce(new Error('item failed'))
      .mockResolvedValueOnce({ type: 'data', result: 'ok' });

    const result = await executeFanOut(dependencies, stage, ['a', 'b', 'c']);

    expect(result.status).toBe('partially_failed');
    expect(result.itemsSucceeded).toBe(2);
    expect(result.itemsFailed).toBe(1);
    expect(result.itemsTotal).toBe(3);
    expect(result.results).toEqual(['ok', 'ok']);
  });

  it('returns failed when all items fail', async () => {
    const { dependencies, crawlerExecutionClient, logger } = createDependencies();
    const stage = mockStage();

    crawlerExecutionClient.execute
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'));

    const result = await executeFanOut(dependencies, stage, ['a', 'b']);

    expect(result.status).toBe('failed');
    expect(result.itemsSucceeded).toBe(0);
    expect(result.itemsFailed).toBe(2);
    expect(result.itemsTotal).toBe(2);
    expect(result.results).toEqual([]);
  });

  it('preserves null results from successful crawlers', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();
    const stage = mockStage();

    crawlerExecutionClient.execute
      .mockResolvedValueOnce({ type: 'web', result: 'first' })
      .mockResolvedValueOnce({ type: 'web', result: null })
      .mockResolvedValueOnce({ type: 'web', result: 'third' });

    const result = await executeFanOut(dependencies, stage, ['a', 'b', 'c']);

    expect(result.status).toBe('completed');
    expect(result.itemsSucceeded).toBe(3);
    expect(result.results).toEqual(['first', null, 'third']);
  });

  it('handles empty items array', async () => {
    const { dependencies } = createDependencies();
    const stage = mockStage();

    const result = await executeFanOut(dependencies, stage, []);

    expect(result.results).toEqual([]);
    expect(result.itemsTotal).toBe(0);
    expect(result.itemsSucceeded).toBe(0);
    expect(result.itemsFailed).toBe(0);
    // With 0 failed items, status is 'completed'
    expect(result.status).toBe('completed');
  });

  it('logs warning for each failed item', async () => {
    const { dependencies, crawlerExecutionClient, logger } = createDependencies();
    const stage = mockStage();
    const error1 = new Error('fail-1');
    const error2 = new Error('fail-2');

    crawlerExecutionClient.execute
      .mockRejectedValueOnce(error1)
      .mockRejectedValueOnce(error2);

    await executeFanOut(dependencies, stage, ['a', 'b']);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Fan-out item failed',
      error1,
      expect.objectContaining({
        function: 'executeFanOut',
        metadata: { stageID: MOCK_STAGE_ID, itemIndex: 0 },
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Fan-out item failed',
      error2,
      expect.objectContaining({
        function: 'executeFanOut',
        metadata: { stageID: MOCK_STAGE_ID, itemIndex: 1 },
      }),
    );
  });

  it('calls execute with correct crawler_id for each item', async () => {
    const { dependencies, crawlerExecutionClient } = createDependencies();
    const stage = mockStage();

    crawlerExecutionClient.execute.mockResolvedValue({ type: 'data', result: null });

    const items = [{ url: 'x' }, { url: 'y' }];
    await executeFanOut(dependencies, stage, items);

    expect(crawlerExecutionClient.execute).toHaveBeenCalledTimes(2);
    expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(1, MOCK_CRAWLER_ID, { url: 'x' });
    expect(crawlerExecutionClient.execute).toHaveBeenNthCalledWith(2, MOCK_CRAWLER_ID, { url: 'y' });
  });
});
