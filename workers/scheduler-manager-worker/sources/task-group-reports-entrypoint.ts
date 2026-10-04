import { WorkerEntrypoint } from 'cloudflare:workers';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import { createWorkerLogger } from '@audio-underview/logger';
import type { Environment } from './index.ts';
import {
  type TaskGroupProgressReport,
  type TaskGroupReportDependencies,
  type TaskGroupReportResult,
  reportTaskGroupProgress,
  completeTaskGroupRun,
  failTaskGroupRun,
} from './task-group-reports.ts';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'task-group-reports',
  },
});

// A module function rather than a method, so it is not exposed over RPC
function createDependencies(environment: Environment): TaskGroupReportDependencies {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });
  return { supabaseClient, workflow: environment.SCHEDULER_RUN_WORKFLOW, logger };
}

/**
 * The entrypoint a task group's worker binds to, to report on the stage runs it was started for.
 * The logic lives in task-group-reports.ts.
 */
export class TaskGroupReports extends WorkerEntrypoint<Environment> {
  async fetch(): Promise<Response> {
    return Response.json({ error: 'not_found', error_description: 'Endpoint not found' }, { status: 404 });
  }

  async reportProgress(stageRunID: string, progress: TaskGroupProgressReport): Promise<TaskGroupReportResult> {
    return reportTaskGroupProgress(createDependencies(this.env), stageRunID, progress);
  }

  async complete(stageRunID: string, output: unknown): Promise<TaskGroupReportResult> {
    return completeTaskGroupRun(createDependencies(this.env), stageRunID, output);
  }

  async fail(stageRunID: string, errorMessage: string): Promise<TaskGroupReportResult> {
    return failTaskGroupRun(createDependencies(this.env), stageRunID, errorMessage);
  }
}
