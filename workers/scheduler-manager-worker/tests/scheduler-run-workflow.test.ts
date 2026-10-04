import { describe, it, expect, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import worker, { type Environment } from '../sources/index.ts';
import { SchedulerRunWorkflow, type SchedulerRunParameters } from '../sources/scheduler-run-workflow.ts';
import type { ScheduledPipelineStep } from '../sources/scheduled-pipeline.ts';
import type { TaskGroupStartRequest } from '../sources/task-group-worker.ts';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const STAGE_ID = '00000000-0000-0000-0000-000000000022';
const BINDING = 'TASK_GROUP_TEST';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

/**
 * The constructor of WorkflowEntrypoint only accepts an ExecutionContext workerd created itself, and
 * rejects the stand-in createExecutionContext() returns ("constructor parameter 1 is not of type
 * 'ExecutionContext'"). The main worker runs in the isolate of the test and receives a real one in
 * fetch(), so the test takes it from a request to SELF.
 */
async function receiveExecutionContext(): Promise<ExecutionContext> {
  const received: { executionContext?: ExecutionContext } = {};
  const spy = vi.spyOn(worker, 'fetch').mockImplementation((async (_request: Request, _environment: Environment, executionContext: ExecutionContext) => {
    received.executionContext = executionContext;
    return new Response(null, { status: 204 });
  }) as unknown as typeof worker.fetch);
  try {
    await SELF.fetch('https://worker.example.com/');
  } finally {
    spy.mockRestore();
  }
  if (received.executionContext === undefined) throw new Error('The main worker did not receive an execution context');
  return received.executionContext;
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
    created_at: '2026-10-05T21:55:00.000Z',
  }];
  supabase.tables.scheduler_stages = [{
    id: STAGE_ID,
    scheduler_id: SCHEDULER_ID,
    stage_type: 'task_group',
    crawler_id: null,
    task_group_id: 'newscast',
    task_group_version: 2,
    settings: { voice: 'calm' },
    stage_order: 0,
    input_schema: {},
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-01-01T00:00:00Z',
  }];
  supabase.tables.task_groups = [{
    id: 'newscast',
    version: 2,
    input_schema: { type: 'object' },
    settings_schema: { type: 'object' },
    output_schema: {},
    worker_binding: BINDING,
    created_at: '2026-10-04T00:00:00Z',
  }];
}

function createTaskGroupWorker() {
  return { startTaskGroupRun: vi.fn(async (_request: TaskGroupStartRequest) => {}) };
}

// Calls the callback of every step at once; while the run waits, the group reports its output
function createFakeStep(): WorkflowStep {
  const step: ScheduledPipelineStep = {
    async do<T>(_name: string, _options: unknown, callback: () => Promise<T>): Promise<T> {
      return await callback();
    },
    async waitForEvent(_name: string, options: { type: string }): Promise<unknown> {
      const stageRun = (supabase.tables.scheduler_stage_runs as Row[])[0];
      Object.assign(stageRun, { status: 'completed', output: { episode: 'reported' }, completed_at: '2026-10-05T22:30:00.000Z' });
      return { type: options.type, payload: {}, timestamp: new Date() };
    },
  };
  return step as unknown as WorkflowStep;
}

function manualEvent(): WorkflowEvent<SchedulerRunParameters> {
  return { payload: { schedulerID: SCHEDULER_ID, runID: RUN_ID }, timestamp: new Date(), instanceId: `manual-${RUN_ID}` };
}

describe('SchedulerRunWorkflow', () => {
  it('starts a task group through the service binding its registration names in the environment', async () => {
    seed();
    const taskGroupWorker = createTaskGroupWorker();
    const workflow = new SchedulerRunWorkflow(await receiveExecutionContext(), { ...env, [BINDING]: taskGroupWorker } as unknown as Environment);

    const result = await workflow.run(manualEvent(), createFakeStep());

    const stageRun = (supabase.tables.scheduler_stage_runs as Row[])[0];
    expect(taskGroupWorker.startTaskGroupRun).toHaveBeenCalledTimes(1);
    expect(taskGroupWorker.startTaskGroupRun).toHaveBeenCalledWith({
      stageRunID: stageRun.id,
      taskGroupID: 'newscast',
      taskGroupVersion: 2,
      input: {},
      settings: { voice: 'calm' },
      userUUID: USER_UUID,
    });
    expect(result).toEqual({ outcome: 'started', runID: RUN_ID, status: 'completed' });
    expect((supabase.tables.scheduler_runs as Row[])[0]).toMatchObject({ status: 'completed', result: { episode: 'reported' } });
  });

  it('fails the stage when the environment has no binding of the name its registration gives', async () => {
    seed();
    const taskGroupWorker = createTaskGroupWorker();
    const workflow = new SchedulerRunWorkflow(await receiveExecutionContext(), { ...env, TASK_GROUP_OTHER: taskGroupWorker } as unknown as Environment);

    const result = await workflow.run(manualEvent(), createFakeStep());

    const error = `Stage 0: task group worker '${BINDING}' is not connected`;
    expect(taskGroupWorker.startTaskGroupRun).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'started', runID: RUN_ID, status: 'failed' });
    expect((supabase.tables.scheduler_runs as Row[])[0]).toMatchObject({ status: 'failed', error });
  });
});
