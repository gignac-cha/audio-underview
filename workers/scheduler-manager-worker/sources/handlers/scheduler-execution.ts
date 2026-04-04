import {
  type ResponseContext,
  jsonResponse,
} from '@audio-underview/worker-tools';
import {
  createSupabaseClient,
  createSchedulerRun,
  getSchedulerRun,
  updateSchedulerRun,
} from '@audio-underview/supabase-connector';
import { createWorkerLogger } from '@audio-underview/logger';
import type { Environment } from '../index.ts';
import { ServiceBindingCrawlerExecutionClient } from '../crawler-execution-client.ts';
import { executeScheduler } from '../scheduler-executor.ts';
import { verifySchedulerOwnership } from './tools.ts';

export function resolveHTTPStatus(status: string, error: string | null | undefined): number {
  if (status === 'completed' || status === 'partially_failed') return 200;
  if (status !== 'failed' || error == null) return 200;

  if (error.includes('timed out')) return 408;
  if (error.includes('Invalid input_schema') || error.includes('fan_out_field')) return 422;
  if (error.includes('CodeRunner error') || error.includes('Invalid CrawlerExecuteResult')) return 502;
  if (error.includes('Supabase') || error.includes('database')) return 503;

  return 200;
}

const logger = createWorkerLogger({
  defaultContext: {
    module: 'scheduler-execution-handler',
  },
});

export async function handleExecuteScheduler(
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const ownershipError = await verifySchedulerOwnership(supabaseClient, schedulerID, userUUID, context);
  if (ownershipError) return ownershipError;

  // Atomic concurrent run guard via DB unique partial index
  // (scheduler_runs_one_active_per_scheduler: only one pending/running run per scheduler)
  let run;
  try {
    run = await createSchedulerRun(supabaseClient, {
      scheduler_id: schedulerID,
      status: 'pending',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('scheduler_runs_one_active_per_scheduler')) {
      return jsonResponse({
        error: 'conflict',
        error_description: 'A run is already in progress',
      }, 409, context);
    }
    throw error;
  }

  const crawlerExecutionClient = new ServiceBindingCrawlerExecutionClient(environment.CRAWLER_MANAGER);

  // Pipeline timeout: 5 minutes. Prevents run stuck in 'running' on client disconnect or hang.
  // AbortController signals executeScheduler to stop updating run status after timeout.
  const PIPELINE_TIMEOUT_MILLISECONDS = 300_000;
  const abortController = new AbortController();

  try {
    await Promise.race([
      executeScheduler(
        { supabaseClient, crawlerExecutionClient, logger },
        schedulerID,
        userUUID,
        run.id,
        abortController.signal,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Pipeline execution timed out after 5 minutes')), PIPELINE_TIMEOUT_MILLISECONDS),
      ),
    ]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('timed out')) {
      abortController.abort();
      await updateSchedulerRun(supabaseClient, run.id, schedulerID, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: message,
      }).catch((updateError: unknown) => {
        logger.error('Failed to update run status after timeout', updateError, {
          function: 'handleExecuteScheduler',
          metadata: { schedulerID, runID: run.id },
        });
      });
    }
  }

  // Fetch final run state
  const completedRun = await getSchedulerRun(supabaseClient, run.id, schedulerID);
  const finalRun = completedRun ?? run;

  const responseBody = {
    run_id: finalRun.id,
    status: finalRun.status,
    result: finalRun.result,
    error: finalRun.error,
    started_at: finalRun.started_at,
    completed_at: finalRun.completed_at,
  };

  const httpStatus = resolveHTTPStatus(finalRun.status, finalRun.error);
  return jsonResponse(responseBody, httpStatus, context);
}
