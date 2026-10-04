import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Logger } from '@audio-underview/logger';
import { type ResponseContext, signJWT } from '@audio-underview/worker-tools';
import worker from '../sources/index.ts';
import type { Environment } from '../sources/index.ts';
import { handleExecuteScheduler } from '../sources/handlers/scheduler-execution.ts';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const STAGE_ID = '00000000-0000-0000-0000-000000000020';
const TASK_GROUP_STAGE_ID = '00000000-0000-0000-0000-000000000022';
const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

function schedulerRow(): Row {
  return {
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
  };
}

function crawlerStageRow(): Row {
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
  };
}

function taskGroupStageRow(): Row {
  return {
    ...crawlerStageRow(),
    id: TASK_GROUP_STAGE_ID,
    stage_type: 'task_group',
    crawler_id: null,
    task_group_id: 'newscast',
    task_group_version: 1,
    settings: {},
    stage_order: 1,
    input_schema: {},
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

function createEnvironment(options: { createError?: Error } = {}) {
  const crawlerManager = {
    executeCrawler: vi.fn(async () => ({ type: 'data', result: { title: 'Example' } })),
  };
  const workflow = {
    create: vi.fn(async (instance: { id: string }) => {
      if (options.createError !== undefined) throw options.createError;
      return { id: instance.id };
    }),
    createBatch: vi.fn(),
    get: vi.fn(),
  };
  const environment = {
    ...env,
    CRAWLER_MANAGER: crawlerManager,
    SCHEDULER_RUN_WORKFLOW: workflow,
  } as unknown as Environment;
  return { environment, crawlerManager, workflow };
}

function createContext(): ResponseContext {
  return { origin: 'https://example.com', allowedOrigins: env.ALLOWED_ORIGINS, logger: createMockLogger() };
}

// What the unique partial index scheduler_runs_one_active_per_scheduler does in the database
function enforceOneActiveRunPerScheduler() {
  supabase.intercept = (request) => {
    if (request.method !== 'POST' || request.table !== 'scheduler_runs') return undefined;
    const activeRuns = (supabase.tables.scheduler_runs ?? []).filter((run) => run.status === 'pending' || run.status === 'running');
    return activeRuns.length === 0
      ? undefined
      : {
          statusCode: 409,
          data: {
            code: '23505',
            details: null,
            hint: null,
            message: 'duplicate key value violates unique constraint "scheduler_runs_one_active_per_scheduler"',
          },
        };
  };
}

async function executeRequest(): Promise<Request> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ sub: USER_UUID, iat: now, exp: now + 86400 }, JWT_SECRET);
  return new Request(`https://worker.example.com/schedulers/${SCHEDULER_ID}/execute`, {
    method: 'POST',
    headers: { Origin: 'https://example.com', Authorization: `Bearer ${token}` },
  });
}

function onlyRun(): Row {
  const runs = supabase.tables.scheduler_runs ?? [];
  expect(runs).toHaveLength(1);
  return runs[0];
}

