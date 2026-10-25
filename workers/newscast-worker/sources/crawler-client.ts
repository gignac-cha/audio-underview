/**
 * Reads the source material of an article through the system crawlers of crawler-manager-worker
 * (`executeCrawlerByName`). Every function here is failure-tolerant: a crawler that throws or
 * answers something unexpected degrades to '' so a single bad source never fails the crawl step.
 */

import { createWorkerLogger } from '@audio-underview/logger';
import type { Environment } from './environment.ts';

const logger = createWorkerLogger({
  defaultContext: { module: 'newscast-worker-crawler-client' },
});

/**
 * Run a text-returning crawler (article-content / geeknews-summary) through the crawler manager.
 * Failure-tolerant: any error (manager down, code-runner error, non-string result) degrades to ''.
 */
export async function crawlTextViaManager(
  environment: Environment,
  crawlerName: string,
  url: string,
  onDegradation?: (reason: string) => void,
): Promise<string> {
  if (!url) {
    return '';
  }
  try {
    const response = await environment.CRAWLER_MANAGER.executeCrawlerByName(crawlerName, { url });
    return typeof response.result === 'string' ? response.result : '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Crawler via manager failed', {
      crawler: crawlerName,
      url,
      error: message,
    }, { function: 'crawlTextViaManager' });
    // Report the swallowed reason so the caller can persist it as telemetry —
    // otherwise "this source is empty" is undiagnosable after the fact.
    onDegradation?.(message);
    return '';
  }
}

/**
 * Find the article's Hacker News discussion and return its top comments, via the
 * hn-search → hn-items crawlers (two chained URL fetches, since a sandbox crawler
 * can't fetch on its own). Failure-tolerant → '' (no HN match or any error).
 */
export async function crawlHackerNewsViaManager(
  environment: Environment,
  originalUrl: string,
  onDegradation?: (reason: string) => void,
): Promise<string> {
  if (!originalUrl) {
    return '';
  }
  try {
    const searchUrl =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(originalUrl)}` +
      '&restrictSearchableAttributes=url&tags=story';
    const search = await environment.CRAWLER_MANAGER.executeCrawlerByName('hn-search', { url: searchUrl });
    const found = search.result as { objectID?: string; itemsUrl?: string } | null;
    if (!found || typeof found.itemsUrl !== 'string' || found.itemsUrl.length === 0) {
      return '';
    }
    const items = await environment.CRAWLER_MANAGER.executeCrawlerByName('hn-items', { url: found.itemsUrl });
    return typeof items.result === 'string' ? items.result : '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Hacker News via manager failed', {
      originalUrl,
      error: message,
    }, { function: 'crawlHackerNewsViaManager' });
    onDegradation?.(message);
    return '';
  }
}
