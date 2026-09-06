import type { DatabaseClient } from '../client.ts';
import { DatabaseOperationError, isNoRowsError } from '../errors.ts';
import { resolveListRange, type ListOptions, type ListResult } from '../pagination.ts';
import type { SchedulerRow, SchedulersInsert, SchedulersUpdate } from '../types/database.ts';

export const createScheduler = async (
  client: DatabaseClient,
  input: SchedulersInsert,
): Promise<SchedulerRow> => {
  const { data, error } = await client.from('schedulers').insert(input).select().single();

  if (error !== null) {
    throw new DatabaseOperationError('create', 'scheduler', error);
  }
  return data;
};

export const listSchedulersByUser = async (
  client: DatabaseClient,
  userUUID: string,
  options: ListOptions = {},
): Promise<ListResult<SchedulerRow>> => {
  const { from, to } = resolveListRange(options);
  const { data, error, count } = await client
    .from('schedulers')
    .select('*', { count: 'exact' })
    .eq('user_uuid', userUUID)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error !== null) {
    throw new DatabaseOperationError('list', 'schedulers', error);
  }
  return { data, total: count ?? 0 };
};

export const getScheduler = async (
  client: DatabaseClient,
  id: string,
  userUUID: string,
): Promise<SchedulerRow | undefined> => {
  const { data, error } = await client
    .from('schedulers')
    .select('*')
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('get', 'scheduler', error);
  }
  return data;
};

export const updateScheduler = async (
  client: DatabaseClient,
  id: string,
  userUUID: string,
  input: SchedulersUpdate,
): Promise<SchedulerRow | undefined> => {
  const { data, error } = await client
    .from('schedulers')
    .update(input)
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .select()
    .single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('update', 'scheduler', error);
  }
  return data;
};

export const deleteScheduler = async (
  client: DatabaseClient,
  id: string,
  userUUID: string,
): Promise<boolean> => {
  const { data, error } = await client
    .from('schedulers')
    .delete()
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .select('id');

  if (error !== null) {
    throw new DatabaseOperationError('delete', 'scheduler', error);
  }
  return data.length > 0;
};

/**
 * cron 자동 실행 대상 조회 — `is_enabled = true`이고 cron_expression이 있는 scheduler.
 * (신규 — scheduled handler용. 레거시는 cron 실행 자체가 미구현이었다.)
 */
export const listEnabledSchedulersWithCron = async (
  client: DatabaseClient,
): Promise<SchedulerRow[]> => {
  const { data, error } = await client
    .from('schedulers')
    .select('*')
    .eq('is_enabled', true)
    .not('cron_expression', 'is', null);

  if (error !== null) {
    throw new DatabaseOperationError('list', 'enabled schedulers', error);
  }
  return data;
};