describe('handleExecuteScheduler', () => {
  it('runs a scheduler with crawler stages only inside the request, reading the stages once', async () => {
    supabase.tables.schedulers = [schedulerRow()];
    supabase.tables.scheduler_stages = [crawlerStageRow()];
    const { environment, crawlerManager, workflow } = createEnvironment();

    const response = await handleExecuteScheduler(environment, createContext(), SCHEDULER_ID, USER_UUID);

    expect(response.status).toBe(200);
    const run = onlyRun();
    expect(await response.json()).toEqual({
      run_id: run.id,
      status: 'completed',
      result: { title: 'Example' },
      error: null,
      started_at: expect.any(String),
      completed_at: expect.any(String),
    });
    expect(run).toMatchObject({ status: 'completed', result: { title: 'Example' } });
    expect(crawlerManager.executeCrawler).toHaveBeenCalledWith(CRAWLER_ID, { url: 'https://example.com' });
    expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(1);
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it('records the failure in the run and answers as before when the stages cannot be read', async () => {
    supabase.tables.schedulers = [schedulerRow()];
    supabase.intercept = (request) => (
      request.method === 'GET' && request.table === 'scheduler_stages'
        ? { statusCode: 500, data: { message: 'connection reset' } }
        : undefined
    );
    const { environment, crawlerManager, workflow } = createEnvironment();

    const response = await handleExecuteScheduler(environment, createContext(), SCHEDULER_ID, USER_UUID);

    const run = onlyRun();
    expect(run).toMatchObject({ status: 'failed', error: 'Failed to list scheduler stages: connection reset' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      run_id: run.id,
      status: 'failed',
      result: null,
      error: 'Failed to list scheduler stages: connection reset',
      started_at: expect.any(String),
      completed_at: expect.any(String),
    });
    // Read by the handler, then again by executeScheduler
    expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(2);
    expect(crawlerManager.executeCrawler).not.toHaveBeenCalled();
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it('starts a Workflow instance and answers 202 at once when a stage is a task group stage', async () => {
    supabase.tables.schedulers = [schedulerRow()];
    supabase.tables.scheduler_stages = [crawlerStageRow(), taskGroupStageRow()];
    const { environment, crawlerManager, workflow } = createEnvironment();

    const response = await handleExecuteScheduler(environment, createContext(), SCHEDULER_ID, USER_UUID);

    const run = onlyRun();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      run_id: run.id,
      status: 'pending',
      result: null,
      error: null,
      started_at: null,
      completed_at: null,
    });
    expect(workflow.create).toHaveBeenCalledTimes(1);
    expect(workflow.create).toHaveBeenCalledWith({
      id: `manual-${run.id}`,
      params: { schedulerID: SCHEDULER_ID, runID: run.id },
    });
    // No stage runs inside the request
    expect(crawlerManager.executeCrawler).not.toHaveBeenCalled();
    expect(supabase.tables.scheduler_stage_runs ?? []).toEqual([]);
    expect(run).toMatchObject({ status: 'pending', started_at: null });
    expect(supabase.requestsOf('PATCH', 'scheduler_runs')).toHaveLength(0);
  });

  it('fails the run and throws when the instance cannot be created', async () => {
    supabase.tables.schedulers = [schedulerRow()];
    supabase.tables.scheduler_stages = [taskGroupStageRow()];
    const { environment } = createEnvironment({ createError: new Error('workflow unavailable') });

    await expect(
      handleExecuteScheduler(environment, createContext(), SCHEDULER_ID, USER_UUID),
    ).rejects.toThrow('workflow unavailable');

    expect(onlyRun()).toMatchObject({ status: 'failed', error: 'Run could not be started', completed_at: expect.any(String) });
    const update = supabase.requestsOf('PATCH', 'scheduler_runs')[0];
    expect(update.query.get('status')).toBe('in.(pending)');
  });

  it('runs the stages when only the first read of them fails: the request goes on without a list and the execution reads them itself', async () => {
    supabase.tables.schedulers = [schedulerRow()];
    supabase.tables.scheduler_stages = [crawlerStageRow()];
    let reads = 0;
    supabase.intercept = (request) => {
      if (request.method !== 'GET' || request.table !== 'scheduler_stages') return undefined;
      reads += 1;
      return reads === 1 ? { statusCode: 500, data: { message: 'connection reset' } } : undefined;
    };
    const { environment, crawlerManager, workflow } = createEnvironment();

    const response = await handleExecuteScheduler(environment, createContext(), SCHEDULER_ID, USER_UUID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run_id: onlyRun().id,
      status: 'completed',
      result: { title: 'Example' },
      error: null,
      started_at: expect.any(String),
      completed_at: expect.any(String),
    });
    // Read by the handler, which failed, then again by executeScheduler, which ran them
    expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(2);
    expect(crawlerManager.executeCrawler).toHaveBeenCalledTimes(1);
    expect(workflow.create).not.toHaveBeenCalled();
  });

  describe('when the instance cannot be created', () => {
    it('answers 500 through the worker, and the next request is not blocked by the closed run', async () => {
      supabase.tables.schedulers = [schedulerRow()];
      supabase.tables.scheduler_stages = [taskGroupStageRow()];
      enforceOneActiveRunPerScheduler();
      const { environment, workflow } = createEnvironment();
      workflow.create.mockRejectedValueOnce(new Error('workflow unavailable'));

      const failed = await worker.fetch(await executeRequest(), environment);

      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ error: 'server_error' });
      expect(supabase.tables.scheduler_runs[0]).toMatchObject({ status: 'failed', error: 'Run could not be started' });

      const next = await worker.fetch(await executeRequest(), environment);

      expect(next.status).toBe(202);
      expect(workflow.create).toHaveBeenCalledTimes(2);
      expect(supabase.tables.scheduler_runs).toHaveLength(2);
      expect(supabase.tables.scheduler_runs[1]).toMatchObject({ status: 'pending' });
    });

    it('still throws the error of the instance when closing the run fails too', async () => {
      supabase.tables.schedulers = [schedulerRow()];
      supabase.tables.scheduler_stages = [taskGroupStageRow()];
      supabase.intercept = (request) => (
        request.method === 'PATCH' && request.table === 'scheduler_runs'
          ? { statusCode: 500, data: { message: 'cannot close' } }
          : undefined
      );
      const { environment } = createEnvironment({ createError: new Error('workflow unavailable') });

      await expect(
        handleExecuteScheduler(environment, createContext(), SCHEDULER_ID, USER_UUID),
      ).rejects.toThrow('workflow unavailable');

      // The close was tried, and the run stayed as it was
      expect(supabase.requestsOf('PATCH', 'scheduler_runs')).toHaveLength(1);
      expect(onlyRun()).toMatchObject({ status: 'pending', error: null });
    });
  });

  it('answers 409 while another run is in progress', async () => {
    supabase.tables.schedulers = [schedulerRow()];
    supabase.tables.scheduler_stages = [taskGroupStageRow()];
    supabase.intercept = (request) => (
      request.method === 'POST' && request.table === 'scheduler_runs'
        ? {
            statusCode: 409,
            data: {
              code: '23505',
              details: null,
              hint: null,
              message: 'duplicate key value violates unique constraint "scheduler_runs_one_active_per_scheduler"',
            },
          }
        : undefined
    );
    const { environment, workflow } = createEnvironment();

    const response = await handleExecuteScheduler(environment, createContext(), SCHEDULER_ID, USER_UUID);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'conflict', error_description: 'A run is already in progress' });
    expect(workflow.create).not.toHaveBeenCalled();
  });
});
