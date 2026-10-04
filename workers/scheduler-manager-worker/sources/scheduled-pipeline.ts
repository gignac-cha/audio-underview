import type { WorkflowStepConfig, WorkflowTimeoutDuration } from 'cloudflare:workers';
import {
  type SupabaseClient,
  type SchedulerRunRow,
  type SchedulerRunStatus,
  type SchedulerRunsUpdate,
  getSchedulerByID,
  getSchedulerRun,
  getSchedulerRunByOccurrence,
  createSchedulerRun,
  listSchedulerStages,
  getSchedulerStageRun,
  updateSchedulerRun,
  updateScheduler,
  failActiveSchedulerStageRuns,
} from '@audio-underview/supabase-connector';
import { type ExecutorDependencies, executePipelineStage } from './scheduler-executor.ts';
import { resolveDefaultInput } from './stage-runner.ts';
import type { SchedulerRunParameters } from './scheduler-run-workflow.ts';
import {
  type TaskGroupWorker,
  TASK_GROUP_STAGE_TIMEOUT_MINUTES,
  taskGroupFinishedEventType,
} from './task-group-worker.ts';
import {
  type TaskGroupStageContext,
  type TaskGroupStageResult,
  startTaskGroupStage,
  settleTaskGroupStage,
} from './task-group-stage.ts';

export interface ScheduledPipelineDependencies extends ExecutorDependencies {
  /** Finds the worker of a task group by the name of its service binding */
  resolveTaskGroupWorker: (binding: string) => TaskGroupWorker | undefined;
}

/**
 * The part of the Workflow step the pipeline uses, so tests can pass a fake.
 */
