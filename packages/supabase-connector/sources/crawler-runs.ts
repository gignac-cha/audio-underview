import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  CrawlerRunRow,
  CrawlerRunSummary,
  CrawlerRunsInsert,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

export interface PaginatedCrawlerRuns {
  data: CrawlerRunSummary[];
  total: number;
}

export interface ListCrawlerRunsOptions {
  /** The runs of this crawler; null for the test runs of code without a crawler */
  crawlerID: string | null;
  offset?: number;
  limit?: number;
}

// The result, the logs and the code stay out of a list
const CRAWLER_RUN_SUMMARY_COLUMNS = [
  'id',
  'crawler_id',
  'kind',
  'type',
  'status',
  'error_code',
  'logs_truncated',
  'started_at',
  'completed_at',
  'created_at',
].join(',');

/**
 * Records a direct run or a test run once it ended.
 */
export async function createCrawlerRun(
  client: SupabaseClientType,
  input: CrawlerRunsInsert,
): Promise<CrawlerRunRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'crawler_runs' },
    async (span) => {
      span.setAttribute('db.insert.user_uuid', input.user_uuid);
      if (input.crawler_id !== null) {
        span.setAttribute('db.insert.crawler_id', input.crawler_id);
      }
      span.setAttribute('db.insert.kind', input.kind ?? 'direct');
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
 * Lists the runs the user started, of one crawler or of code without a crawler, newest first,
 * without their result, logs and code.
 *
 * @param options - the crawler (null for code without a crawler) and pagination
 * (offset defaults to 0, limit defaults to 20 and is at most 100)
 */
export async function listCrawlerRunsForUser(
  client: SupabaseClientType,
  userUUID: string,
  options: ListCrawlerRunsOptions,
): Promise<PaginatedCrawlerRuns> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'crawler_runs' },
    async (span) => {
      const offset = Math.max(0, options.offset ?? 0);
      const limit = Math.min(100, Math.max(1, options.limit ?? 20));

      span.setAttribute('db.query.user_uuid', userUUID);
      if (options.crawlerID !== null) {
        span.setAttribute('db.query.crawler_id', options.crawlerID);
      }
      span.setAttribute('db.query.offset', offset);
      span.setAttribute('db.query.limit', limit);

      const query = client
        .from('crawler_runs')
        .select(CRAWLER_RUN_SUMMARY_COLUMNS, { count: 'exact' })
        .eq('user_uuid', userUUID);
      const { data, error, count } = await (options.crawlerID === null
        ? query.is('crawler_id', null)
        : query.eq('crawler_id', options.crawlerID))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list crawler runs: ${error.message}`);
      }

      const runs = (data ?? []) as unknown as CrawlerRunSummary[];
      span.setAttribute('db.rows_affected', runs.length);
      span.setAttribute('db.total_count', count ?? 0);
      return { data: runs, total: count ?? 0 };
    },
  );
}

/**
 * Gets a run the user started, if it exists: of the crawler, or of code without a crawler when
 * crawlerID is null.
 */
export async function getCrawlerRunForUser(
  client: SupabaseClientType,
  id: string,
  crawlerID: string | null,
  userUUID: string,
): Promise<CrawlerRunRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'crawler_runs' },
    async (span) => {
      span.setAttribute('db.query.id', id);
      if (crawlerID !== null) {
        span.setAttribute('db.query.crawler_id', crawlerID);
      }
      span.setAttribute('db.query.user_uuid', userUUID);

      const query = client
        .from('crawler_runs')
        .select('*')
        .eq('id', id);
      const { data, error } = await (crawlerID === null
        ? query.is('crawler_id', null)
        : query.eq('crawler_id', crawlerID))
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
