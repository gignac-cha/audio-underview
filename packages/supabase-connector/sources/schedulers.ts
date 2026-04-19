import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  SchedulerRow,
  SchedulersInsert,
  SchedulersUpdate,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

export interface PaginatedSchedulers {
  data: SchedulerRow[];
  total: number;
}

export async function createScheduler(
  client: SupabaseClientType,
  input: SchedulersInsert,
): Promise<SchedulerRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'schedulers' },
    async (span) => {
      span.setAttribute('db.insert.user_uuid', input.user_uuid);
      span.setAttribute('db.insert.name', input.name);

      const { data, error } = await client
        .from('schedulers')
        .insert(input)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create scheduler: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      span.setAttribute('db.created_id', (data as SchedulerRow).id);
      return data as SchedulerRow;
    },
  );
}

export async function listSchedulersByUser(
  client: SupabaseClientType,
  userUUID: string,
  options?: { offset?: number; limit?: number },
): Promise<PaginatedSchedulers> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'schedulers' },
    async (span) => {
      const offset = Math.max(0, options?.offset ?? 0);
      const limit = Math.min(100, Math.max(1, options?.limit ?? 20));

      span.setAttribute('db.query.user_uuid', userUUID);
      span.setAttribute('db.query.offset', offset);
      span.setAttribute('db.query.limit', limit);

      const { data, error, count } = await client
        .from('schedulers')
        .select('*', { count: 'exact' })
        .eq('user_uuid', userUUID)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list schedulers: ${error.message}`);
      }

      const schedulers = (data ?? []) as SchedulerRow[];
      span.setAttribute('db.rows_affected', schedulers.length);
      span.setAttribute('db.total_count', count ?? 0);
      return { data: schedulers, total: count ?? 0 };
    },
  );
}

export async function getScheduler(
  client: SupabaseClientType,
  id: string,
  userUUID: string,
): Promise<SchedulerRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'schedulers' },
    async (span) => {
      span.setAttribute('db.query.id', id);
      span.setAttribute('db.query.user_uuid', userUUID);

      const { data, error } = await client
        .from('schedulers')
        .select('*')
        .eq('id', id)
        .eq('user_uuid', userUUID)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get scheduler: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as SchedulerRow;
    },
  );
}

export async function updateScheduler(
  client: SupabaseClientType,
  id: string,
  userUUID: string,
  input: SchedulersUpdate,
): Promise<SchedulerRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'update', table: 'schedulers' },
    async (span) => {
      span.setAttribute('db.update.id', id);
      span.setAttribute('db.update.user_uuid', userUUID);

      const { data, error } = await client
        .from('schedulers')
        .update(input)
        .eq('id', id)
        .eq('user_uuid', userUUID)
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to update scheduler: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as SchedulerRow;
    },
  );
}

export async function deleteScheduler(
  client: SupabaseClientType,
  id: string,
  userUUID: string,
): Promise<boolean> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'delete', table: 'schedulers' },
    async (span) => {
      span.setAttribute('db.delete.id', id);
      span.setAttribute('db.delete.user_uuid', userUUID);

      const { data, error } = await client
        .from('schedulers')
        .delete()
        .eq('id', id)
        .eq('user_uuid', userUUID)
        .select();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to delete scheduler: ${error.message}`);
      }

      const rowsAffected = data?.length ?? 0;
      span.setAttribute('db.rows_affected', rowsAffected);
      return rowsAffected > 0;
    },
  );
}
