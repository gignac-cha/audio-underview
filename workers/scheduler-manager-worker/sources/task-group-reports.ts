import type { Logger } from '@audio-underview/logger';
import {
  type SupabaseClient,
  type SchedulerStageRunRow,
  type SchedulerStageRunsUpdate,
  getSchedulerStageRunByID,
  getSchedulerRunByID,
  getTaskGroup,
  updateSchedulerStageRun,
  setSchedulerStageRunProgress,
} from '@audio-underview/supabase-connector';
import { UUID_PATTERN } from './handlers/tools.ts';
import { runInstanceID } from './schedule.ts';
import { UnsupportedSchemaError, validateAgainstSchema } from './schema-validation.ts';
import { taskGroupFinishedEventType } from './task-group-worker.ts';

/**
 * What a task group's worker reports to the scheduler about one stage run (TaskGroupReports).
 *
 * A report that throws is sent again by the group, except a TypeError, which means the arguments
 * are wrong. Sending the same report again gives the same result. The stage run is the source of
 * truth: the Workflow event only wakes the run waiting for it, which then reads the stage run.
 */

export interface TaskGroupProgressReport {
  message: string;
  completed?: number;
  total?: number;
}

export interface TaskGroupReportResult {
  /**
   * The stage run ended the way the report says (completed, failed, or the progress was stored).
   * false means it ended otherwise or does not exist, and the group may stop its work.
   */
  accepted: boolean;
}

export interface TaskGroupReportDependencies {
  supabaseClient: SupabaseClient;
  workflow: Pick<Workflow, 'get'>;
  logger: Logger;
}

const MAXIMUM_PROGRESS_MESSAGE_LENGTH = 500;
const MAXIMUM_ERROR_MESSAGE_LENGTH = 2000;