export interface ScheduledPipelineStep {
  do<T>(name: string, options: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
  waitForEvent(name: string, options: { type: string; timeout: WorkflowTimeoutDuration }): Promise<unknown>;
}

export type ScheduledPipelineResult =
  | { outcome: 'cancelled' | 'skipped' | 'finished' }
  | { outcome: 'started'; runID: string; status: 'completed' | 'partially_failed' | 'failed' };

type BeginRunResult =
  | { outcome: 'cancelled' | 'skipped' | 'finished' }
  | { outcome: 'started'; runID: string; userUUID: string };

type StageStepResult =
  | { status: 'completed' | 'partially_failed'; stageRunID: string }
  | { status: 'failed'; error: string };

// Steps that only read or write records are safe to repeat.
const RECORD_STEP_OPTIONS: WorkflowStepConfig = {
  retries: { limit: 5, delay: '3 seconds', backoff: 'exponential' },
  timeout: '1 minute',
};

// A stage calls crawlers, so it is never repeated automatically.
const EXECUTE_STEP_OPTIONS: WorkflowStepConfig = {
  retries: { limit: 0, delay: 0 },
  timeout: '15 minutes',
};

// Starting a task group only asks its worker to start, and is never repeated automatically either.
const TASK_GROUP_START_STEP_OPTIONS: WorkflowStepConfig = {
  retries: { limit: 0, delay: 0 },
  timeout: '5 minutes',
};

const TASK_GROUP_WAIT_TIMEOUT = `${TASK_GROUP_STAGE_TIMEOUT_MINUTES} minutes` as const;
const UNFINISHED_STAGE_RUN_ERROR = 'Run ended before this stage finished';

const ACTIVE_RUN_INDEX = 'scheduler_runs_one_active_per_scheduler';
const SKIPPED_RUN_ERROR = 'A previous run was still in progress';
const ACTIVE_RUN_STATUSES: SchedulerRunStatus[] = ['pending', 'running'];

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveExistingRun(run: SchedulerRunRow, userUUID: string): BeginRunResult {
  if (run.status === 'pending' || run.status === 'running') {
    return { outcome: 'started', runID: run.id, userUUID };
  }
  if (run.status === 'skipped') {
    return { outcome: 'skipped' };
  }
  return { outcome: 'finished' };
}

/**
 * Creates the run of this occurrence, records it as skipped while another run is in progress,
 * or picks up the run a previous attempt already created.
 */
async function beginScheduledRun(
  supabaseClient: SupabaseClient,
  parameters: { schedulerID: string; scheduledFor: string },
): Promise<BeginRunResult> {
  const { schedulerID, scheduledFor } = parameters;

  const scheduler = await getSchedulerByID(supabaseClient, schedulerID);
  if (scheduler === undefined || !scheduler.is_enabled || scheduler.cron_expression === null) {
    return { outcome: 'cancelled' };
  }
  const userUUID = scheduler.user_uuid;

  const existingRun = await getSchedulerRunByOccurrence(supabaseClient, schedulerID, scheduledFor);
  if (existingRun !== undefined) return resolveExistingRun(existingRun, userUUID);

  const now = new Date().toISOString();

  try {
    const run = await createSchedulerRun(supabaseClient, {
      scheduler_id: schedulerID,
      status: 'running',
      started_at: now,
      triggered_by: 'schedule',
      scheduled_for: scheduledFor,
    });
    return { outcome: 'started', runID: run.id, userUUID };
  } catch (error: unknown) {
    // Another attempt may have created the run of this occurrence in the meantime
    const racedRun = await getSchedulerRunByOccurrence(supabaseClient, schedulerID, scheduledFor);
    if (racedRun !== undefined) return resolveExistingRun(racedRun, userUUID);
    if (!errorMessageOf(error).includes(ACTIVE_RUN_INDEX)) throw error;
  }

  // The previous run is still in progress
  try {
    await createSchedulerRun(supabaseClient, {
      scheduler_id: schedulerID,
      status: 'skipped',
      triggered_by: 'schedule',
      scheduled_for: scheduledFor,
      completed_at: now,
      error: SKIPPED_RUN_ERROR,
    });
    return { outcome: 'skipped' };
  } catch (error: unknown) {
    const racedRun = await getSchedulerRunByOccurrence(supabaseClient, schedulerID, scheduledFor);
    if (racedRun !== undefined) return resolveExistingRun(racedRun, userUUID);
    throw error;
  }
}

/**
 * Starts the pending run a manual execution created for a scheduler with a task group stage, or
 * continues it when a previous attempt already started it. The scheduler runs whether or not it is
 * enabled or has a cron expression.
 */
async function beginManualRun(
  supabaseClient: SupabaseClient,
  parameters: { schedulerID: string; runID: string },
): Promise<BeginRunResult> {
  const { schedulerID, runID } = parameters;

  const scheduler = await getSchedulerByID(supabaseClient, schedulerID);
  if (scheduler === undefined) return { outcome: 'cancelled' };
  const userUUID = scheduler.user_uuid;

  const run = await getSchedulerRun(supabaseClient, runID, schedulerID);
  if (run === undefined) return { outcome: 'cancelled' };
  if (run.status === 'running') return { outcome: 'started', runID, userUUID };
  if (run.status !== 'pending') return { outcome: 'finished' };

  const startedRun = await updateSchedulerRun(supabaseClient, runID, schedulerID, {
    status: 'running',
    started_at: new Date().toISOString(),
  }, { onlyIfStatus: ['pending'] });
  if (startedRun !== undefined) return { outcome: 'started', runID, userUUID };

  // The run changed in the meantime: started by another attempt, or closed
  const changedRun = await getSchedulerRun(supabaseClient, runID, schedulerID);
  if (changedRun === undefined) return { outcome: 'cancelled' };
  if (changedRun.status === 'running') return { outcome: 'started', runID, userUUID };
  return { outcome: 'finished' };
}

function beginRun(supabaseClient: SupabaseClient, parameters: SchedulerRunParameters): Promise<BeginRunResult> {
  if ('runID' in parameters) return beginManualRun(supabaseClient, parameters);
  return beginScheduledRun(supabaseClient, parameters);
}

/**
 * Runs a task group stage as three steps: start the group, wait for its report, and read the
 * result from the stage run. The stage run decides the result; the event only wakes the run.
 */
async function runTaskGroupStage(
  dependencies: ScheduledPipelineDependencies,
  step: ScheduledPipelineStep,
  context: TaskGroupStageContext,
): Promise<TaskGroupStageResult> {
  const { supabaseClient, logger } = dependencies;
  const { runID, stage } = context;
  const stepName = `stage-${stage.stage_order}`;

  const startResult = await step.do(stepName, TASK_GROUP_START_STEP_OPTIONS, () => startTaskGroupStage(dependencies, context));
  if (startResult.status === 'failed') return startResult;
  const { stageRunID } = startResult;

  if (startResult.status === 'waiting') {
    try {
      await step.waitForEvent(`${stepName}-finished`, {
        type: taskGroupFinishedEventType(stageRunID),
        timeout: TASK_GROUP_WAIT_TIMEOUT,
      });
    } catch (error: unknown) {
      // Timed out or failed otherwise; the result step decides from the stage run either way
      logger.warn('Task group stage was not reported finished', {
        runID,
        stageRunID,
        stageOrder: stage.stage_order,
        error: errorMessageOf(error),
      }, { function: 'runScheduledPipeline' });
    }
  }

  return step.do(`${stepName}-result`, RECORD_STEP_OPTIONS, () => settleTaskGroupStage(supabaseClient, runID, stage.stage_order, stageRunID));
}

/**
 * Runs one run of a scheduler pipeline as Workflow steps: a scheduled occurrence, or a manual
 * run of a scheduler with a task group stage. Every database access and crawler call happens
 * inside a step, and no step result carries a stage output: the next step reads it from the stage run.
 */
export async function runScheduledPipeline(
  dependencies: ScheduledPipelineDependencies,
  parameters: SchedulerRunParameters,
  step: ScheduledPipelineStep,
): Promise<ScheduledPipelineResult> {
  const { supabaseClient, logger } = dependencies;
  const { schedulerID } = parameters;

  const beginRunResult = await step.do('begin-run', RECORD_STEP_OPTIONS, () => beginRun(supabaseClient, parameters));
  if (beginRunResult.outcome !== 'started') {
    return { outcome: beginRunResult.outcome };
  }
  const { runID, userUUID } = beginRunResult;

  let failure: string | null = null;
  let hasPartialFailure = false;
  let lastStageRunID: string | null = null;

  try {
    const stages = await step.do('load-stages', RECORD_STEP_OPTIONS, () => listSchedulerStages(supabaseClient, schedulerID));

    for (const stage of stages) {
      const previousStageRunID = lastStageRunID;

      // Anything else, a missing value included, is a crawler stage
      if (stage.stage_type === 'task_group') {
        const taskGroupStageResult = await runTaskGroupStage(dependencies, step, { runID, userUUID, stage, previousStageRunID });
        if (taskGroupStageResult.status === 'failed') {
          failure = taskGroupStageResult.error;
          break;
        }
        lastStageRunID = taskGroupStageResult.stageRunID;
        continue;
      }

      const stageStepResult = await step.do(`stage-${stage.stage_order}`, EXECUTE_STEP_OPTIONS, async (): Promise<StageStepResult> => {
        try {
          let input: unknown;
          if (previousStageRunID === null) {
            input = resolveDefaultInput(stage.input_schema);
          } else {
            const previousStageRun = await getSchedulerStageRun(supabaseClient, previousStageRunID, runID);
            if (previousStageRun === undefined) {
              throw new Error(`Stage ${stage.stage_order}: previous stage output not found`);
            }
            input = previousStageRun.output;
          }

          const stageResult = await executePipelineStage(dependencies, runID, stage, input);
          return {
            status: stageResult.partiallyFailed ? 'partially_failed' : 'completed',
            stageRunID: stageResult.stageRunID,
          };
        } catch (error: unknown) {
          logger.error('Scheduled stage failed', error, {
            function: 'runScheduledPipeline',
            metadata: { schedulerID, runID, stageOrder: stage.stage_order },
          });
          return { status: 'failed', error: errorMessageOf(error) };
        }
      });

      if (stageStepResult.status === 'failed') {
        failure = stageStepResult.error;
        break;
      }
      if (stageStepResult.status === 'partially_failed') {
        hasPartialFailure = true;
      }
      lastStageRunID = stageStepResult.stageRunID;
    }
  } catch (error: unknown) {
    // load-stages failed after its retries, or a stage step itself failed (for example a timeout)
    logger.error('Scheduled run failed', error, {
      function: 'runScheduledPipeline',
      metadata: { schedulerID, runID },
    });
    failure = errorMessageOf(error);
  }

  let status: 'completed' | 'partially_failed' | 'failed';
  if (failure !== null) {
    status = 'failed';
  } else if (hasPartialFailure) {
    status = 'partially_failed';
  } else {
    status = 'completed';
  }

  const finishedStageRunID = lastStageRunID;
  const finishRunResult = await step.do('finish-run', RECORD_STEP_OPTIONS, async () => {
    const now = new Date().toISOString();

    // No stage run stays in progress after its run ends, for example after a step timed out
    // or a start step ran again
    await failActiveSchedulerStageRuns(supabaseClient, runID, now, UNFINISHED_STAGE_RUN_ERROR);

    const values: SchedulerRunsUpdate = { status, completed_at: now };
    if (failure !== null) {
      values.error = failure;
    } else if (finishedStageRunID === null) {
      values.result = null;
    } else {
      const lastStageRun = await getSchedulerStageRun(supabaseClient, finishedStageRunID, runID);
      values.result = lastStageRun?.output ?? null;
    }

    await updateSchedulerRun(supabaseClient, runID, schedulerID, values, { onlyIfStatus: ACTIVE_RUN_STATUSES });
    await updateScheduler(supabaseClient, schedulerID, userUUID, { last_run_at: now });

    return { status };
  });

  return { outcome: 'started', runID, status: finishRunResult.status };
}
