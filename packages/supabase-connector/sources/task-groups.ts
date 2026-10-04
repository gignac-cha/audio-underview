import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type { Database, TaskGroupRow } from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

/**
 * Lists every registered task group version, by id and then version.
 */
export async function listTaskGroups(
  client: SupabaseClientType,
): Promise<TaskGroupRow[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'task_groups' },
    async (span) => {
      const { data, error } = await client
        .from('task_groups')
        .select('*')
        .order('id', { ascending: true })
        .order('version', { ascending: true });

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list task groups: ${error.message}`);
      }

      const taskGroups = (data ?? []) as TaskGroupRow[];
      span.setAttribute('db.rows_affected', taskGroups.length);
      return taskGroups;
    },
  );
}

/**
 * Gets one registered version of a task group, if it exists.
 */
export async function getTaskGroup(
  client: SupabaseClientType,
  id: string,
  version: number,
): Promise<TaskGroupRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'task_groups' },
    async (span) => {
      span.setAttribute('db.query.id', id);
      span.setAttribute('db.query.version', version);

      const { data, error } = await client
        .from('task_groups')
        .select('*')
        .eq('id', id)
        .eq('version', version)
        .maybeSingle();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get task group: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', data === null ? 0 : 1);
      return (data as TaskGroupRow | null) ?? undefined;
    },
  );
}
