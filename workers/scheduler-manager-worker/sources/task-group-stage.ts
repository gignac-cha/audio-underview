import type { Logger } from '@audio-underview/logger';
import {
  type SupabaseClient,
  type SchedulerStageRow,
  type SchedulerStageRunRow,
  type TaskGroupRow,
  getSchedulerStageRun,
  getSchedulerStageRunByStage,
  createSchedulerStageRun,
  updateSchedulerStageRun,
  getTaskGroup,
} from '@audio-underview/supabase-connector';
import { UnsupportedSchemaError, validateAgainstSchema } from './schema-validation.ts';
import { type TaskGroupWorker, TASK_GROUP_STAGE_TIMEOUT_MINUTES } from './task-group-worker.ts';

/**
 * The steps of a task group stage in a Workflow run: start the group (stage-<order>), wait for its
 * report (stage-<order>-finished), then read the result from the stage run (stage-<order>-result).
 * No step result carries the group's output: the next stage reads it from the stage run.
 */

export interface TaskGroupStageDependencies {
  supabaseClient: SupabaseClient;
  logger: Logger;
  resolveTaskGroupWorker: (binding: string) => TaskGroupWorker | undefined;
}

export interface TaskGroupStageContext {
  runID: string;
  /** Owner of the scheduler */
  userUUID: string;
  /** The stage as load-stages read it */
  stage: SchedulerStageRow;
  /** Stage run of the previous stage, whose output is the input; null for the first stage */
  previousStageRunID: string | null;
}

export type TaskGroupStartResult =
  /** The group was started; wait for its report */
  | { status: 'waiting'; stageRunID: string }
  /** A previous attempt of this step already left an ended stage run; read its result without waiting */
  | { status: 'settled'; stageRunID: string }
  | { status: 'failed'; error: string };

export type TaskGroupStageResult =
  | { status: 'completed'; stageRunID: string }
  | { status: 'failed'; error: string };

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notRegisteredError(stageOrder: number, taskGroupID: string | null, taskGroupVersion: number | null): string {
  return `Stage ${stageOrder}: task group '${taskGroupID}' version ${taskGroupVersion} is not registered`;
}

function workerNotConnectedError(stageOrder: number, binding: string): string {
  return `Stage ${stageOrder}: task group worker '${binding}' is not connected`;
}

/**
 * Fails a running stage run, only while it is still running.
 *
 * @returns the step result: failed with the error, or settled when the stage run ended otherwise
 * in the meantime, so the result step reads how it ended
 */
async function failRunningStageRun(
  supabaseClient: SupabaseClient,
  stageRun: SchedulerStageRunRow,
  error: string,
): Promise<TaskGroupStartResult> {
  const failedStageRun = await updateSchedulerStageRun(supabaseClient, stageRun.id, stageRun.run_id, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    error,
  }, { onlyIfStatus: ['running'] });
  if (failedStageRun === undefined) {
    return { status: 'settled', stageRunID: stageRun.id };
  }
  return { status: 'failed', error };
}

/**
 * Calls the group's worker for a running stage run.
 */
async function startGroup(
  dependencies: TaskGroupStageDependencies,
  context: TaskGroupStageContext,
  worker: TaskGroupWorker,
  stageRun: SchedulerStageRunRow,
  taskGroup: TaskGroupRow,
): Promise<TaskGroupStartResult> {
  const { supabaseClient, logger } = dependencies;
  const { runID, userUUID, stage } = context;

  try {
    await worker.startTaskGroupRun({
      stageRunID: stageRun.id,
      taskGroupID: taskGroup.id,
      taskGroupVersion: taskGroup.version,
      input: stageRun.input,
      settings: stage.settings ?? {},
      userUUID,
    });
  } catch (error: unknown) {
    logger.error('Task group could not be started', error, {
      function: 'startTaskGroupStage',
      metadata: { runID, stageRunID: stageRun.id, taskGroupID: taskGroup.id, taskGroupVersion: taskGroup.version },
    });
    return failRunningStageRun(
      supabaseClient,
      stageRun,
      `Stage ${stage.stage_order}: task group could not be started: ${errorMessageOf(error)}`,
    );
  }

  return { status: 'waiting', stageRunID: stageRun.id };
}

/**
 * Starts the group again for the running stage run a previous attempt of this step created.
 * The group ignores a start request for a stage run it already started.
 */
async function restartGroup(
  dependencies: TaskGroupStageDependencies,
  context: TaskGroupStageContext,
  stageRun: SchedulerStageRunRow,
): Promise<TaskGroupStartResult> {
  const { supabaseClient, resolveTaskGroupWorker } = dependencies;
  const { stage } = context;

  // The group and version the stage run was started with
  const taskGroupID = stageRun.task_group_id ?? stage.task_group_id;
  const taskGroupVersion = stageRun.task_group_version ?? stage.task_group_version;

  const taskGroup = taskGroupID === null || taskGroupVersion === null
    ? undefined
    : await getTaskGroup(supabaseClient, taskGroupID, taskGroupVersion);
  if (taskGroup === undefined) {
    return failRunningStageRun(supabaseClient, stageRun, notRegisteredError(stage.stage_order, taskGroupID, taskGroupVersion));
  }

  const worker = resolveTaskGroupWorker(taskGroup.worker_binding);
  if (worker === undefined) {
    return failRunningStageRun(supabaseClient, stageRun, workerNotConnectedError(stage.stage_order, taskGroup.worker_binding));
  }

  return startGroup(dependencies, context, worker, stageRun, taskGroup);
}

