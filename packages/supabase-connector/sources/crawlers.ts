import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  CrawlerRow,
  CrawlersInsert,
  CrawlersUpdate,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

/**
 * Creates a new crawler.
 *
 * @param client - Supabase client
 * @param input - Crawler data to insert
 * @returns Created crawler row
 */
export async function createCrawler(
  client: SupabaseClientType,
  input: CrawlersInsert
): Promise<CrawlerRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'crawlers' },
    async (span) => {
      span.setAttribute('db.insert.user_uuid', input.user_uuid);
      span.setAttribute('db.insert.name', input.name);

      const { data, error } = await client
        .from('crawlers')
        .insert(input as never)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create crawler: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      span.setAttribute('db.created_id', (data as CrawlerRow).id);
      return data as CrawlerRow;
    }
  );
}

/**
 * Lists all crawlers belonging to a user.
 *
 * @param client - Supabase client
 * @param userUUID - User UUID
 * @returns Array of crawler rows ordered by creation date descending
 */
export async function listCrawlersByUser(
  client: SupabaseClientType,
  userUUID: string
): Promise<CrawlerRow[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'crawlers' },
    async (span) => {
      span.setAttribute('db.query.user_uuid', userUUID);

      const { data, error } = await client
        .from('crawlers')
        .select('*')
        .eq('user_uuid', userUUID)
        .order('created_at', { ascending: false });

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list crawlers: ${error.message}`);
      }

      const crawlers = (data ?? []) as CrawlerRow[];
      span.setAttribute('db.rows_affected', crawlers.length);
      return crawlers;
    }
  );
}

/**
 * Gets a single crawler by ID, verifying ownership.
 *
 * @param client - Supabase client
 * @param id - Crawler ID
 * @param userUUID - User UUID (must own the crawler)
 * @returns Crawler row if found and owned by the user, null otherwise
 */
export async function getCrawler(
  client: SupabaseClientType,
  id: string,
  userUUID: string
): Promise<CrawlerRow | null> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'crawlers' },
    async (span) => {
      span.setAttribute('db.query.id', id);
      span.setAttribute('db.query.user_uuid', userUUID);

      const { data, error } = await client
        .from('crawlers')
        .select('*')
        .eq('id', id)
        .eq('user_uuid', userUUID)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return null;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get crawler: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as CrawlerRow;
    }
  );
}

/**
 * Updates a crawler by ID, verifying ownership.
 *
 * @param client - Supabase client
 * @param id - Crawler ID
 * @param userUUID - User UUID (must own the crawler)
 * @param input - Fields to update
 * @returns Updated crawler row, or null if not found or not owned
 */
export async function updateCrawler(
  client: SupabaseClientType,
  id: string,
  userUUID: string,
  input: CrawlersUpdate
): Promise<CrawlerRow | null> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'update', table: 'crawlers' },
    async (span) => {
      span.setAttribute('db.update.id', id);
      span.setAttribute('db.update.user_uuid', userUUID);

      const { data, error } = await client
        .from('crawlers')
        .update(input as never)
        .eq('id', id)
        .eq('user_uuid', userUUID)
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return null;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to update crawler: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as CrawlerRow;
    }
  );
}

/**
 * Deletes a crawler by ID, verifying ownership.
 *
 * @param client - Supabase client
 * @param id - Crawler ID
 * @param userUUID - User UUID (must own the crawler)
 * @returns True if deleted successfully
 */
export async function deleteCrawler(
  client: SupabaseClientType,
  id: string,
  userUUID: string
): Promise<boolean> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'delete', table: 'crawlers' },
    async (span) => {
      span.setAttribute('db.delete.id', id);
      span.setAttribute('db.delete.user_uuid', userUUID);

      const { data, error } = await client
        .from('crawlers')
        .delete()
        .eq('id', id)
        .eq('user_uuid', userUUID)
        .select();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to delete crawler: ${error.message}`);
      }

      const rowsAffected = data?.length ?? 0;
      span.setAttribute('db.rows_affected', rowsAffected);
      return rowsAffected > 0;
    }
  );
}
