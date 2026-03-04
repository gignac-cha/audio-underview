import {
  type ResponseContext,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import {
  createSupabaseClient,
  createSchedulerRun,
  listSchedulerRuns,
  getSchedulerRun,
} from '@audio-underview/supabase-connector';
import { createWorkerLogger } from '@audio-underview/logger';
import type { Environment } from '../index.ts';
import { ServiceBindingCrawlerExecutionClient } from '../crawler-execution-client.ts';
import { executeScheduler } from '../scheduler-executor.ts';
import { verifySchedulerOwnership } from './tools.ts';

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

  // Concurrent run guard
  const recentRuns = await listSchedulerRuns(supabaseClient, schedulerID, { limit: 1 });
  if (recentRuns.data.length > 0) {
    const latestRun = recentRuns.data[0];
    if (latestRun.status === 'pending' || latestRun.status === 'running') {
      return jsonResponse({
        error: 'conflict',
        error_description: 'A run is already in progress',
        run_id: latestRun.id,
        status: latestRun.status,
      }, 409, context);
    }
  }

  const run = await createSchedulerRun(supabaseClient, {
    scheduler_id: schedulerID,
    status: 'pending',
  });

  const crawlerExecutionClient = new ServiceBindingCrawlerExecutionClient(environment.CRAWLER_MANAGER);

  // Await full pipeline execution (Worker wall clock unlimited while client connected)
  await executeScheduler(
    { supabaseClient, crawlerExecutionClient, logger },
    schedulerID,
    userUUID,
    run.id,
  );

  // Fetch final run state
  const completedRun = await getSchedulerRun(supabaseClient, run.id, schedulerID);
  const finalRun = completedRun ?? run;

  return jsonResponse({
    run_id: finalRun.id,
    status: finalRun.status,
    result: finalRun.result,
    error: finalRun.error,
    started_at: finalRun.started_at,
    completed_at: finalRun.completed_at,
  }, 200, context);
}
