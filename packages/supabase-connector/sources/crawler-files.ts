import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  CrawlerFileRow,
  CrawlerFileDeletionRow,
  CrawlerFilesInsert,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

/**
 * Records a file a crawler saved, before its object is written to R2.
 */
export async function createCrawlerFile(
  client: SupabaseClientType,
  input: CrawlerFilesInsert,
): Promise<CrawlerFileRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'crawler_files' },
    async (span) => {
      span.setAttribute('db.insert.user_uuid', input.user_uuid);
      if (input.run_id !== undefined && input.run_id !== null) {
        span.setAttribute('db.insert.run_id', input.run_id);
      }

      const { data, error } = await client
        .from('crawler_files')
        .insert(input)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create crawler file: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      span.setAttribute('db.created_id', (data as CrawlerFileRow).id);
      return data as CrawlerFileRow;
    },
  );
}

/**
 * Gets a file of the user, if it exists and has not expired.
 * A file of a scheduled run has no expiry and lives until its run is deleted.
 */
export async function getCrawlerFileForUser(
  client: SupabaseClientType,
  id: string,
  userUUID: string,
): Promise<CrawlerFileRow | undefined> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'crawler_files' },
    async (span) => {
      span.setAttribute('db.query.id', id);
      span.setAttribute('db.query.user_uuid', userUUID);

      const now = new Date().toISOString();
      const { data, error } = await client
        .from('crawler_files')
        .select('*')
        .eq('id', id)
        .eq('user_uuid', userUUID)
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .maybeSingle();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get crawler file: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', data === null ? 0 : 1);
      return (data as CrawlerFileRow | null) ?? undefined;
    },
  );
}

/**
 * Whether the file row still exists, whatever its owner or expiry.
 */
export async function crawlerFileExists(
  client: SupabaseClientType,
  id: string,
): Promise<boolean> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'crawler_files' },
    async (span) => {
      span.setAttribute('db.query.id', id);

      const { data, error } = await client
        .from('crawler_files')
        .select('id')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to check crawler file: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', data === null ? 0 : 1);
      return data !== null;
    },
  );
}

/**
 * Deletes a file row. The trigger queues its object key for deletion from R2.
 *
 * @returns whether a row was deleted
 */
export async function deleteCrawlerFile(
  client: SupabaseClientType,
  id: string,
): Promise<boolean> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'delete', table: 'crawler_files' },
    async (span) => {
      span.setAttribute('db.query.id', id);

      const { data, error } = await client
        .from('crawler_files')
        .delete()
        .eq('id', id)
        .select('id');

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to delete crawler file: ${error.message}`);
      }

      const rowsAffected = data?.length ?? 0;
      span.setAttribute('db.rows_affected', rowsAffected);
      return rowsAffected > 0;
    },
  );
}

/**
 * Deletes up to limit expired direct run file rows, the oldest expiry first.
 * The trigger queues their object keys for deletion from R2.
 *
 * @returns the number of rows deleted
 */
export async function deleteExpiredCrawlerFiles(
  client: SupabaseClientType,
  limit: number,
): Promise<number> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'rpc', table: 'crawler_files' },
    async (span) => {
      span.setAttribute('db.rpc.function', 'delete_expired_crawler_files');
      span.setAttribute('db.rpc.batch_limit', limit);

      const { data, error } = await client.rpc('delete_expired_crawler_files', {
        batch_limit: limit,
      });

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to delete expired crawler files: ${error.message}`);
      }

      const deletedCount = Number(data ?? 0);
      span.setAttribute('db.rows_affected', deletedCount);
      return deletedCount;
    },
  );
}

/**
 * Lists up to limit object keys waiting for deletion from R2, the oldest first.
 */
export async function listCrawlerFileDeletions(
  client: SupabaseClientType,
  limit: number,
): Promise<CrawlerFileDeletionRow[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'crawler_file_deletions' },
    async (span) => {
      span.setAttribute('db.query.limit', limit);

      const { data, error } = await client
        .from('crawler_file_deletions')
        .select('*')
        .order('queued_at', { ascending: true })
        .limit(limit);

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to list crawler file deletions: ${error.message}`);
      }

      const deletions = (data ?? []) as CrawlerFileDeletionRow[];
      span.setAttribute('db.rows_affected', deletions.length);
      return deletions;
    },
  );
}

/**
 * Removes object keys already deleted from R2 from the queue.
 *
 * @returns the number of queue rows removed
 */
export async function deleteCrawlerFileDeletions(
  client: SupabaseClientType,
  objectKeys: string[],
): Promise<number> {
  if (objectKeys.length === 0) {
    return 0;
  }

  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'rpc', table: 'crawler_file_deletions' },
    async (span) => {
      span.setAttribute('db.rpc.function', 'delete_crawler_file_deletions');
      span.setAttribute('db.rpc.key_count', objectKeys.length);

      const { data, error } = await client.rpc('delete_crawler_file_deletions', {
        object_keys: objectKeys,
      });

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to delete crawler file deletions: ${error.message}`);
      }

      const deletedCount = Number(data ?? 0);
      span.setAttribute('db.rows_affected', deletedCount);
      return deletedCount;
    },
  );
}
