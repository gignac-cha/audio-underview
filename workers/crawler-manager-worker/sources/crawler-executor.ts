import type { Logger } from '@audio-underview/logger';
import type { CrawlerRow } from '@audio-underview/supabase-connector';
import type { CrawlerExecuteResult } from '@audio-underview/worker-tools';
import type { CodeRunnerClient } from './code-runner-client.ts';
import { isSafeURLPattern } from './safe-url-pattern.ts';

export type { CrawlerExecuteResult };

function resolveURL(
  input: unknown,
  crawler: CrawlerRow,
): string | null {
  // 1. input.url if present
  if (input !== null && input !== undefined && typeof input === 'object' && 'url' in input) {
    const url = (input as Record<string, unknown>).url;
    if (typeof url === 'string' && url.length > 0) {
      return url;
    }
  }

  // 2. input_schema url default
  const inputSchema = crawler.input_schema;
  if (inputSchema.url !== null && inputSchema.url !== undefined && typeof inputSchema.url === 'object' && 'default' in inputSchema.url) {
    const defaultURL = (inputSchema.url as Record<string, unknown>).default;
    if (typeof defaultURL === 'string' && defaultURL.length > 0) {
      return defaultURL;
    }
  }

  return null;
}

export async function executeCrawler(
  codeRunnerClient: CodeRunnerClient,
  crawler: CrawlerRow,
  input: unknown,
  logger: Logger,
): Promise<CrawlerExecuteResult> {
  if (crawler.type === 'web') {
    const url = resolveURL(input, crawler);
    if (!url) {
      throw new Error(
        `Crawler ${crawler.id}: no URL available. Provide url in input or set a default in input_schema.`,
      );
    }

    if (crawler.url_pattern) {
      if (!isSafeURLPattern(crawler.url_pattern)) {
        logger.warn('Skipping url_pattern validation: potential ReDoS pattern detected', {
          urlPattern: crawler.url_pattern,
          crawlerID: crawler.id,
        }, { function: 'executeCrawler' });
      } else {
        try {
          const pattern = new RegExp(crawler.url_pattern);
          if (!pattern.test(url)) {
            logger.warn('URL does not match crawler url_pattern', {
              url,
              urlPattern: crawler.url_pattern,
              crawlerID: crawler.id,
            }, { function: 'executeCrawler' });
          }
        } catch (error: unknown) {
          logger.warn('Invalid url_pattern regex', {
            urlPattern: crawler.url_pattern,
            crawlerID: crawler.id,
            error: error instanceof Error ? error.message : String(error),
          }, { function: 'executeCrawler' });
        }
      }
    }

    const response = await codeRunnerClient.run('web', url, undefined, crawler.code);
    return { type: 'web', result: response.result };
  }

  const response = await codeRunnerClient.run('data', undefined, input, crawler.code);
  return { type: 'data', result: response.result };
}
