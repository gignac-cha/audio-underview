import type { SupabaseClient } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import {
  listSchedulerStages,
  updateSchedulerRun,
  updateScheduler,
  createSchedulerStageRun,
  updateSchedulerStageRun,
} from '@audio-underview/supabase-connector';
import type { CrawlerExecutionClient } from './crawler-execution-client.ts';
import {
  executeStage,
  executeFanOut,
  resolveDefaultInput,
} from './stage-runner.ts';

export interface ExecutorDependencies {
  supabaseClient: SupabaseClient;
  crawlerExecutionClient: CrawlerExecutionClient;
  logger: Logger;
}

export async function executeScheduler(
  dependencies: ExecutorDependencies,
  schedulerID: string,
  userUUID: string,
  runID: string,
  signal?: AbortSignal,
): Promise<void> {
  const { supabaseClient, logger } = dependencies;

  const stageRunnerDependencies = {
    supabaseClient: dependencies.supabaseClient,
    crawlerExecutionClient: dependencies.crawlerExecutionClient,
    logger: dependencies.logger,
  };

  try {
    // Mark run as running
    await updateSchedulerRun(supabaseClient, runID, schedulerID, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    const stages = await listSchedulerStages(supabaseClient, schedulerID);

    if (stages.length === 0) {
      await updateSchedulerRun(supabaseClient, runID, schedulerID, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        result: null,
      });
      return;
    }

    let currentInput: unknown = resolveDefaultInput(stages[0].input_schema);
    let lastOutput: unknown = null;
    let hasPartialFailure = false;

    for (const stage of stages) {
      if (signal?.aborted) break;

      // Fan-out check
      if (stage.fan_out_field) {
        if (currentInput !== null && currentInput !== undefined && typeof currentInput !== 'object') {
          throw new Error(
            `Stage ${stage.stage_order}: fan_out_field "${stage.fan_out_field}" requires object input, got ${typeof currentInput}`,
          );
        }
        const inputObject = currentInput as Record<string, unknown> | null;
        const fanOutItems = inputObject?.[stage.fan_out_field];

        if (fanOutItems === undefined || fanOutItems === null) {
          throw new Error(
            `Stage ${stage.stage_order}: fan_out_field "${stage.fan_out_field}" not found in input`,
          );
        }

        if (!Array.isArray(fanOutItems)) {
          throw new Error(
            `Stage ${stage.stage_order}: fan_out_field "${stage.fan_out_field}" is not an array`,
          );
        }

        // Create stage_run record for the fan-out stage
        const stageRun = await createSchedulerStageRun(supabaseClient, {
          run_id: runID,
          stage_id: stage.id,
          stage_order: stage.stage_order,
          status: 'running',
          started_at: new Date().toISOString(),
          input: currentInput,
        });

        if (fanOutItems.length === 0) {
          await updateSchedulerStageRun(supabaseClient, stageRun.id, runID, {
            status: 'completed',
            completed_at: new Date().toISOString(),
            output: [],
            items_total: 0,
            items_succeeded: 0,
            items_failed: 0,
          });
          currentInput = [];
          lastOutput = [];
          continue;
        }

        const fanOutResult = await executeFanOut(
          stageRunnerDependencies,
          stage,
          fanOutItems,
          1,
          signal,
        );

        await updateSchedulerStageRun(supabaseClient, stageRun.id, runID, {
          status: fanOutResult.status,
          completed_at: new Date().toISOString(),
          output: fanOutResult.results,
          items_total: fanOutResult.itemsTotal,
          items_succeeded: fanOutResult.itemsSucceeded,
          items_failed: fanOutResult.itemsFailed,
        });

        if (fanOutResult.status === 'failed') {
          throw new Error(
            `Stage ${stage.stage_order}: all fan-out items failed`,
          );
        }

        if (fanOutResult.status === 'partially_failed') {
          hasPartialFailure = true;
        }

        currentInput = fanOutResult.results;
        lastOutput = fanOutResult.results;
      } else {
        // Normal stage execution
        const stageResult = await executeStage(
          stageRunnerDependencies,
          runID,
          stage,
          currentInput,
          signal,
        );

        currentInput = stageResult.output;
        lastOutput = stageResult.output;
      }
    }

    // Pipeline completed successfully — skip if handler already timed out
    if (signal?.aborted) return;

    await updateSchedulerRun(supabaseClient, runID, schedulerID, {
      status: hasPartialFailure ? 'partially_failed' : 'completed',
      completed_at: new Date().toISOString(),
      result: lastOutput,
    });
  } catch (error: unknown) {
    if (signal?.aborted) return;

    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Scheduler execution failed', error, {
      function: 'executeScheduler',
      metadata: { schedulerID, runID },
    });

    await updateSchedulerRun(supabaseClient, runID, schedulerID, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: errorMessage,
    }).catch((updateError: unknown) => {
      logger.error('Failed to update run status after error', updateError, {
        function: 'executeScheduler',
        metadata: { schedulerID, runID },
      });
    });
  } finally {
    if (signal?.aborted) return;
    // Always update last_run_at
    await updateScheduler(supabaseClient, schedulerID, userUUID, {
      last_run_at: new Date().toISOString(),
    }).catch((updateError: unknown) => {
      logger.error('Failed to update scheduler last_run_at', updateError, {
        function: 'executeScheduler',
        metadata: { schedulerID },
      });
    });
  }
}
