import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  SchedulerStageRunRow,
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

export async function updateSchedulerStageRun(
  client: SupabaseClientType,
  id: string,
  runID: string,
  input: SchedulerStageRunsUpdate,
): Promise<SchedulerStageRunRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'update', table: 'scheduler_stage_runs' },
    async (span) => {
      span.setAttribute('db.update.id', id);
      span.setAttribute('db.update.run_id', runID);

      const { data, error } = await client
        .from('scheduler_stage_runs')
        .update(input)
        .eq('id', id)
        .eq('run_id', runID)
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
