import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  CrawlerRunRow,
  CrawlerRunsInsert,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

/**
 * Records a direct run of a crawler once it ended.
 */
export async function createCrawlerRun(
  client: SupabaseClientType,
  input: CrawlerRunsInsert,
): Promise<CrawlerRunRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'crawler_runs' },
    async (span) => {
      span.setAttribute('db.insert.user_uuid', input.user_uuid);
      span.setAttribute('db.insert.crawler_id', input.crawler_id);
      span.setAttribute('db.insert.status', input.status);

      const { data, error } = await client
        .from('crawler_runs')
        .insert(input)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create crawler run: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      span.setAttribute('db.created_id', (data as CrawlerRunRow).id);
      return data as CrawlerRunRow;
    },
  );
}

/**
 * Gets a direct run of the crawler that the user started, if it exists.
 */
export async function getCrawlerRunForUser(
  client: SupabaseClientType,
  id: string,
  crawlerID: string,
  userUUID: string,
): Promise<CrawlerRunRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'crawler_runs' },
    async (span) => {
      span.setAttribute('db.query.id', id);
      span.setAttribute('db.query.crawler_id', crawlerID);
      span.setAttribute('db.query.user_uuid', userUUID);

      const { data, error } = await client
        .from('crawler_runs')
        .select('*')
        .eq('id', id)
        .eq('crawler_id', crawlerID)
        .eq('user_uuid', userUUID)
        .maybeSingle();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get crawler run: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', data === null ? 0 : 1);
      return (data as CrawlerRunRow | null) ?? undefined;
    },
  );
}
