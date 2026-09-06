import type { DatabaseClient } from '../client.ts';
import { DatabaseOperationError, isNoRowsError } from '../errors.ts';
import type {
  SchedulerStageRunRow,
  SchedulerStageRunsInsert,
  SchedulerStageRunsUpdate,
} from '../types/database.ts';

export const createSchedulerStageRun = async (
  client: DatabaseClient,
  input: SchedulerStageRunsInsert,
): Promise<SchedulerStageRunRow> => {
  const { data, error } = await client
    .from('scheduler_stage_runs')
    .insert(input)
    .select()
    .single();

  if (error !== null) {
    throw new DatabaseOperationError('create', 'scheduler stage run', error);
  }
  return data;
};

export const updateSchedulerStageRun = async (
  client: DatabaseClient,
  id: string,
  runID: string,
  input: SchedulerStageRunsUpdate,
): Promise<SchedulerStageRunRow | undefined> => {
  const { data, error } = await client
    .from('scheduler_stage_runs')
    .update(input)
    .eq('id', id)
    .eq('run_id', runID)
    .select()
    .single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('update', 'scheduler stage run', error);
  }
  return data;
};

export const listSchedulerStageRunsByRun = async (
  client: DatabaseClient,
  runID: string,
): Promise<SchedulerStageRunRow[]> => {
  const { data, error } = await client
    .from('scheduler_stage_runs')
    .select('*')
    .eq('run_id', runID)
    .order('stage_order', { ascending: true });

  if (error !== null) {
    throw new DatabaseOperationError('list', 'scheduler stage runs', error);
  }
  return data;
};
