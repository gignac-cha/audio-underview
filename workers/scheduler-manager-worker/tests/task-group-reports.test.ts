import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import {
  type TaskGroupReportDependencies,
  reportTaskGroupProgress,
  completeTaskGroupRun,
  failTaskGroupRun,
} from '../sources/task-group-reports.ts';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const STAGE_ID = '00000000-0000-0000-0000-000000000020';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const STAGE_RUN_ID = '00000000-0000-0000-0000-000000000050';
const MISSING_STAGE_RUN_ID = '00000000-0000-0000-0000-000000000059';
const SCHEDULED_FOR = '2026-10-05T22:00:00.000Z';
const SCHEDULED_RUN_INSTANCE_ID = `${SCHEDULER_ID}-29853960`;
const EVENT_TYPE = `task-group-finished-${STAGE_RUN_ID}`;

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

function runRow(overrides: Row = {}): Row {
  return {
    id: RUN_ID,
    scheduler_id: SCHEDULER_ID,
    status: 'running',
    started_at: '2026-10-05T22:00:00.000Z',
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'schedule',
    scheduled_for: SCHEDULED_FOR,
    created_at: '2026-10-05T22:00:00.000Z',
    ...overrides,
  };
}

function stageRunRow(overrides: Row = {}): Row {
  return {
    id: STAGE_RUN_ID,
    run_id: RUN_ID,
    stage_id: STAGE_ID,
    stage_order: 2,
    status: 'running',
    started_at: '2026-10-05T22:01:00.000Z',
    completed_at: null,
    input: { urls: ['https://a.com'] },
    output: null,
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    task_group_id: 'newscast',
    task_group_version: 1,
    progress: null,
    created_at: '2026-10-05T22:01:00.000Z',
    ...overrides,
  };
}

