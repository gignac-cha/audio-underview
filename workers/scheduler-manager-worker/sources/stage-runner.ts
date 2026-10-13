import type { SupabaseClient } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import type {
  SchedulerStageRow,
  SchedulerStageRunRow,
} from '@audio-underview/supabase-connector';
import {
  createSchedulerStageRun,
  updateSchedulerStageRun,
} from '@audio-underview/supabase-connector';
import type { CrawlerLogEntry, CrawlerRunOutcome } from '@audio-underview/worker-tools';
import type { CrawlerExecutionClient } from './crawler-execution-client.ts';
import { limitCrawlerLogs } from './crawler-logs.ts';

/** A stage that runs a crawler: every stage the functions of this file run */
export type CrawlerStageRow = SchedulerStageRow & { crawler_id: string };

export interface StageRunnerDependencies {
  supabaseClient: SupabaseClient;
  crawlerExecutionClient: CrawlerExecutionClient;
  logger: Logger;
  /** The user the crawlers run for: the owner of the scheduler */
  userUUID: string;
}

export interface StageResult {
  output: unknown;
  stageRun: SchedulerStageRunRow;
}

export interface FanOutResult {
  results: unknown[];
  itemsTotal: number;
  itemsSucceeded: number;
  itemsFailed: number;
  status: 'completed' | 'partially_failed' | 'failed';
  /** The logs of every item in item order, each entry with its item_index, within the limits of one run */
  logs: CrawlerLogEntry[];
  logsTruncated: boolean;
}

export async function executeStage(
  dependencies: StageRunnerDependencies,
  runID: string,
  stage: CrawlerStageRow,
  input: unknown,
  signal?: AbortSignal,
): Promise<StageResult> {
  const { supabaseClient, crawlerExecutionClient, logger, userUUID } = dependencies;

  if (signal?.aborted) {
    throw new Error('Stage execution aborted: pipeline timed out');
  }

  const stageRun = await createSchedulerStageRun(supabaseClient, {
    run_id: runID,
    stage_id: stage.id,
    stage_order: stage.stage_order,
    status: 'running',
    started_at: new Date().toISOString(),
    input,
  });

  let failedOutcome: Extract<CrawlerRunOutcome, { status: 'failed' }>;
  try {
    const outcome = await crawlerExecutionClient.run(stage.crawler_id, input, { userUUID, runID });

    if (outcome.status === 'completed') {
      const updatedStageRun = await updateSchedulerStageRun(supabaseClient, stageRun.id, runID, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        output: outcome.result,
        logs: outcome.logs,
        logs_truncated: outcome.logs_truncated,
      });

      return { output: outcome.result, stageRun: updatedStageRun ?? stageRun };
    }
    failedOutcome = outcome;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Stage execution failed', error, {
      function: 'executeStage',
      metadata: { stageID: stage.id, stageOrder: stage.stage_order },
    });

    await updateSchedulerStageRun(supabaseClient, stageRun.id, runID, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: errorMessage,
    }).catch((updateError: unknown) => {
      logger.error('Failed to update stage run status after error', updateError, {
        function: 'executeStage',
        metadata: { stageRunID: stageRun.id, runID },
      });
    });

    throw error;
  }

  // The crawler code failed: recorded once with its logs, then the run fails like before
  const failure = new Error(failedOutcome.error);
  logger.error('Stage execution failed', failure, {
    function: 'executeStage',
    metadata: { stageID: stage.id, stageOrder: stage.stage_order },
  });

  await updateSchedulerStageRun(supabaseClient, stageRun.id, runID, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    error: failedOutcome.error,
    logs: failedOutcome.logs,
    logs_truncated: failedOutcome.logs_truncated,
  }).catch((updateError: unknown) => {
    logger.error('Failed to update stage run status after error', updateError, {
      function: 'executeStage',
      metadata: { stageRunID: stageRun.id, runID },
    });
  });

  throw failure;
}

const FAN_OUT_FAILED = Symbol('fan-out-failed');

function withItemIndex(logs: CrawlerLogEntry[], itemIndex: number): CrawlerLogEntry[] {
  return logs.map((entry) => ({ ...entry, item_index: itemIndex }));
}

export async function executeFanOut(
  dependencies: StageRunnerDependencies,
  runID: string,
  stage: CrawlerStageRow,
  items: unknown[],
  concurrency: number = 1,
  signal?: AbortSignal,
): Promise<FanOutResult> {
  const { crawlerExecutionClient, logger, userUUID } = dependencies;

  const results: (unknown | typeof FAN_OUT_FAILED)[] = new Array(items.length).fill(FAN_OUT_FAILED);
  const itemLogs: CrawlerLogEntry[][] = Array.from({ length: items.length }, () => []);
  let itemLogsTruncated = false;
  let itemsSucceeded = 0;
  let itemsFailed = 0;

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (signal?.aborted) break;
      const index = nextIndex++;
      const item = items[index];
      try {
        const outcome = await crawlerExecutionClient.run(stage.crawler_id, item, { userUUID, runID });
        if (outcome.logs_truncated) {
          itemLogsTruncated = true;
        }
        if (outcome.status === 'completed') {
          results[index] = outcome.result;
          itemLogs[index] = withItemIndex(outcome.logs, index);
          itemsSucceeded++;
        } else {
          logger.warn('Fan-out item failed', new Error(outcome.error), {
            function: 'executeFanOut',
            metadata: { stageID: stage.id, itemIndex: index },
          });
          itemLogs[index] = [
            ...withItemIndex(outcome.logs, index),
            { level: 'error', message: outcome.error, timestamp: new Date().toISOString(), item_index: index },
          ];
          itemsFailed++;
        }
      } catch (error: unknown) {
        logger.warn('Fan-out item failed', error, {
          function: 'executeFanOut',
          metadata: { stageID: stage.id, itemIndex: index },
        });
        itemLogs[index] = [{
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
          item_index: index,
        }];
        itemsFailed++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  let status: 'completed' | 'partially_failed' | 'failed';
  if (itemsFailed === 0) {
    status = 'completed';
  } else if (itemsSucceeded > 0) {
    status = 'partially_failed';
  } else {
    status = 'failed';
  }

  const strategy = stage.fan_out_strategy ?? 'compact';
  const finalResults = strategy === 'preserve'
    ? results.map((result) => result === FAN_OUT_FAILED ? null : result)
    : results.filter((result) => result !== FAN_OUT_FAILED);

  // In item order whatever order the items ended in, within the limits of the logs of one run
  const { logs, truncated } = limitCrawlerLogs(itemLogs.flat());

  return {
    results: finalResults,
    itemsTotal: items.length,
    itemsSucceeded,
    itemsFailed,
    status,
    logs,
    logsTruncated: itemLogsTruncated || truncated,
  };
}
