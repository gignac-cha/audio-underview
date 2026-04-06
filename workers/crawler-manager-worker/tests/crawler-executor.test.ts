import { describe, it, expect, vi } from 'vitest';
import { executeCrawler } from '../sources/crawler-executor.ts';
import { validateCodeRunnerResult } from '../sources/code-runner-client.ts';
import type { CodeRunnerClient } from '../sources/code-runner-client.ts';
import type { CrawlerRow } from '@audio-underview/supabase-connector';

function createMockCodeRunnerClient(
  result: unknown = { extracted: 'data' },
): CodeRunnerClient & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn().mockResolvedValue({ type: 'web', mode: 'run', result }),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    createChild: vi.fn().mockReturnThis(),
  } as any;
}

function createMockCrawler(overrides: Partial<CrawlerRow> = {}): CrawlerRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    user_uuid: '00000000-0000-0000-0000-000000000002',
    name: 'Test Crawler',
    type: 'web',
    url_pattern: '.*\\.example\\.com',
    code: '(text) => ({ title: "test" })',
    input_schema: { body: 'string' },
    output_schema: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('executeCrawler', () => {
  describe('web crawler', () => {
    it('resolves URL from input.url and calls codeRunnerClient.run', async () => {
      const client = createMockCodeRunnerClient({ title: 'Hello' });
      const logger = createMockLogger();
      const crawler = createMockCrawler({ code: '(text) => ({ title: text })' });
      const input = { url: 'https://www.example.com/page' };

      const result = await executeCrawler(client, crawler, input, logger);

      expect(result).toEqual({ type: 'web', result: { title: 'Hello' } });
      expect(client.run).toHaveBeenCalledOnce();
      expect(client.run).toHaveBeenCalledWith(
        'web',
        'https://www.example.com/page',
        undefined,
        crawler.code,
      );
    });

    it('resolves URL from input_schema.url.default when input has no url', async () => {
      const client = createMockCodeRunnerClient();
      const logger = createMockLogger();
      const crawler = createMockCrawler({
        input_schema: {
          url: { default: 'https://fallback.example.com/default' },
        },
      });
      const input = {};

      await executeCrawler(client, crawler, input, logger);

      expect(client.run).toHaveBeenCalledWith(
        'web',
        'https://fallback.example.com/default',
        undefined,
        crawler.code,
      );
    });

    it('throws when no URL is available', async () => {
      const client = createMockCodeRunnerClient();
      const logger = createMockLogger();
      const crawler = createMockCrawler({ input_schema: {} });
      const input = {};

      await expect(executeCrawler(client, crawler, input, logger)).rejects.toThrow(
        /no URL available/,
      );
      expect(client.run).not.toHaveBeenCalled();
    });

    it('warns when URL does not match url_pattern but still executes', async () => {
      const client = createMockCodeRunnerClient();
      const logger = createMockLogger();
      const crawler = createMockCrawler({ url_pattern: '^https://only\\.allowed\\.com' });
      const input = { url: 'https://different.com/page' };

      const result = await executeCrawler(client, crawler, input, logger);

      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        'URL does not match crawler url_pattern',
        expect.objectContaining({
          url: 'https://different.com/page',
          urlPattern: '^https://only\\.allowed\\.com',
          crawlerID: crawler.id,
        }),
        { function: 'executeCrawler' },
      );
      expect(result.type).toBe('web');
      expect(client.run).toHaveBeenCalledOnce();
    });

    it('skips url_pattern validation on unsafe regex and logs warning', async () => {
      const client = createMockCodeRunnerClient();
      const logger = createMockLogger();
      const crawler = createMockCrawler({ url_pattern: '[invalid(' });
      const input = { url: 'https://www.example.com/page' };

      const result = await executeCrawler(client, crawler, input, logger);

      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping url_pattern validation: potential ReDoS pattern detected',
        expect.objectContaining({
          urlPattern: '[invalid(',
          crawlerID: crawler.id,
        }),
        expect.objectContaining({ function: 'executeCrawler' }),
      );
      expect(result.type).toBe('web');
      expect(client.run).toHaveBeenCalledOnce();
    });
  });

  describe('data crawler', () => {
    it('calls codeRunnerClient.run with data type and input', async () => {
      const client = createMockCodeRunnerClient({ processed: true });
      client.run.mockResolvedValue({ type: 'data', mode: 'run', result: { processed: true } });
      const logger = createMockLogger();
      const crawler = createMockCrawler({ type: 'data', url_pattern: null });
      const input = { items: [1, 2, 3] };

      const result = await executeCrawler(client, crawler, input, logger);

      expect(result).toEqual({ type: 'data', result: { processed: true } });
      expect(client.run).toHaveBeenCalledOnce();
      expect(client.run).toHaveBeenCalledWith(
        'data',
        undefined,
        input,
        crawler.code,
      );
    });
  });

  describe('error propagation', () => {
    it('propagates errors from codeRunnerClient.run', async () => {
      const client = createMockCodeRunnerClient();
      client.run.mockRejectedValue(new Error('Code execution failed'));
      const logger = createMockLogger();
      const crawler = createMockCrawler();
      const input = { url: 'https://www.example.com/page' };

      await expect(executeCrawler(client, crawler, input, logger)).rejects.toThrow(
        'Code execution failed',
      );
    });
  });
});

describe('validateCodeRunnerResult', () => {
  it('accepts valid web result', () => {
    const result = validateCodeRunnerResult({ type: 'web', mode: 'run', result: { data: 'ok' } });
    expect(result.type).toBe('web');
    expect(result.mode).toBe('run');
    expect(result.result).toEqual({ data: 'ok' });
  });

  it('accepts valid result with null', () => {
    const result = validateCodeRunnerResult({ type: 'data', mode: 'test', result: null });
    expect(result.type).toBe('data');
    expect(result.result).toBeNull();
  });

  it('throws on null input', () => {
    expect(() => validateCodeRunnerResult(null)).toThrow('Expected object from code-runner');
  });

  it('throws on non-object input', () => {
    expect(() => validateCodeRunnerResult('string')).toThrow('Expected object from code-runner');
  });

  it('throws on invalid type', () => {
    expect(() => validateCodeRunnerResult({ type: 'unknown', mode: 'run', result: {} })).toThrow("Expected type 'web' or 'data'");
  });

  it('throws on invalid mode', () => {
    expect(() => validateCodeRunnerResult({ type: 'web', mode: 'unknown', result: {} })).toThrow("Expected mode 'test' or 'run'");
  });

  it('throws on missing result field', () => {
    expect(() => validateCodeRunnerResult({ type: 'web', mode: 'run' })).toThrow('Missing result field');
  });
});
