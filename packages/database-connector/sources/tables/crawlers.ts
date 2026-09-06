import type { DatabaseClient } from '../client.ts';
import { DatabaseOperationError, isNoRowsError } from '../errors.ts';
import { resolveListRange, type ListOptions, type ListResult } from '../pagination.ts';
import type { CrawlerRow, CrawlersUpdate } from '../types/database.ts';

export interface CreateCrawlerInput {
  userUUID: string;
  name: string;
  type: CrawlerRow['type'];
  urlPattern: string | null;
  code: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/**
 * crawler + owner permission을 원자적으로 생성 — 트랜잭션 RPC (migration 010).
 */
export const createCrawlerWithOwnerPermission = async (
  client: DatabaseClient,
  input: CreateCrawlerInput,
): Promise<CrawlerRow> => {
  const { data, error } = await client.rpc('create_crawler_with_owner_permission', {
    p_user_uuid: input.userUUID,
    p_name: input.name,
    p_type: input.type,
    p_url_pattern: input.urlPattern,
    p_code: input.code,
    p_input_schema: input.inputSchema,
    p_output_schema: input.outputSchema,
  });

  if (error !== null) {
    throw new DatabaseOperationError('create', 'crawler', error);
  }
  const row = data[0];
  if (row === undefined) {
    throw new DatabaseOperationError('create', 'crawler', 'empty RPC result');
  }
  return row;
};

export const listCrawlersByUser = async (
  client: DatabaseClient,
  userUUID: string,
  options: ListOptions = {},
): Promise<ListResult<CrawlerRow>> => {
  const { from, to } = resolveListRange(options);
  const { data, error, count } = await client
    .from('crawlers')
    .select('*', { count: 'exact' })
    .eq('user_uuid', userUUID)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error !== null) {
    throw new DatabaseOperationError('list', 'crawlers', error);
  }
  return { data, total: count ?? 0 };
};

/** 소유권 무시 조회 — scheduler 실행 엔진 전용. */
export const getCrawlerByID = async (
  client: DatabaseClient,
  id: string,
): Promise<CrawlerRow | undefined> => {
  const { data, error } = await client.from('crawlers').select('*').eq('id', id).single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('get', 'crawler', error);
  }
  return data;
};

export const getCrawler = async (
  client: DatabaseClient,
  id: string,
  userUUID: string,
): Promise<CrawlerRow | undefined> => {
  const { data, error } = await client
    .from('crawlers')
    .select('*')
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('get', 'crawler', error);
  }
  return data;
};

export const updateCrawler = async (
  client: DatabaseClient,
  id: string,
  userUUID: string,
  input: CrawlersUpdate,
): Promise<CrawlerRow | undefined> => {
  const { data, error } = await client
    .from('crawlers')
    .update(input)
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .select()
    .single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('update', 'crawler', error);
  }
  return data;
};

/**
 * 삭제 성공 여부 반환. stage가 참조 중이면 FK RESTRICT로 실패한다 —
 * 호출측이 `isForeignKeyViolation`으로 409 매핑.
 */
export const deleteCrawler = async (
  client: DatabaseClient,
  id: string,
  userUUID: string,
): Promise<boolean> => {
  const { data, error } = await client
    .from('crawlers')
    .delete()
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .select('id');

  if (error !== null) {
    throw new DatabaseOperationError('delete', 'crawler', error);
  }
  return data.length > 0;
};