function taskGroupRow(overrides: Row = {}): Row {
  return {
    id: 'newscast',
    version: 1,
    input_schema: {},
    settings_schema: {},
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

function seed(tables: { runs?: Row[]; stageRuns?: Row[]; taskGroups?: Row[] } = {}) {
  supabase.tables.scheduler_runs = tables.runs ?? [runRow()];
  supabase.tables.scheduler_stage_runs = tables.stageRuns ?? [stageRunRow()];
  supabase.tables.task_groups = tables.taskGroups ?? [taskGroupRow()];
}

function stageRun(): Row | undefined {
  return supabase.tables.scheduler_stage_runs?.find((row) => row.id === STAGE_RUN_ID);
}

function createFakeWorkflow(options: { sendEventError?: Error; getError?: Error } = {}) {
  const events: { instanceID: string; type: string; payload: unknown }[] = [];
  const get = vi.fn(async (instanceID: string) => {
    if (options.getError !== undefined) throw options.getError;
    return {
      id: instanceID,
      sendEvent: async (event: { type: string; payload: unknown }) => {
        if (options.sendEventError !== undefined) throw options.sendEventError;
        events.push({ instanceID, ...event });
      },
    };
  });
  return { get, events };
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

function createDependencies(workflow: ReturnType<typeof createFakeWorkflow>): TaskGroupReportDependencies {
  return {
    supabaseClient: createSupabaseClient({
      supabaseURL: env.SUPABASE_URL,
      supabaseSecretKey: env.SUPABASE_SECRET_KEY,
    }),
    workflow: workflow as unknown as TaskGroupReportDependencies['workflow'],
    logger: createMockLogger(),
  };
}

describe('reportTaskGroupProgress', () => {
  it('stores the progress of a running stage run in one request', async () => {
    seed();
    const workflow = createFakeWorkflow();

    const result = await reportTaskGroupProgress(createDependencies(workflow), STAGE_RUN_ID, {
      message: 'Writing the script',
      completed: 1,
      total: 3,
    });

    expect(result).toEqual({ accepted: true });
    expect(stageRun()?.progress).toEqual({
      message: 'Writing the script',
      completed: 1,
      total: 3,
      reported_at: expect.any(String),
    });
    expect(supabase.requests).toHaveLength(1);
    expect(supabase.requests[0].query.get('status')).toBe('eq.running');
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it('stores null for the counts it was not given', async () => {
    seed();

    await reportTaskGroupProgress(createDependencies(createFakeWorkflow()), STAGE_RUN_ID, { message: 'Starting' });

    expect(stageRun()?.progress).toEqual({ message: 'Starting', completed: null, total: null, reported_at: expect.any(String) });
  });

  it('is not accepted for a stage run that ended', async () => {
    seed({ stageRuns: [stageRunRow({ status: 'failed', error: 'Stage 2: task group did not finish within 60 minutes' })] });

    const result = await reportTaskGroupProgress(createDependencies(createFakeWorkflow()), STAGE_RUN_ID, { message: 'Late' });

    expect(result).toEqual({ accepted: false });
    expect(stageRun()?.progress).toBeNull();
  });

  it.each([
    ['the stage run ID is not a UUID', 'stage-run-1', { message: 'Working' }],
    ['the progress is not an object', STAGE_RUN_ID, null],
    ['the message is empty', STAGE_RUN_ID, { message: '' }],
    ['the message is longer than 500 characters', STAGE_RUN_ID, { message: 'a'.repeat(501) }],
    ['the message is not a string', STAGE_RUN_ID, { message: 3 }],
    ['completed is negative', STAGE_RUN_ID, { message: 'Working', completed: -1 }],
    ['total is not an integer', STAGE_RUN_ID, { message: 'Working', total: 1.5 }],
    ['completed is greater than total', STAGE_RUN_ID, { message: 'Working', completed: 4, total: 3 }],
  ])('throws a TypeError when %s', async (_, stageRunID, progress) => {
    seed();

    await expect(
      reportTaskGroupProgress(createDependencies(createFakeWorkflow()), stageRunID, progress as never),
    ).rejects.toThrow(TypeError);
    expect(supabase.requests).toHaveLength(0);
  });

  it('accepts a message of exactly 500 characters', async () => {
    seed();

    const result = await reportTaskGroupProgress(createDependencies(createFakeWorkflow()), STAGE_RUN_ID, {
      message: 'a'.repeat(500),
    });

    expect(result).toEqual({ accepted: true });
  });
});

describe('completeTaskGroupRun', () => {
  it('completes the stage run with the output and wakes the instance of a scheduled run', async () => {
    seed();
    const workflow = createFakeWorkflow();

    const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(result).toEqual({ accepted: true });
    expect(stageRun()).toMatchObject({
      status: 'completed',
      output: { episode: 'Episode 1' },
      completed_at: expect.any(String),
      error: null,
    });
    // The stage run is completed only while still running
    const update = supabase.requestsOf('PATCH', 'scheduler_stage_runs')[0];
    expect(update.query.get('status')).toBe('in.(running)');
    expect(workflow.events).toEqual([
      { instanceID: SCHEDULED_RUN_INSTANCE_ID, type: EVENT_TYPE, payload: { stageRunID: STAGE_RUN_ID } },
    ]);
  });

  it('wakes the manual instance of a manual run', async () => {
    seed({ runs: [runRow({ triggered_by: 'manual', scheduled_for: null })] });
    const workflow = createFakeWorkflow();

    await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(workflow.events.map((event) => event.instanceID)).toEqual([`manual-${RUN_ID}`]);
  });

  it('only wakes the instance again when the same completion is sent again', async () => {
    seed();
    const workflow = createFakeWorkflow();
    const dependencies = createDependencies(workflow);

    await completeTaskGroupRun(dependencies, STAGE_RUN_ID, { episode: 'Episode 1' });
    const completedStageRun = { ...stageRun() };
    const requestCount = supabase.requests.length;

    const result = await completeTaskGroupRun(dependencies, STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(result).toEqual({ accepted: true });
    expect(stageRun()).toEqual(completedStageRun);
    expect(supabase.requests.slice(requestCount).filter((request) => request.method !== 'GET')).toEqual([]);
    expect(workflow.events).toHaveLength(2);
  });

  it('fails the stage run when the output does not match the output format, and stays not accepted', async () => {
    seed();
    const workflow = createFakeWorkflow();
    const dependencies = createDependencies(workflow);

    const result = await completeTaskGroupRun(dependencies, STAGE_RUN_ID, { title: 'no episode' });

    expect(result).toEqual({ accepted: false });
    expect(stageRun()).toMatchObject({
      status: 'failed',
      output: null,
      error: 'Stage 2: output does not match the task group output format: $.episode is required',
    });
    expect(workflow.events).toHaveLength(1);

    const again = await completeTaskGroupRun(dependencies, STAGE_RUN_ID, { title: 'no episode' });

    expect(again).toEqual({ accepted: false });
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(1);
    expect(workflow.events).toHaveLength(2);
  });

  it.each([
    ['anything', {}],
    ['null', { type: 'null' }],
  ])('completes the stage run with output null for an undefined output when the output format allows %s', async (_, outputSchema) => {
    // JSON drops undefined, so the group's undefined is checked and stored as null
    seed({ taskGroups: [taskGroupRow({ output_schema: outputSchema })] });
    const workflow = createFakeWorkflow();

    const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, undefined);

    expect(result).toEqual({ accepted: true });
    expect(stageRun()).toMatchObject({ status: 'completed', output: null });
    // Written as null, not left out of the update
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')[0].body).toHaveProperty('output', null);
    expect(workflow.events).toHaveLength(1);
  });

  it('logs a warning with the stage run, the group, the version and where the output does not match, never the output', async () => {
    seed();
    const dependencies = createDependencies(createFakeWorkflow());
    const output = { episode: 7, transcript: 'output-marker' };

    await completeTaskGroupRun(dependencies, STAGE_RUN_ID, output);
    // The same report again finds the stage run failed and does not check the output again
    await completeTaskGroupRun(dependencies, STAGE_RUN_ID, output);

    expect(stageRun()).toMatchObject({ status: 'failed' });
    expect(dependencies.logger.warn).toHaveBeenCalledTimes(1);
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      {
        stageRunID: STAGE_RUN_ID,
        taskGroupID: 'newscast',
        taskGroupVersion: 1,
        reason: { path: '$.episode', message: 'must be of type string' },
      },
      { function: 'completeTaskGroupRun' },
    );
    const { debug, info, warn, error } = vi.mocked(dependencies.logger);
    const logged = JSON.stringify([debug, info, warn, error].map((method) => method.mock.calls));
    expect(logged).not.toContain('output-marker');
  });

  it('logs no warning for an output that matches the output format', async () => {
    seed();
    const dependencies = createDependencies(createFakeWorkflow());

    await completeTaskGroupRun(dependencies, STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(stageRun()).toMatchObject({ status: 'completed' });
    expect(dependencies.logger.warn).not.toHaveBeenCalled();
  });

  it('fails the stage run for an undefined output when the output format wants an object', async () => {
    seed({ taskGroups: [taskGroupRow({ output_schema: { type: 'object' } })] });
    const workflow = createFakeWorkflow();

    const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, undefined);

    expect(result).toEqual({ accepted: false });
    expect(stageRun()).toMatchObject({
      status: 'failed',
      output: null,
      error: 'Stage 2: output does not match the task group output format: $ must be of type object',
    });
    expect(workflow.events).toHaveLength(1);
  });

  it('checks the output against the version the stage run started with, without reading the stage', async () => {
    // Version 2 wants something else; the stage itself may have moved to it or been deleted
    seed({
      taskGroups: [
        taskGroupRow(),
        taskGroupRow({ version: 2, output_schema: { type: 'object', required: ['podcast'] } }),
      ],
    });
    const workflow = createFakeWorkflow();

    const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(result).toEqual({ accepted: true });
    expect(stageRun()).toMatchObject({ status: 'completed' });
    const taskGroupRequest = supabase.requestsOf('GET', 'task_groups')[0];
    expect(taskGroupRequest.query.get('version')).toBe('eq.1');
    expect(supabase.requestsOf('GET', 'scheduler_stages')).toHaveLength(0);
  });

  it.each([
    ['the output format cannot be read', [taskGroupRow({ output_schema: { type: 'date' } })]],
    ['the version is no longer registered', []],
  ])('fails the stage run when %s', async (_, taskGroups) => {
    seed({ taskGroups });
    const workflow = createFakeWorkflow();

    const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(result).toEqual({ accepted: false });
    expect(stageRun()).toMatchObject({ status: 'failed', error: 'Stage 2: task group output format cannot be read' });
    expect(workflow.events).toHaveLength(1);
  });

  it('is not accepted and does not change a stage run that already failed, for example on the timeout', async () => {
    const failedStageRun = stageRunRow({
      status: 'failed',
      completed_at: '2026-10-05T23:01:00.000Z',
      error: 'Stage 2: task group did not finish within 60 minutes',
    });
    seed({ stageRuns: [failedStageRun] });
    const workflow = createFakeWorkflow();

    const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(result).toEqual({ accepted: false });
    expect(stageRun()).toEqual(failedStageRun);
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(0);
  });

  it('reads the stage run again when it ended otherwise between the read and the update', async () => {
    seed();
    const workflow = createFakeWorkflow();
    supabase.intercept = (request) => {
      if (request.method === 'PATCH' && request.table === 'scheduler_stage_runs') {
        // The result step failed it for the timeout in the meantime
        Object.assign(stageRun()!, { status: 'failed', error: 'Stage 2: task group did not finish within 60 minutes' });
      }
      return undefined;
    };

    const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(result).toEqual({ accepted: false });
    expect(stageRun()).toMatchObject({ status: 'failed', output: null });
    expect(supabase.requestsOf('GET', 'scheduler_stage_runs')).toHaveLength(2);
    expect(workflow.events).toHaveLength(1);
  });

  it.each([
    ['a stage run ID that does not exist', MISSING_STAGE_RUN_ID, [stageRunRow()]],
    ['the stage run of a crawler stage', STAGE_RUN_ID, [stageRunRow({ task_group_id: null, task_group_version: null })]],
  ])('is not accepted and changes nothing for %s', async (_, stageRunID, stageRuns) => {
    seed({ stageRuns });
    const workflow = createFakeWorkflow();

    const result = await completeTaskGroupRun(createDependencies(workflow), stageRunID, { episode: 'Episode 1' });

    expect(result).toEqual({ accepted: false });
    expect(supabase.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it('throws when the run is in progress and the event cannot be sent', async () => {
    seed();
    const workflow = createFakeWorkflow({ sendEventError: new Error('instance unreachable') });

    await expect(
      completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' }),
    ).rejects.toThrow('instance unreachable');
    // The stage run is completed already, so the report sent again only wakes the instance
    expect(stageRun()).toMatchObject({ status: 'completed' });
  });

  it.each(['completed', 'failed'])('does not send the event when the run is already %s', async (runStatus) => {
    seed({ runs: [runRow({ status: runStatus })] });
    const workflow = createFakeWorkflow({ sendEventError: new Error('instance unreachable') });

    const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(result).toEqual({ accepted: true });
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it('throws a TypeError when the stage run ID is not a UUID', async () => {
    seed();

    await expect(
      completeTaskGroupRun(createDependencies(createFakeWorkflow()), 'not-a-uuid', {}),
    ).rejects.toThrow(TypeError);
    expect(supabase.requests).toHaveLength(0);
  });

  describe('waking the instance', () => {
    it('wakes the instance of a run that is still pending', async () => {
      seed({ runs: [runRow({ status: 'pending', started_at: null })] });
      const workflow = createFakeWorkflow();

      const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' });

      expect(result).toEqual({ accepted: true });
      expect(workflow.events).toEqual([
        { instanceID: SCHEDULED_RUN_INSTANCE_ID, type: EVENT_TYPE, payload: { stageRunID: STAGE_RUN_ID } },
      ]);
    });

    it('sends nothing and does not throw when the run record does not exist', async () => {
      seed({ runs: [] });
      const workflow = createFakeWorkflow({
        getError: new Error('instance.not_found'),
        sendEventError: new Error('instance.not_found'),
      });

      const result = await completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' });

      expect(result).toEqual({ accepted: true });
      expect(stageRun()).toMatchObject({ status: 'completed', output: { episode: 'Episode 1' } });
      expect(workflow.get).not.toHaveBeenCalled();
      expect(workflow.events).toEqual([]);
    });

    it('throws when the instance cannot be got while the run is in progress', async () => {
      seed();
      const workflow = createFakeWorkflow({ getError: new Error('instance.not_found') });

      await expect(
        completeTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, { episode: 'Episode 1' }),
      ).rejects.toThrow('instance.not_found');
      expect(workflow.get).toHaveBeenCalledWith(SCHEDULED_RUN_INSTANCE_ID);
      // The stage run is completed already, so the report sent again only wakes the instance
      expect(stageRun()).toMatchObject({ status: 'completed' });
    });
  });
});

describe('failTaskGroupRun', () => {
  it('fails the stage run with the message and wakes the instance', async () => {
    seed();
    const workflow = createFakeWorkflow();

    const result = await failTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, 'voice model unavailable');

    expect(result).toEqual({ accepted: true });
    expect(stageRun()).toMatchObject({
      status: 'failed',
      completed_at: expect.any(String),
      error: 'Stage 2: task group failed: voice model unavailable',
    });
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')[0].query.get('status')).toBe('in.(running)');
    expect(workflow.events).toEqual([
      { instanceID: SCHEDULED_RUN_INSTANCE_ID, type: EVENT_TYPE, payload: { stageRunID: STAGE_RUN_ID } },
    ]);
  });

  it('keeps the first 2,000 characters of the message', async () => {
    seed();

    await failTaskGroupRun(createDependencies(createFakeWorkflow()), STAGE_RUN_ID, `${'a'.repeat(2000)}cut`);

    expect(stageRun()?.error).toBe(`Stage 2: task group failed: ${'a'.repeat(2000)}`);
  });

  it('is accepted again, without a change, for a stage run it already failed', async () => {
    seed();
    const workflow = createFakeWorkflow();
    const dependencies = createDependencies(workflow);

    await failTaskGroupRun(dependencies, STAGE_RUN_ID, 'voice model unavailable');
    const result = await failTaskGroupRun(dependencies, STAGE_RUN_ID, 'voice model unavailable');

    expect(result).toEqual({ accepted: true });
    expect(supabase.requestsOf('PATCH', 'scheduler_stage_runs')).toHaveLength(1);
    expect(workflow.events).toHaveLength(2);
  });

  it('is not accepted for a stage run that already completed', async () => {
    const completedStageRun = stageRunRow({ status: 'completed', output: { episode: 'Episode 1' } });
    seed({ stageRuns: [completedStageRun] });

    const result = await failTaskGroupRun(createDependencies(createFakeWorkflow()), STAGE_RUN_ID, 'too late');

    expect(result).toEqual({ accepted: false });
    expect(stageRun()).toEqual(completedStageRun);
  });

  it.each([
    ['a stage run ID that does not exist', MISSING_STAGE_RUN_ID, [stageRunRow()]],
    ['the stage run of a crawler stage', STAGE_RUN_ID, [stageRunRow({ task_group_id: null, task_group_version: null })]],
  ])('is not accepted and changes nothing for %s', async (_, stageRunID, stageRuns) => {
    seed({ stageRuns });
    const workflow = createFakeWorkflow();

    const result = await failTaskGroupRun(createDependencies(workflow), stageRunID, 'voice model unavailable');

    expect(result).toEqual({ accepted: false });
    expect(supabase.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it('throws when the run is in progress and the event cannot be sent', async () => {
    seed();
    const workflow = createFakeWorkflow({ sendEventError: new Error('instance unreachable') });

    await expect(
      failTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, 'voice model unavailable'),
    ).rejects.toThrow('instance unreachable');
  });

  it.each(['completed', 'failed'])('does not send the event when the run is already %s', async (runStatus) => {
    seed({ runs: [runRow({ status: runStatus })] });
    const workflow = createFakeWorkflow({ sendEventError: new Error('instance unreachable') });

    const result = await failTaskGroupRun(createDependencies(workflow), STAGE_RUN_ID, 'voice model unavailable');

    expect(result).toEqual({ accepted: true });
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it.each([
    ['the stage run ID is not a UUID', 'stage-run-1', 'message'],
    ['the message is not a string', STAGE_RUN_ID, 42],
  ])('throws a TypeError when %s', async (_, stageRunID, errorMessage) => {
    seed();

    await expect(
      failTaskGroupRun(createDependencies(createFakeWorkflow()), stageRunID, errorMessage as string),
    ).rejects.toThrow(TypeError);
    expect(supabase.requests).toHaveLength(0);
  });
});

describe('TaskGroupReports entrypoint', () => {
  it('answers a call over RPC through a binding to the entrypoint', async () => {
    // Nothing is registered under this ID, so the report is not accepted
    seed({ stageRuns: [] });
    const reports = (exports as unknown as Record<string, {
      complete(stageRunID: string, output: unknown): Promise<{ accepted: boolean }>;
    }>).TaskGroupReports;

    const result = await reports.complete(MISSING_STAGE_RUN_ID, { episode: 'Episode 1' });

    expect(result).toEqual({ accepted: false });
    expect(supabase.requestsOf('GET', 'scheduler_stage_runs')).toHaveLength(1);
  });
});
