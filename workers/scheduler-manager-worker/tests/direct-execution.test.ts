import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { SchedulerStageRow } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import type { CrawlerExecutionClient } from '../sources/crawler-execution-client.ts';
import { executePipelineStage, executeScheduler } from '../sources/scheduler-executor.ts';
import type { ExecutorDependencies } from '../sources/scheduler-executor.ts';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

// The cases the protected executor test files cannot hold: what the direct execution does with
// a task group stage, a stage without a crawler and a list of stages it is given.

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const CRAWLER_STAGE_ID = '00000000-0000-0000-0000-000000000020';
const TASK_GROUP_STAGE_ID = '00000000-0000-0000-0000-000000000021';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const RUN_ID = '00000000-0000-0000-0000-000000000040';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

function crawlerStage(overrides: Partial<SchedulerStageRow> = {}): SchedulerStageRow {
  return {
    id: CRAWLER_STAGE_ID,
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
  };
}

function taskGroupStage(overrides: Partial<SchedulerStageRow> = {}): SchedulerStageRow {
  return crawlerStage({
    id: TASK_GROUP_STAGE_ID,
    stage_type: 'task_group',
    crawler_id: null,
    task_group_id: 'newscast',
    task_group_version: 1,
    settings: { topic: 'tech' },
    stage_order: 1,
    input_schema: {},
    ...overrides,
  });
}

function seed() {
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
  supabase.tables.scheduler_runs = [{
    id: RUN_ID,
    scheduler_id: SCHEDULER_ID,
    status: 'pending',
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-05T22:00:00.000Z',
  }];
}

function run(): Row {
  return supabase.tables.scheduler_runs[0];
}

function createDependencies() {
  const execute = vi.fn(async (_crawlerID: string, _input: unknown) => ({
    type: 'data' as const,
    result: { extracted: 'data' },
  }));
  const crawlerExecutionClient: CrawlerExecutionClient = { execute };
  const dependencies: ExecutorDependencies = {
    supabaseClient: createSupabaseClient({
      supabaseURL: env.SUPABASE_URL,
      supabaseSecretKey: env.SUPABASE_SECRET_KEY,
    }),
    crawlerExecutionClient,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      createChild: vi.fn().mockReturnThis(),
    } as unknown as Logger,
  };
  return { dependencies, execute };
}

describe('executePipelineStage', () => {
  it('throws for a task group stage, which only a Workflow instance runs, and records nothing', async () => {
    seed();
    const { dependencies, execute } = createDependencies();

    await expect(
      executePipelineStage(dependencies, RUN_ID, taskGroupStage(), {}),
    ).rejects.toThrow('Stage 1: a task group stage cannot run in a direct execution');

    expect(execute).not.toHaveBeenCalled();
    expect(supabase.requests).toEqual([]);
  });

  it('throws for a stage without a crawler, and records nothing', async () => {
    seed();
    const { dependencies, execute } = createDependencies();

    await expect(
      executePipelineStage(dependencies, RUN_ID, crawlerStage({ crawler_id: null }), {}),
    ).rejects.toThrow('Stage 0: crawler is missing');

    expect(execute).not.toHaveBeenCalled();
    expect(supabase.requests).toEqual([]);
  });

  it('still runs a crawler stage and records its stage run', async () => {
    seed();
    const { dependencies, execute } = createDependencies();

    const result = await executePipelineStage(dependencies, RUN_ID, crawlerStage(), { url: 'https://example.com' });

    expect(result).toMatchObject({ output: { extracted: 'data' }, partiallyFailed: false });
    expect(execute).toHaveBeenCalledWith(CRAWLER_ID, { url: 'https://example.com' });
    expect(supabase.tables.scheduler_stage_runs).toHaveLength(1);
    expect(supabase.tables.scheduler_stage_runs[0]).toMatchObject({
      run_id: RUN_ID,
      stage_id: CRAWLER_STAGE_ID,
      status: 'completed',
      output: { extracted: 'data' },
    });
  });

  it('still runs a stage row without stage_type as a crawler stage', async () => {
    seed();
    const { dependencies, execute } = createDependencies();
    const { stage_type: _stageType, ...stageWithoutType } = crawlerStage();

    await executePipelineStage(dependencies, RUN_ID, stageWithoutType as unknown as SchedulerStageRow, {});

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(CRAWLER_ID, {});
    expect(supabase.tables.scheduler_stage_runs).toHaveLength(1);
  });
});

describe('executeScheduler', () => {
  it('runs the stages it is given without reading them', async () => {
    seed();
    const { dependencies, execute } = createDependencies();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID, undefined, [crawlerStage()]);

    expect(supabase.requestsOf('GET', 'scheduler_stages')).toEqual([]);
    expect(execute).toHaveBeenCalledWith(CRAWLER_ID, { url: 'https://example.com' });
    expect(run()).toMatchObject({ status: 'completed', result: { extracted: 'data' } });
  });

  it('reads the stages when it is not given any', async () => {
    seed();
    supabase.tables.scheduler_stages = [crawlerStage() as unknown as Row];
    const { dependencies, execute } = createDependencies();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID);

    expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(1);
    expect(execute).toHaveBeenCalledWith(CRAWLER_ID, { url: 'https://example.com' });
    expect(run()).toMatchObject({ status: 'completed', result: { extracted: 'data' } });
  });

  it('completes with a null result for an empty list it is given, without reading the stages', async () => {
    seed();
    // Stages that would run if the empty list were taken for no list
    supabase.tables.scheduler_stages = [crawlerStage() as unknown as Row];
    const { dependencies, execute } = createDependencies();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID, undefined, []);

    expect(supabase.requestsOf('GET', 'scheduler_stages')).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(run()).toMatchObject({ status: 'completed', result: null });
  });

  it('fails the run when a task group stage is in the list it is given, after the stages before it ran', async () => {
    seed();
    const { dependencies, execute } = createDependencies();

    await executeScheduler(dependencies, SCHEDULER_ID, USER_UUID, RUN_ID, undefined, [crawlerStage(), taskGroupStage()]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(run()).toMatchObject({
      status: 'failed',
      error: 'Stage 1: a task group stage cannot run in a direct execution',
      completed_at: expect.any(String),
    });
    // Only the crawler stage has a stage run
    expect(supabase.tables.scheduler_stage_runs.map((stageRun) => stageRun.stage_id)).toEqual([CRAWLER_STAGE_ID]);
  });
});
