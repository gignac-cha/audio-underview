import type { DatabaseClient } from '../client.ts';
import { DatabaseOperationError, isNoRowsError } from '../errors.ts';
import type {
  SchedulerStageRow,
  SchedulerStagesInsert,
  SchedulerStagesUpdate,
} from '../types/database.ts';

export const createSchedulerStage = async (
  client: DatabaseClient,
  input: SchedulerStagesInsert,
): Promise<SchedulerStageRow> => {
  const { data, error } = await client.from('scheduler_stages').insert(input).select().single();

  if (error !== null) {
    throw new DatabaseOperationError('create', 'scheduler stage', error);
  }
  return data;
};

export const listSchedulerStages = async (
  client: DatabaseClient,
  schedulerID: string,
): Promise<SchedulerStageRow[]> => {
  const { data, error } = await client
    .from('scheduler_stages')
    .select('*')
    .eq('scheduler_id', schedulerID)
    .order('stage_order', { ascending: true });

  if (error !== null) {
    throw new DatabaseOperationError('list', 'scheduler stages', error);
  }
  return data;
};

export const getSchedulerStage = async (
  client: DatabaseClient,
  id: string,
  schedulerID: string,
): Promise<SchedulerStageRow | undefined> => {
  const { data, error } = await client
    .from('scheduler_stages')
    .select('*')
    .eq('id', id)
    .eq('scheduler_id', schedulerID)
    .single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('get', 'scheduler stage', error);
  }
  return data;
};

export const updateSchedulerStage = async (
  client: DatabaseClient,
  id: string,
  schedulerID: string,
  input: SchedulerStagesUpdate,
): Promise<SchedulerStageRow | undefined> => {
  const { data, error } = await client
    .from('scheduler_stages')
    .update(input)
    .eq('id', id)
    .eq('scheduler_id', schedulerID)
    .select()
    .single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('update', 'scheduler stage', error);
  }
  return data;
};

export const deleteSchedulerStage = async (
  client: DatabaseClient,
  id: string,
  schedulerID: string,
): Promise<boolean> => {
  const { data, error } = await client
    .from('scheduler_stages')
    .delete()
    .eq('id', id)
    .eq('scheduler_id', schedulerID)
    .select('id');

  if (error !== null) {
    throw new DatabaseOperationError('delete', 'scheduler stage', error);
  }
  return data.length > 0;
};

/**
 * 전체 stage 재정렬 — RPC (migration 005). DEFERRABLE unique 제약 덕에
 * 트랜잭션 커밋 시점에만 (scheduler_id, stage_order) 유일성이 검사된다.
 * 배열은 해당 scheduler의 **모든** stage id를 순서대로 담아야 한다.
 */
export const reorderSchedulerStages = async (
  client: DatabaseClient,
  schedulerID: string,
  stageIDs: string[],
): Promise<SchedulerStageRow[]> => {
  const { data, error } = await client.rpc('reorder_scheduler_stages', {
    p_scheduler_id: schedulerID,
    p_stage_ids: stageIDs,
  });

  if (error !== null) {
    throw new DatabaseOperationError('reorder', 'scheduler stages', error);
  }
  return data;
};
