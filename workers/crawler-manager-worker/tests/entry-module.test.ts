import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';
import * as entryModule from '../sources/index.ts';
import { CrawlerOutboundGateway } from '../sources/crawler-runtime/outbound-gateway.ts';
import type CrawlerManagerWorker from '../sources/index.ts';
import { uniqueUUID } from './runtime-harness.ts';

describe('the entry module', () => {
  it('exports only classes as named exports, besides the default', () => {
    // The Workers runtime refuses an entry module that exports anything else
    for (const [name, value] of Object.entries(entryModule)) {
      if (name === 'default') continue;
      expect(typeof value, `export ${name}`).toBe('function');
      expect(Function.prototype.toString.call(value), `export ${name}`).toMatch(/^class\b/);
    }
  });

  it('exports the outbound gateway as an entrypoint of this worker', () => {
    expect(entryModule.CrawlerOutboundGateway).toBe(CrawlerOutboundGateway);
    expect((exports as unknown as Record<string, unknown>).CrawlerOutboundGateway).toBeDefined();
  });
});

describe('runCrawler RPC', () => {
  it('throws Invalid user UUID before reading anything for a context without a user UUID', async () => {
    // An RPC promise is callable and expect().rejects calls what it is given, so rejecting calls are wrapped in a function
    const crawlerManager = exports.default as unknown as Service<typeof CrawlerManagerWorker>;

    for (const context of [{ userUUID: 'not-a-uuid' }, {}, null]) {
      await expect(() => crawlerManager.runCrawler(uniqueUUID(), {}, context as never)).rejects.toThrow('Invalid user UUID');
    }
    await expect(() => crawlerManager.runCrawler(uniqueUUID(), {}, { userUUID: uniqueUUID(), runID: 'run-1' })).rejects.toThrow('Invalid run ID');
  });
});
