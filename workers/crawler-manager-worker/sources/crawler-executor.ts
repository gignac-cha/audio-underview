import type { Logger } from '@audio-underview/logger';
import type { CrawlerExecuteResult } from '@audio-underview/schemas';
import { isSafeURLPattern } from './safe-url-patterns.ts';
import type { CrawlerManagerServices } from './services.ts';

/**
 * crawler 실행 (Service Binding RPC 전용 — 스펙 §3.4).
 * 소유권 검사 없음: binding 선언 자체가 접근 제어.
 */

const resolveTargetURL = (crawlerID: string, input: unknown, inputSchema: Record<string, unknown>): string => {
  // ① input.url 우선
  if (typeof input === 'object' && input !== null) {
    const inputURL = (input as Record<string, unknown>).url;
    if (typeof inputURL === 'string' && inputURL.length > 0) {
      return inputURL;
    }
  }

  // ② input_schema.url.default fallback
  const urlDescriptor = inputSchema.url;
  if (typeof urlDescriptor === 'object' && urlDescriptor !== null) {
    const defaultURL = (urlDescriptor as Record<string, unknown>).default;
    if (typeof defaultURL === 'string' && defaultURL.length > 0) {
      return defaultURL;
    }
  }

  throw new Error(
    `Crawler ${crawlerID}: no URL available. Provide url in input or set a default in input_schema.`,
  );
};

/** url_pattern은 실행 시 soft check — 불일치/unsafe여도 warn만 하고 실행은 계속 (스펙 §8.5) */
const warnOnPatternMismatch = (
  logger: Logger,
  crawlerID: string,
  pattern: string,
  url: string,
): void => {
  if (!isSafeURLPattern(pattern)) {
    logger.warn('Skipping unsafe url_pattern validation', { crawlerID, pattern });
    return;
  }
  try {
    if (!new RegExp(pattern).test(url)) {
      logger.warn('URL does not match crawler url_pattern — executing anyway', {
        crawlerID,
        pattern,
        url,
      });
    }
  } catch {
    logger.warn('Failed to compile url_pattern', { crawlerID, pattern });
  }
};

export const executeCrawler = async (
  services: CrawlerManagerServices,
  logger: Logger,
  crawlerID: string,
  input: unknown,
): Promise<CrawlerExecuteResult> => {
  const crawler = await services.crawlers.getByID(crawlerID);
  if (crawler === undefined) {
    throw new Error(`Crawler ${crawlerID} not found`);
  }

  const bearerToken = await services.createServiceToken(crawler.user_uuid);

  if (crawler.type === 'web') {
    const url = resolveTargetURL(crawlerID, input, crawler.input_schema);
    if (crawler.url_pattern !== null) {
      warnOnPatternMismatch(logger, crawlerID, crawler.url_pattern, url);
    }
    const response = await services.codeRunner.run(
      { type: 'web', mode: 'run', url, code: crawler.code },
      bearerToken,
    );
    return { type: 'web', result: response.result };
  }

  const response = await services.codeRunner.run(
    { type: 'data', mode: 'run', data: input, code: crawler.code },
    bearerToken,
  );
  return { type: 'data', result: response.result };
};
