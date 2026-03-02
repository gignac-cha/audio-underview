import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  SchedulerRunRow,
  SchedulerRunsInsert,
  SchedulerRunsUpdate,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

export interface PaginatedSchedulerRuns {
  data: SchedulerRunRow[];
  total: number;
}

export async function createSchedulerRun(
  client: SupabaseClientType,
  input: SchedulerRunsInsert,
): Promise<SchedulerRunRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'scheduler_runs' },
    async (span) => {
      span.setAttribute('db.insert.scheduler_id', input.scheduler_id);

      const { data, error } = await client
        .from('scheduler_runs')
        .insert(input)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create scheduler run: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      span.setAttribute('db.created_id', (data as SchedulerRunRow).id);
      return data as SchedulerRunRow;
    },
  );
}

export async function getSchedulerRun(
  client: SupabaseClientType,
  id: string,
  schedulerID: string,
): Promise<SchedulerRunRow | null> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'scheduler_runs' },
    async (span) => {
      span.setAttribute('db.query.id', id);
      span.setAttribute('db.query.scheduler_id', schedulerID);

      const { data, error } = await client
        .from('scheduler_runs')
        .select('*')
        .eq('id', id)
        .eq('scheduler_id', schedulerID)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return null;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get scheduler run: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as SchedulerRunRow;
    },
  );
}

export async function updateSchedulerRun(
  client: SupabaseClientType,
  id: string,
  schedulerID: string,
  input: SchedulerRunsUpdate,
): Promise<SchedulerRunRow | null> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'update', table: 'scheduler_runs' },
    async (span) => {
      span.setAttribute('db.update.id', id);
      span.setAttribute('db.update.scheduler_id', schedulerID);

      const { data, error } = await client
        .from('scheduler_runs')
        .update(input)
        .eq('id', id)
        .eq('scheduler_id', schedulerID)
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return null;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to update scheduler run: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as SchedulerRunRow;
    },
  );
}

export async function listSchedulerRuns(
  client: SupabaseClientType,
  schedulerID: string,
  options?: { offset?: number; limit?: number },
): Promise<PaginatedSchedulerRuns> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'scheduler_runs' },
    async (span) => {
      const offset = Math.max(0, options?.offset ?? 0);
      const limit = Math.min(100, Math.max(1, options?.limit ?? 20));

      span.setAttribute('db.query.scheduler_id', schedulerID);
      span.setAttribute('db.query.offset', offset);
      span.setAttribute('db.query.limit', limit);

      const { data, error, count } = await client
        .from('scheduler_runs')
        .select('*', { count: 'exact' })
        .eq('scheduler_id', schedulerID)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list scheduler runs: ${error.message}`);
      }

      const runs = (data ?? []) as SchedulerRunRow[];
      span.setAttribute('db.rows_affected', runs.length);
      span.setAttribute('db.total_count', count ?? 0);
      return { data: runs, total: count ?? 0 };
    },
  );
}
