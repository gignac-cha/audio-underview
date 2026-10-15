import { describe, it, expect } from 'vitest';
import { cleanUpCrawlerFiles } from '../sources/file-cleanup.ts';
import { useInMemorySupabase, type Row } from './in-memory-supabase.ts';
import { SUPABASE_ORIGIN, createMockLogger, createTestDependencies, runScheduledHandler, testEnvironment, uniqueUUID } from './runtime-harness.ts';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);
const bucket = testEnvironment.CRAWLER_FILES;

async function storeFile(expiresAt: string | null): Promise<Row> {
  const user = uniqueUUID();
  const id = uniqueUUID();
  const row = {
    id,
    user_uuid: user,
    run_id: expiresAt === null ? uniqueUUID() : null,
    crawler_id: null,
    object_key: `${user}/${id}`,
    name: null,
    content_type: 'text/plain',
    size: 4,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };
  await bucket.put(row.object_key, 'data');
  supabase.tables.crawler_files ??= [];
  supabase.tables.crawler_files.push(row);
  return row;
}

async function queueDeletion(objectKey: string): Promise<void> {
  await bucket.put(objectKey, 'orphan');
  supabase.tables.crawler_file_deletions ??= [];
  supabase.tables.crawler_file_deletions.push({ object_key: objectKey, queued_at: new Date().toISOString() });
}

function dependencies(overrides: { bucket?: R2Bucket } = {}) {
  return { supabaseClient: createTestDependencies().supabaseClient, bucket: overrides.bucket ?? bucket, logger: createMockLogger() };
}

describe('cleanUpCrawlerFiles', () => {
  it('deletes the expired file rows, then their objects and the queued ones, and empties the queue', async () => {
    const expired = await storeFile(new Date(Date.now() - 60_000).toISOString());
    const current = await storeFile(new Date(Date.now() + 60_000).toISOString());
    const scheduled = await storeFile(null);
    const orphanKey = `${uniqueUUID()}/${uniqueUUID()}`;
    await queueDeletion(orphanKey);

    const result = await cleanUpCrawlerFiles(dependencies());

    expect(result).toEqual({ expiredRowsDeleted: 1, objectsDeleted: 2 });
    expect((supabase.tables.crawler_files ?? []).map((row) => row.id).sort()).toEqual([current.id, scheduled.id].sort());
    expect(await bucket.head(String(expired.object_key))).toBeNull();
    expect(await bucket.head(orphanKey)).toBeNull();
    expect(await bucket.head(String(current.object_key))).not.toBeNull();
    expect(supabase.tables.crawler_file_deletions).toEqual([]);
    expect(supabase.requestsOf('POST', 'rpc/delete_expired_crawler_files')[0].body).toEqual({ batch_limit: 500 });
    expect(supabase.requestsOf('GET', 'crawler_file_deletions')[0].query.get('limit')).toBe('500');
  });

  it('does nothing more when nothing is expired or queued', async () => {
    await storeFile(new Date(Date.now() + 60_000).toISOString());

    await expect(cleanUpCrawlerFiles(dependencies())).resolves.toEqual({ expiredRowsDeleted: 0, objectsDeleted: 0 });
    expect(supabase.requestsOf('POST', 'rpc/delete_crawler_file_deletions')).toEqual([]);
  });

  it('keeps the queue when R2 fails, for the next run', async () => {
    const orphanKey = `${uniqueUUID()}/${uniqueUUID()}`;
    await queueDeletion(orphanKey);
    const failingBucket = { delete: () => Promise.reject(new Error('R2 is down')) } as unknown as R2Bucket;

    await expect(cleanUpCrawlerFiles(dependencies({ bucket: failingBucket }))).rejects.toThrow('Crawler file cleanup failed: objects');

    expect(supabase.tables.crawler_file_deletions).toEqual([expect.objectContaining({ object_key: orphanKey })]);
    expect(supabase.requestsOf('POST', 'rpc/delete_crawler_file_deletions')).toEqual([]);
  });

  it('goes on with the next steps when one fails, and throws at the end', async () => {
    const orphanKey = `${uniqueUUID()}/${uniqueUUID()}`;
    await queueDeletion(orphanKey);
    supabase.intercept = (request) => (request.table === 'rpc/delete_expired_crawler_files'
      ? { statusCode: 500, data: { code: 'XX000', message: 'database is down' } }
      : undefined);
    const logger = createMockLogger();

    await expect(cleanUpCrawlerFiles({ ...dependencies(), logger })).rejects.toThrow('Crawler file cleanup failed: expired files');

    expect(await bucket.head(orphanKey)).toBeNull();
    expect(supabase.tables.crawler_file_deletions).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith('Expired crawler files could not be deleted', expect.any(Error), { function: 'cleanUpCrawlerFiles' });
  });

  it('reports a queue that could not be emptied after R2 deleted the objects', async () => {
    const orphanKey = `${uniqueUUID()}/${uniqueUUID()}`;
    await queueDeletion(orphanKey);
    supabase.intercept = (request) => (request.table === 'rpc/delete_crawler_file_deletions'
      ? { statusCode: 500, data: { code: 'XX000', message: 'database is down' } }
      : undefined);

    await expect(cleanUpCrawlerFiles(dependencies())).rejects.toThrow('Crawler file cleanup failed: queue');
    expect(await bucket.head(orphanKey)).toBeNull();
  });

  it('runs from the cron trigger of the worker', async () => {
    const expired = await storeFile(new Date(Date.now() - 60_000).toISOString());

    await runScheduledHandler({ cron: '*/15 * * * *', scheduledTime: new Date() });

    expect(supabase.tables.crawler_files).toEqual([]);
    expect(await bucket.head(String(expired.object_key))).toBeNull();
  });
});
