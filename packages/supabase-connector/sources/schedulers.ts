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

/**
 * Gets a scheduler by ID alone, with no ownership condition.
 * For server-side callers (the scheduled run) that act on behalf of the stored owner.
 */
export async function getSchedulerByID(
  client: SupabaseClientType,
  id: string,
): Promise<SchedulerRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'schedulers' },
    async (span) => {
      span.setAttribute('db.query.id', id);

      const { data, error } = await client
        .from('schedulers')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get scheduler by ID: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', data === null ? 0 : 1);
      return (data as SchedulerRow | null) ?? undefined;
    },
  );
}

/**
 * Lists enabled schedulers with a cron expression whose next run is due, oldest first.
 *
 * @param now - ISO timestamp; schedulers with next_run_at at or before it are due
 */
export async function listSchedulersDue(
  client: SupabaseClientType,
  now: string,
  limit: number,
): Promise<SchedulerRow[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'schedulers' },
    async (span) => {
      span.setAttribute('db.query.now', now);
      span.setAttribute('db.query.limit', limit);

      const { data, error } = await client
        .from('schedulers')
        .select('*')
        .eq('is_enabled', true)
        .not('cron_expression', 'is', null)
        .lte('next_run_at', now)
        .order('next_run_at', { ascending: true })
        .limit(limit);

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list due schedulers: ${error.message}`);
      }

      const schedulers = (data ?? []) as SchedulerRow[];
      span.setAttribute('db.rows_affected', schedulers.length);
      return schedulers;
    },
  );
}

/**
 * Lists enabled schedulers with a cron expression that have no next run computed yet,
 * ordered by created_at, then id.
 *
 * @param after - keyset cursor; only rows strictly after this (created_at, id) are returned
 */
export async function listSchedulersWithoutNextRun(
  client: SupabaseClientType,
  limit: number,
  after?: { created_at: string; id: string },
): Promise<SchedulerRow[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'schedulers' },
    async (span) => {
      span.setAttribute('db.query.limit', limit);

      let query = client
        .from('schedulers')
        .select('*')
        .eq('is_enabled', true)
        .not('cron_expression', 'is', null)
        .is('next_run_at', null);

      if (after !== undefined) {
        span.setAttribute('db.query.after_created_at', after.created_at);
        span.setAttribute('db.query.after_id', after.id);
        // The timestamp is quoted because PostgREST reserves '.' and ':' in filter values
        query = query.or(
          `created_at.gt."${after.created_at}",and(created_at.eq."${after.created_at}",id.gt.${after.id})`,
        );
      }

      const { data, error } = await query
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit);

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list schedulers without next run: ${error.message}`);
      }

      const schedulers = (data ?? []) as SchedulerRow[];
      span.setAttribute('db.rows_affected', schedulers.length);
      return schedulers;
    },
  );
}

/**
 * Sets next_run_at only while it still equals the value the caller read
 * (IS NULL when `expected` is null), so a concurrent change is not overwritten.
 *
 * @returns true when a row changed
 */
export async function setSchedulerNextRun(
  client: SupabaseClientType,
  id: string,
  expected: string | null,
  next: string | null,
): Promise<boolean> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'update', table: 'schedulers' },
    async (span) => {
      span.setAttribute('db.update.id', id);

      let query = client
        .from('schedulers')
        .update({ next_run_at: next })
        .eq('id', id);

      query = expected === null
        ? query.is('next_run_at', null)
        : query.eq('next_run_at', expected);

      const { data, error } = await query.select('id');

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to set scheduler next run: ${error.message}`);
      }

      const rowsAffected = data?.length ?? 0;
      span.setAttribute('db.rows_affected', rowsAffected);
      return rowsAffected > 0;
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
