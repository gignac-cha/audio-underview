import type { SchedulerRunStatus } from '@audio-underview/schemas';
import type { DatabaseClient } from '../client.ts';
import { DatabaseOperationError, isNoRowsError } from '../errors.ts';
import { resolveListRange, type ListOptions, type ListResult } from '../pagination.ts';
import type {
  SchedulerRunRow,
  SchedulerRunsInsert,
  SchedulerRunsUpdate,
} from '../types/database.ts';

/**
 * run 생성. scheduler당 active run(pending/running) 1개 제약(partial unique
 * index, migration 006)에 걸리면 unique violation이 throw된다 —
 * 호출측이 `isUniqueViolation(error, ACTIVE_RUN_UNIQUE_INDEX)`로 409 매핑.
 */
export const createSchedulerRun = async (
  client: DatabaseClient,
  input: SchedulerRunsInsert,
): Promise<SchedulerRunRow> => {
  const { data, error } = await client.from('scheduler_runs').insert(input).select().single();

  if (error !== null) {
    throw new DatabaseOperationError('create', 'scheduler run', error);
  }
  return data;
};

export const getSchedulerRun = async (
  client: DatabaseClient,
  id: string,
  schedulerID: string,
): Promise<SchedulerRunRow | undefined> => {
  const { data, error } = await client
    .from('scheduler_runs')
    .select('*')
    .eq('id', id)
    .eq('scheduler_id', schedulerID)
    .single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('get', 'scheduler run', error);
  }
  return data;
};

export interface UpdateSchedulerRunOptions {
  /**
   * 조건부 상태 전이 guard — 현재 status가 이 목록에 있을 때만 갱신한다.
   * (timeout 경로와 executor의 race에서 종료 상태 덮어쓰기 방지)
   */
  onlyIfStatus?: SchedulerRunStatus[];
}

export const updateSchedulerRun = async (
  client: DatabaseClient,
  id: string,
  schedulerID: string,
  input: SchedulerRunsUpdate,
  options: UpdateSchedulerRunOptions = {},
): Promise<SchedulerRunRow | undefined> => {
  let query = client
    .from('scheduler_runs')
    .update(input)
    .eq('id', id)
    .eq('scheduler_id', schedulerID);

  if (options.onlyIfStatus !== undefined) {
    query = query.in('status', options.onlyIfStatus);
  }

  const { data, error } = await query.select().single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('update', 'scheduler run', error);
  }
  return data;
};

export const listSchedulerRuns = async (
  client: DatabaseClient,
  schedulerID: string,
  options: ListOptions = {},
): Promise<ListResult<SchedulerRunRow>> => {
  const { from, to } = resolveListRange(options);
  const { data, error, count } = await client
    .from('scheduler_runs')
    .select('*', { count: 'exact' })
    .eq('scheduler_id', schedulerID)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error !== null) {
    throw new DatabaseOperationError('list', 'scheduler runs', error);
  }
  return { data, total: count ?? 0 };
};
