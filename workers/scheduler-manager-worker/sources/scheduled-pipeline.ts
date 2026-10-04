import type { WorkflowStepConfig } from 'cloudflare:workers';
import {
  type SupabaseClient,
  type SchedulerRunRow,
  type SchedulerRunStatus,
  type SchedulerRunsUpdate,
  getSchedulerByID,
  getSchedulerRunByOccurrence,
  createSchedulerRun,
  listSchedulerStages,
  getSchedulerStageRun,
  updateSchedulerRun,
  updateScheduler,
} from '@audio-underview/supabase-connector';
import { type ExecutorDependencies, executePipelineStage } from './scheduler-executor.ts';
import { resolveDefaultInput } from './stage-runner.ts';
import type { SchedulerRunParameters } from './scheduler-run-workflow.ts';

/**
 * The part of the Workflow step the pipeline uses, so tests can pass a fake.
 */
export interface ScheduledPipelineStep {
  do<T>(name: string, options: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
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
async function beginRun(
  supabaseClient: SupabaseClient,
  parameters: SchedulerRunParameters,
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
 * Runs one scheduled occurrence of a scheduler pipeline as Workflow steps.
 * Every database access and crawler call happens inside a step, and no step result
 * carries a stage output: the next step reads it from the stage run.
 */
export async function runScheduledPipeline(
  dependencies: ExecutorDependencies,
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
