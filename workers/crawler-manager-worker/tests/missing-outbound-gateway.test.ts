import { describe, it, expect, vi } from 'vitest';

// The worker as deployed without its CrawlerOutboundGateway entrypoint: every other export stays
vi.mock('cloudflare:workers', async (importOriginal) => ({ ...(await importOriginal<typeof import('cloudflare:workers')>()), exports: {} }));

import { exports } from 'cloudflare:workers';
import { runLoadedCrawler } from '../sources/crawler-runtime/run-crawler.ts';
import { type CrawlerLoader, crawlerRow, createTestDependencies, testEnvironment, uniqueUUID } from './runtime-harness.ts';

describe('a run without the outbound gateway', () => {
  it('fails without loading the code, and logs the missing gateway as an error', async () => {
    expect(exports).not.toHaveProperty('CrawlerOutboundGateway');
    const loader = { get: vi.fn<CrawlerLoader['get']>((id, getCode) => testEnvironment.LOADER.get(id, getCode)) };
    const dependencies = createTestDependencies({ loader });
    const crawler = crawlerRow({ code: '(input) => "ran"' });

    const outcome = await runLoadedCrawler(dependencies, crawler, {}, { userUUID: uniqueUUID() });

    expect(outcome).toMatchObject({
      status: 'failed',
      type: 'data',
      error_code: 'execution_failed',
      error_description: 'The outbound gateway for crawler code is missing, so the code does not run',
      logs: [],
    });
    expect(loader.get).not.toHaveBeenCalled();
    expect(dependencies.logger.error).toHaveBeenCalledWith('The outbound gateway for crawler code is missing, so the code does not run', undefined, {
      function: 'runCrawler',
      metadata: { crawlerID: crawler.id },
    });
  });
});