function assertStageRunID(stageRunID: unknown): asserts stageRunID is string {
  if (typeof stageRunID !== 'string' || !UUID_PATTERN.test(stageRunID)) {
    throw new TypeError('stageRunID must be a UUID');
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertProgressReport(progress: unknown): asserts progress is TaskGroupProgressReport {
  if (typeof progress !== 'object' || progress === null) {
    throw new TypeError('progress must be an object');
  }
  const { message, completed, total } = progress as Record<string, unknown>;
  if (typeof message !== 'string') {
    throw new TypeError('progress.message must be a string');
  }
  const messageLength = [...message].length;
  if (messageLength < 1 || messageLength > MAXIMUM_PROGRESS_MESSAGE_LENGTH) {
    throw new TypeError(`progress.message must be 1 to ${MAXIMUM_PROGRESS_MESSAGE_LENGTH} characters long`);
  }
  if (completed !== undefined && !isNonNegativeInteger(completed)) {
    throw new TypeError('progress.completed must be a non-negative integer');
  }
  if (total !== undefined && !isNonNegativeInteger(total)) {
    throw new TypeError('progress.total must be a non-negative integer');
  }
  if (completed !== undefined && total !== undefined && completed > total) {
    throw new TypeError('progress.completed must not be greater than progress.total');
  }
}

/**
 * Wakes the Workflow instance waiting for this stage run, when its run is still in progress.
 * The event may arrive before the instance waits for it; Workflows keeps it until then.
 *
 * @throws when the run is in progress and the instance cannot be reached, so the group reports again
 */
async function wakeRun(dependencies: TaskGroupReportDependencies, stageRun: SchedulerStageRunRow): Promise<void> {
  const { supabaseClient, workflow } = dependencies;

  const run = await getSchedulerRunByID(supabaseClient, stageRun.run_id);
  // A run that ended has nothing waiting
  if (run === undefined || (run.status !== 'pending' && run.status !== 'running')) return;

  const instance = await workflow.get(runInstanceID(run));
  await instance.sendEvent({
    type: taskGroupFinishedEventType(stageRun.id),
    payload: { stageRunID: stageRun.id },
  });
}

/**
 * Reads the task group stage run a report is about.
 *
 * @returns undefined when it does not exist or is a crawler stage run
 */
async function readTaskGroupStageRun(
  dependencies: TaskGroupReportDependencies,
  stageRunID: string,
): Promise<(SchedulerStageRunRow & { task_group_id: string; task_group_version: number }) | undefined> {
  const stageRun = await getSchedulerStageRunByID(dependencies.supabaseClient, stageRunID);
  if (stageRun === undefined || stageRun.task_group_id === null || stageRun.task_group_version === null) {
    return undefined;
  }
  return stageRun as SchedulerStageRunRow & { task_group_id: string; task_group_version: number };
}

/**
 * Ends a running stage run with the given values, only while it is still running.
 *
 * @returns the stage run as it is afterwards, or undefined when it no longer exists
 */
async function finishStageRun(
  dependencies: TaskGroupReportDependencies,
  stageRun: SchedulerStageRunRow,
  values: SchedulerStageRunsUpdate,
): Promise<SchedulerStageRunRow | undefined> {
  const { supabaseClient } = dependencies;

  const updatedStageRun = await updateSchedulerStageRun(
    supabaseClient,
    stageRun.id,
    stageRun.run_id,
    values,
    { onlyIfStatus: ['running'] },
  );
  if (updatedStageRun !== undefined) return updatedStageRun;

  // It ended otherwise in the meantime
  return getSchedulerStageRunByID(supabaseClient, stageRun.id);
}

/**
 * Stores the latest progress of a running task group stage run. One Supabase request.
 *
 * @throws TypeError when the arguments are wrong
 */
export async function reportTaskGroupProgress(
  dependencies: TaskGroupReportDependencies,
  stageRunID: string,
  progress: TaskGroupProgressReport,
): Promise<TaskGroupReportResult> {
  assertStageRunID(stageRunID);
  assertProgressReport(progress);

  const accepted = await setSchedulerStageRunProgress(dependencies.supabaseClient, stageRunID, {
    message: progress.message,
    completed: progress.completed ?? null,
    total: progress.total ?? null,
    reported_at: new Date().toISOString(),
  });
  return { accepted };
}

/**
 * Completes a task group stage run with the group's output, checked against the output format
 * of the version the stage run was started with, then wakes the run.
 *
 * @throws TypeError when the arguments are wrong
 */
export async function completeTaskGroupRun(
  dependencies: TaskGroupReportDependencies,
  stageRunID: string,
  output: unknown,
): Promise<TaskGroupReportResult> {
  assertStageRunID(stageRunID);
  const { supabaseClient, logger } = dependencies;

  const stageRun = await readTaskGroupStageRun(dependencies, stageRunID);
  if (stageRun === undefined) return { accepted: false };

  if (stageRun.status !== 'running') {
    await wakeRun(dependencies, stageRun);
    return { accepted: stageRun.status === 'completed' };
  }

  // The stage run's own group and version, not the stage's: the stage may have changed since
  const taskGroup = await getTaskGroup(supabaseClient, stageRun.task_group_id, stageRun.task_group_version);
  const completedAt = new Date().toISOString();
  const unreadableFormatValues: SchedulerStageRunsUpdate = {
    status: 'failed',
    completed_at: completedAt,
    error: `Stage ${stageRun.stage_order}: task group output format cannot be read`,
  };
  const logMetadata = { stageRunID, taskGroupID: stageRun.task_group_id, taskGroupVersion: stageRun.task_group_version };
  // JSON drops undefined, so it is checked and stored as null rather than left out of the update
  const reportedOutput = output ?? null;

  let values: SchedulerStageRunsUpdate;
  if (taskGroup === undefined) {
    // The registration was removed after the stage run started
    logger.error('Task group of a stage run is not registered', undefined, {
      function: 'completeTaskGroupRun',
      metadata: logMetadata,
    });
    values = unreadableFormatValues;
  } else {
    try {
      const validation = validateAgainstSchema(taskGroup.output_schema, reportedOutput);
      if (validation.valid) {
        values = { status: 'completed', completed_at: completedAt, output: reportedOutput };
      } else {
        // Where the output does not match, never the output itself
        logger.warn('Task group output does not match its output format', {
          ...logMetadata,
          reason: { path: validation.path, message: validation.message },
        }, { function: 'completeTaskGroupRun' });
        values = {
          status: 'failed',
          completed_at: completedAt,
          error: `Stage ${stageRun.stage_order}: output does not match the task group output format: ${validation.path} ${validation.message}`,
        };
      }
    } catch (error: unknown) {
      if (!(error instanceof UnsupportedSchemaError)) throw error;
      logger.error('Task group output format cannot be read', error, {
        function: 'completeTaskGroupRun',
        metadata: logMetadata,
      });
      values = unreadableFormatValues;
    }
  }

  const finishedStageRun = await finishStageRun(dependencies, stageRun, values);
  await wakeRun(dependencies, stageRun);
  return { accepted: finishedStageRun?.status === 'completed' };
}

/**
 * Fails a task group stage run with the group's error message, then wakes the run.
 *
 * @throws TypeError when the arguments are wrong
 */
export async function failTaskGroupRun(
  dependencies: TaskGroupReportDependencies,
  stageRunID: string,
  errorMessage: string,
): Promise<TaskGroupReportResult> {
  assertStageRunID(stageRunID);
  if (typeof errorMessage !== 'string') {
    throw new TypeError('errorMessage must be a string');
  }
  const truncatedErrorMessage = [...errorMessage].slice(0, MAXIMUM_ERROR_MESSAGE_LENGTH).join('');

  const stageRun = await readTaskGroupStageRun(dependencies, stageRunID);
  if (stageRun === undefined) return { accepted: false };

  if (stageRun.status !== 'running') {
    await wakeRun(dependencies, stageRun);
    return { accepted: stageRun.status === 'failed' };
  }

  const finishedStageRun = await finishStageRun(dependencies, stageRun, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    error: `Stage ${stageRun.stage_order}: task group failed: ${truncatedErrorMessage}`,
  });
  await wakeRun(dependencies, stageRun);
  return { accepted: finishedStageRun?.status === 'failed' };
}
