import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  SchedulerRunStatus,
  SchedulerStageRunProgress,
  SchedulerStageRunRow,
  SchedulerStageRunSummary,
  SchedulerStageRunsInsert,
  SchedulerStageRunsUpdate,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

export async function createSchedulerStageRun(
  client: SupabaseClientType,
  input: SchedulerStageRunsInsert,
): Promise<SchedulerStageRunRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.insert.run_id', input.run_id);
      span.setAttribute('db.insert.stage_id', input.stage_id);
      span.setAttribute('db.insert.stage_order', input.stage_order);

      const { data, error } = await client
        .from('scheduler_stage_runs')
        .insert(input)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create scheduler stage run: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      span.setAttribute('db.created_id', (data as SchedulerStageRunRow).id);
      return data as SchedulerStageRunRow;
    },
  );
}

export async function getSchedulerStageRun(
  client: SupabaseClientType,
  id: string,
  runID: string,
): Promise<SchedulerStageRunRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.query.id', id);
      span.setAttribute('db.query.run_id', runID);

      const { data, error } = await client
        .from('scheduler_stage_runs')
        .select('*')
        .eq('id', id)
        .eq('run_id', runID)
        .maybeSingle();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get scheduler stage run: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', data === null ? 0 : 1);
      return (data as SchedulerStageRunRow | null) ?? undefined;
    },
  );
}

/**
 * Gets one stage run by ID whatever its run, if it exists.
 * The task group reports only know the stage run ID.
 */
export async function getSchedulerStageRunByID(
  client: SupabaseClientType,
  id: string,
): Promise<SchedulerStageRunRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.query.id', id);

      const { data, error } = await client
        .from('scheduler_stage_runs')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get scheduler stage run by ID: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', data === null ? 0 : 1);
      return (data as SchedulerStageRunRow | null) ?? undefined;
    },
  );
}

/**
 * Gets the stage run of one stage in one run, if it exists. When there are several, the one created last.
 */
export async function getSchedulerStageRunByStage(
  client: SupabaseClientType,
  runID: string,
  stageID: string,
): Promise<SchedulerStageRunRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.query.run_id', runID);
      span.setAttribute('db.query.stage_id', stageID);

      const { data, error } = await client
        .from('scheduler_stage_runs')
        .select('*')
        .eq('run_id', runID)
        .eq('stage_id', stageID)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get scheduler stage run by stage: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', data === null ? 0 : 1);
      return (data as SchedulerStageRunRow | null) ?? undefined;
    },
  );
}

/**
 * Updates a stage run.
 *
 * @param options.onlyIfStatus - change the stage run only while its status is one of these
 * @returns the updated stage run, or undefined when no stage run matched
 */
export async function updateSchedulerStageRun(
  client: SupabaseClientType,
  id: string,
  runID: string,
  input: SchedulerStageRunsUpdate,
  options?: { onlyIfStatus?: readonly SchedulerRunStatus[] },
): Promise<SchedulerStageRunRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'update', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.update.id', id);
      span.setAttribute('db.update.run_id', runID);

      let query = client
        .from('scheduler_stage_runs')
        .update(input)
        .eq('id', id)
        .eq('run_id', runID);

      if (options?.onlyIfStatus !== undefined) {
        query = query.in('status', options.onlyIfStatus);
      }

      const { data, error } = await query
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to update scheduler stage run: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as SchedulerStageRunRow;
    },
  );
}

export async function listSchedulerStageRunsByRun(
  client: SupabaseClientType,
  runID: string,
): Promise<SchedulerStageRunRow[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.query.run_id', runID);

      const { data, error } = await client
        .from('scheduler_stage_runs')
        .select('*')
        .eq('run_id', runID)
        .order('stage_order', { ascending: true });

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list scheduler stage runs: ${error.message}`);
      }

      const stageRuns = (data ?? []) as SchedulerStageRunRow[];
      span.setAttribute('db.rows_affected', stageRuns.length);
      return stageRuns;
    },
  );
}

// Every column except input and output, which can be large
const STAGE_RUN_SUMMARY_COLUMNS = [
  'id',
  'run_id',
  'stage_id',
  'stage_order',
  'status',
  'started_at',
  'completed_at',
  'error',
  'items_total',
  'items_succeeded',
  'items_failed',
  'task_group_id',
  'task_group_version',
  'progress',
  'created_at',
].join(',');

/**
 * Lists the stage runs of a run without their input and output, by stage order.
 */
export async function listSchedulerStageRunSummaries(
  client: SupabaseClientType,
  runID: string,
): Promise<SchedulerStageRunSummary[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.query.run_id', runID);

      const { data, error } = await client
        .from('scheduler_stage_runs')
        .select(STAGE_RUN_SUMMARY_COLUMNS)
        .eq('run_id', runID)
        .order('stage_order', { ascending: true });

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list scheduler stage run summaries: ${error.message}`);
      }

      const summaries = (data ?? []) as unknown as SchedulerStageRunSummary[];
      span.setAttribute('db.rows_affected', summaries.length);
      return summaries;
    },
  );
}

/**
 * Stores the latest progress a task group reported, only while the stage run is running.
 *
 * @returns whether the stage run changed
 */
export async function setSchedulerStageRunProgress(
  client: SupabaseClientType,
  id: string,
  progress: SchedulerStageRunProgress,
): Promise<boolean> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'update', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.update.id', id);

      const { data, error } = await client
        .from('scheduler_stage_runs')
        .update({ progress })
        .eq('id', id)
        .eq('status', 'running')
        .select('id');

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to set scheduler stage run progress: ${error.message}`);
      }

      const rowsAffected = data?.length ?? 0;
      span.setAttribute('db.rows_affected', rowsAffected);
      return rowsAffected > 0;
    },
  );
}

/**
 * Closes the stage runs of a run that are still pending or running as failed.
 * No stage run to close is not an error.
 *
 * @param failedAt - ISO timestamp stored as completed_at
 * @param failureMessage - stored as error
 * @returns the number of stage runs changed
 */
export async function failActiveSchedulerStageRuns(
  client: SupabaseClientType,
  runID: string,
  failedAt: string,
  failureMessage: string,
): Promise<number> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'update', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.update.run_id', runID);

      const { data, error } = await client
        .from('scheduler_stage_runs')
        .update({ status: 'failed', completed_at: failedAt, error: failureMessage })
        .eq('run_id', runID)
        .in('status', ['pending', 'running'])
        .select('id');

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to mark scheduler stage runs as failed: ${error.message}`);
      }

      const rowsAffected = data?.length ?? 0;
      span.setAttribute('db.rows_affected', rowsAffected);
      return rowsAffected;
    },
  );
}