/**
 * The stage-<order> step of a task group stage: checks the input against the group's input format,
 * records the stage run and starts the group. A repeated attempt reuses the stage run it finds.
 * Never throws: a failure is returned, like a crawler stage step.
 */
export async function startTaskGroupStage(
  dependencies: TaskGroupStageDependencies,
  context: TaskGroupStageContext,
): Promise<TaskGroupStartResult> {
  const { supabaseClient, logger, resolveTaskGroupWorker } = dependencies;
  const { runID, stage, previousStageRunID } = context;

  try {
    // Workflows may run a step again that did not finish
    const existingStageRun = await getSchedulerStageRunByStage(supabaseClient, runID, stage.id);
    if (existingStageRun !== undefined) {
      if (existingStageRun.status === 'running') {
        return await restartGroup(dependencies, context, existingStageRun);
      }
      return { status: 'settled', stageRunID: existingStageRun.id };
    }

    let input: unknown;
    if (previousStageRunID === null) {
      input = {};
    } else {
      const previousStageRun = await getSchedulerStageRun(supabaseClient, previousStageRunID, runID);
      if (previousStageRun === undefined) {
        throw new Error(`Stage ${stage.stage_order}: previous stage output not found`);
      }
      input = previousStageRun.output;
    }

    const taskGroup = stage.task_group_id === null || stage.task_group_version === null
      ? undefined
      : await getTaskGroup(supabaseClient, stage.task_group_id, stage.task_group_version);
    if (taskGroup === undefined) {
      return { status: 'failed', error: notRegisteredError(stage.stage_order, stage.task_group_id, stage.task_group_version) };
    }

    const stageRunValues = {
      run_id: runID,
      stage_id: stage.id,
      stage_order: stage.stage_order,
      task_group_id: taskGroup.id,
      task_group_version: taskGroup.version,
      input,
      started_at: new Date().toISOString(),
    };

    // A stage run that fails before the group starts is recorded as failed from the start
    const recordFailure = async (error: string): Promise<TaskGroupStartResult> => {
      await createSchedulerStageRun(supabaseClient, {
        ...stageRunValues,
        status: 'failed',
        completed_at: new Date().toISOString(),
        error,
      });
      return { status: 'failed', error };
    };

    let inputValidation;
    try {
      inputValidation = validateAgainstSchema(taskGroup.input_schema, input);
    } catch (error: unknown) {
      if (!(error instanceof UnsupportedSchemaError)) throw error;
      logger.error('Task group input format cannot be read', error, {
        function: 'startTaskGroupStage',
        metadata: { runID, taskGroupID: taskGroup.id, taskGroupVersion: taskGroup.version },
      });
      return await recordFailure(`Stage ${stage.stage_order}: task group input format cannot be read`);
    }
    if (!inputValidation.valid) {
      return await recordFailure(
        `Stage ${stage.stage_order}: input does not match the task group input format: ${inputValidation.path} ${inputValidation.message}`,
      );
    }

    const worker = resolveTaskGroupWorker(taskGroup.worker_binding);
    if (worker === undefined) {
      return await recordFailure(workerNotConnectedError(stage.stage_order, taskGroup.worker_binding));
    }

    const stageRun = await createSchedulerStageRun(supabaseClient, { ...stageRunValues, status: 'running' });
    return await startGroup(dependencies, context, worker, stageRun, taskGroup);
  } catch (error: unknown) {
    logger.error('Task group stage could not start', error, {
      function: 'startTaskGroupStage',
      metadata: { runID, stageID: stage.id, stageOrder: stage.stage_order },
    });
    return { status: 'failed', error: errorMessageOf(error) };
  }
}

/**
 * The stage-<order>-result step: decides the stage's result from its stage run. A stage run still
 * running got no report in time and is failed.
 *
 * @throws when the database cannot be reached, so the step is retried
 */
export async function settleTaskGroupStage(
  supabaseClient: SupabaseClient,
  runID: string,
  stageOrder: number,
  stageRunID: string,
): Promise<TaskGroupStageResult> {
  let stageRun = await getSchedulerStageRun(supabaseClient, stageRunID, runID);

  if (stageRun?.status === 'running') {
    const failedStageRun = await updateSchedulerStageRun(supabaseClient, stageRunID, runID, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: `Stage ${stageOrder}: task group did not finish within ${TASK_GROUP_STAGE_TIMEOUT_MINUTES} minutes`,
    }, { onlyIfStatus: ['running'] });
    // Not changed: a report arrived in the meantime
    stageRun = failedStageRun ?? await getSchedulerStageRun(supabaseClient, stageRunID, runID);
  }

  // The stage or the scheduler was deleted
  if (stageRun === undefined) {
    return { status: 'failed', error: `Stage ${stageOrder}: stage run record was removed` };
  }

  if (stageRun.status === 'completed') {
    return { status: 'completed', stageRunID };
  }
  return { status: 'failed', error: stageRun.error ?? `Stage ${stageOrder}: task group failed` };
}
