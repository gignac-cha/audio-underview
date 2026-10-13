import type { Logger } from '@audio-underview/logger';
import {
  type SupabaseClient,
  deleteExpiredCrawlerFiles,
  listCrawlerFileDeletions,
  deleteCrawlerFileDeletions,
} from '@audio-underview/supabase-connector';

/**
 * The cron that removes crawler files: the rows of expired direct run files go first, and the
 * trigger queues their object keys like those of every other deleted file row; then the queued
 * objects go from R2. A key leaves the queue only after R2 deleted its object.
 */

export const FILE_CLEANUP_BATCH_SIZE = 500;

export interface FileCleanupDependencies {
  supabaseClient: SupabaseClient;
  bucket: R2Bucket;
  logger: Logger;
}

export interface FileCleanupResult {
  expiredRowsDeleted: number;
  objectsDeleted: number;
}

/**
 * Runs every step even when one fails.
 *
 * @throws after all the steps when one of them failed
 */
export async function cleanUpCrawlerFiles(dependencies: FileCleanupDependencies): Promise<FileCleanupResult> {
  const { supabaseClient, bucket, logger } = dependencies;
  const failures: string[] = [];
  const result: FileCleanupResult = { expiredRowsDeleted: 0, objectsDeleted: 0 };

  try {
    result.expiredRowsDeleted = await deleteExpiredCrawlerFiles(supabaseClient, FILE_CLEANUP_BATCH_SIZE);
  } catch (error) {
    logger.error('Expired crawler files could not be deleted', error, { function: 'cleanUpCrawlerFiles' });
    failures.push('expired files');
  }

  let deletedKeys: string[] = [];
  try {
    const deletions = await listCrawlerFileDeletions(supabaseClient, FILE_CLEANUP_BATCH_SIZE);
    const keys = deletions.map((deletion) => deletion.object_key);
    if (keys.length > 0) {
      await bucket.delete(keys);
    }
    deletedKeys = keys;
  } catch (error) {
    // The keys stay queued for the next run
    logger.error('Crawler file objects could not be deleted', error, { function: 'cleanUpCrawlerFiles' });
    failures.push('objects');
  }

  try {
    await deleteCrawlerFileDeletions(supabaseClient, deletedKeys);
    result.objectsDeleted = deletedKeys.length;
  } catch (error) {
    logger.error('Crawler file deletions could not be removed from the queue', error, { function: 'cleanUpCrawlerFiles' });
    failures.push('queue');
  }

  if (failures.length > 0) {
    throw new Error(`Crawler file cleanup failed: ${failures.join(', ')}`);
  }
  return result;
}
