import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  SchedulerStageRow,
  SchedulerStagesInsert,
  SchedulerStagesUpdate,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

export async function reorderSchedulerStages(
  client: SupabaseClientType,
  schedulerID: string,
  stageIDs: string[],
): Promise<SchedulerStageRow[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'rpc', table: 'scheduler_stages' },
    async (span) => {
      span.setAttribute('db.rpc.function', 'reorder_scheduler_stages');
      span.setAttribute('db.rpc.scheduler_id', schedulerID);
      span.setAttribute('db.rpc.stage_count', stageIDs.length);

      const { data, error } = await client.rpc('reorder_scheduler_stages', {
        p_scheduler_id: schedulerID,
        p_stage_ids: stageIDs,
      });

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to reorder scheduler stages: ${error.message}`);
      }

      const stages = (data ?? []) as SchedulerStageRow[];
      span.setAttribute('db.rows_affected', stages.length);
      return stages;
    },
  );
}

export async function createSchedulerStage(
  client: SupabaseClientType,
  input: SchedulerStagesInsert,
): Promise<SchedulerStageRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'scheduler_stages' },
    async (span) => {
      span.setAttribute('db.insert.scheduler_id', input.scheduler_id);
      span.setAttribute('db.insert.crawler_id', input.crawler_id);
      span.setAttribute('db.insert.stage_order', input.stage_order);

      const { data, error } = await client
        .from('scheduler_stages')
        .insert(input)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create scheduler stage: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      span.setAttribute('db.created_id', (data as SchedulerStageRow).id);
      return data as SchedulerStageRow;
    },
  );
}

export async function listSchedulerStages(
  client: SupabaseClientType,
  schedulerID: string,
): Promise<SchedulerStageRow[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'scheduler_stages' },
    async (span) => {
      span.setAttribute('db.query.scheduler_id', schedulerID);

      const { data, error } = await client
        .from('scheduler_stages')
        .select('*')
        .eq('scheduler_id', schedulerID)
        .order('stage_order', { ascending: true });

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list scheduler stages: ${error.message}`);
      }

      const stages = (data ?? []) as SchedulerStageRow[];
      span.setAttribute('db.rows_affected', stages.length);
      return stages;
    },
  );
}

export async function getSchedulerStage(
  client: SupabaseClientType,
  id: string,
  schedulerID: string,
): Promise<SchedulerStageRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'scheduler_stages' },
    async (span) => {
      span.setAttribute('db.query.id', id);
      span.setAttribute('db.query.scheduler_id', schedulerID);

      const { data, error } = await client
        .from('scheduler_stages')
        .select('*')
        .eq('id', id)
        .eq('scheduler_id', schedulerID)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get scheduler stage: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as SchedulerStageRow;
    },
  );
}

export async function updateSchedulerStage(
  client: SupabaseClientType,
  id: string,
  schedulerID: string,
  input: SchedulerStagesUpdate,
): Promise<SchedulerStageRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'update', table: 'scheduler_stages' },
    async (span) => {
      span.setAttribute('db.update.id', id);
      span.setAttribute('db.update.scheduler_id', schedulerID);

      const { data, error } = await client
        .from('scheduler_stages')
        .update(input)
        .eq('id', id)
        .eq('scheduler_id', schedulerID)
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return undefined;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to update scheduler stage: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as SchedulerStageRow;
    },
  );
}

export async function deleteSchedulerStage(
  client: SupabaseClientType,
  id: string,
  schedulerID: string,
): Promise<boolean> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'delete', table: 'scheduler_stages' },
    async (span) => {
      span.setAttribute('db.delete.id', id);
      span.setAttribute('db.delete.scheduler_id', schedulerID);

      const { data, error } = await client
        .from('scheduler_stages')
        .delete()
        .eq('id', id)
        .eq('scheduler_id', schedulerID)
        .select();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to delete scheduler stage: ${error.message}`);
      }

      const rowsAffected = data?.length ?? 0;
      span.setAttribute('db.rows_affected', rowsAffected);
      return rowsAffected > 0;
    },
  );
}

