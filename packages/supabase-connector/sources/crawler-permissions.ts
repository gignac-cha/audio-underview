import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  CrawlerPermissionRow,
  CrawlerPermissionLevel,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

export async function createCrawlerPermission(
  client: SupabaseClientType,
  parameters: {
    crawler_id: string;
    user_uuid: string;
    level: CrawlerPermissionLevel;
  },
): Promise<CrawlerPermissionRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'crawler_permissions' },
    async (span) => {
      span.setAttribute('db.insert.crawler_id', parameters.crawler_id);
      span.setAttribute('db.insert.user_uuid', parameters.user_uuid);
      span.setAttribute('db.insert.level', parameters.level);

      const { data, error } = await client
        .from('crawler_permissions')
        .insert(parameters)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create crawler permission: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as CrawlerPermissionRow;
    },
  );
}

export async function getCrawlerPermission(
  client: SupabaseClientType,
  crawlerID: string,
  userUUID: string,
): Promise<CrawlerPermissionRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'crawler_permissions' },
    async (span) => {
      span.setAttribute('db.query.crawler_id', crawlerID);
      span.setAttribute('db.query.user_uuid', userUUID);

      const { data, error } = await client
        .from('crawler_permissions')
        .select()
        .eq('crawler_id', crawlerID)
        .eq('user_uuid', userUUID)
        .maybeSingle();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get crawler permission: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', data === null ? 0 : 1);
      return (data as CrawlerPermissionRow | null) ?? undefined;
    },
  );
}

export async function deleteCrawlerPermission(
  client: SupabaseClientType,
  crawlerID: string,
  userUUID: string,
): Promise<void> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'delete', table: 'crawler_permissions' },
    async (span) => {
      span.setAttribute('db.query.crawler_id', crawlerID);
      span.setAttribute('db.query.user_uuid', userUUID);

      const { error } = await client
        .from('crawler_permissions')
        .delete()
        .eq('crawler_id', crawlerID)
        .eq('user_uuid', userUUID);

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to delete crawler permission: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
    },
  );
}
