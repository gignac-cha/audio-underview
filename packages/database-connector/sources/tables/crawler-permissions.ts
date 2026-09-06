import type { DatabaseClient } from '../client.ts';
import { DatabaseOperationError } from '../errors.ts';
import type { CrawlerPermissionRow } from '../types/database.ts';

/**
 * (crawler, user) permission 행 조회 — stage 생성/변경 시 사용 자격 검사용.
 * level 무관 (owner/subscriber 모두 stage에서 사용 가능 — 레거시 계약).
 */
export const getCrawlerPermission = async (
  client: DatabaseClient,
  crawlerID: string,
  userUUID: string,
): Promise<CrawlerPermissionRow | undefined> => {
  const { data, error } = await client
    .from('crawler_permissions')
    .select('*')
    .eq('crawler_id', crawlerID)
    .eq('user_uuid', userUUID)
    .maybeSingle();

  if (error !== null) {
    throw new DatabaseOperationError('get', 'crawler permission', error);
  }
  return data ?? undefined;
};
