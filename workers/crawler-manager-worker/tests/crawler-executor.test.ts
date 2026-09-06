import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@audio-underview/logger';
import type { RunCodeRequestBody } from '@audio-underview/schemas';
import { executeCrawler } from '../sources/crawler-executor.ts';
import { CRAWLER_ID, createFakeServices, mockCrawler } from './test-helpers.ts';

const silentLogger = new Logger({ transports: [] });

const createRunRecorder = () => {
  const calls: { request: RunCodeRequestBody; bearerToken: string }[] = [];
  return {
    calls,
    codeRunner: {
      run: (request: RunCodeRequestBody, bearerToken: string) => {
        calls.push({ request, bearerToken });
        return Promise.resolve({ type: request.type, mode: 'run' as const, result: { ok: true } });
      },
    },
  };
};

describe('executeCrawler', () => {
  it('throws when the crawler does not exist', async () => {
    const services = createFakeServices({
      crawlers: { getByID: () => Promise.resolve(undefined) },
    });
    await expect(executeCrawler(services, silentLogger, CRAWLER_ID, {})).rejects.toThrow(
      `Crawler ${CRAWLER_ID} not found`,
    );
  });

  it('prefers input.url over the schema default', async () => {
    const recorder = createRunRecorder();
    const services = createFakeServices({
      crawlers: {
        getByID: () =>
          Promise.resolve({
            ...mockCrawler,
            input_schema: { url: { type: 'string', default: 'https://default.example.com' } },
          }),
      },
      codeRunner: recorder.codeRunner,
    });

    await executeCrawler(services, silentLogger, CRAWLER_ID, {
      url: 'https://input.example.com',
    });
    expect(recorder.calls[0]?.request).toMatchObject({
      type: 'web',
      mode: 'run',
      url: 'https://input.example.com',
    });
  });

  it('falls back to input_schema.url.default', async () => {
    const recorder = createRunRecorder();
    const services = createFakeServices({
      crawlers: {
        getByID: () =>
          Promise.resolve({
            ...mockCrawler,
            input_schema: { url: { type: 'string', default: 'https://default.example.com' } },
          }),
      },
      codeRunner: recorder.codeRunner,
    });

    await executeCrawler(services, silentLogger, CRAWLER_ID, {});
    expect(recorder.calls[0]?.request).toMatchObject({ url: 'https://default.example.com' });
  });

  it('throws when no URL is available for a web crawler', async () => {
    const services = createFakeServices({
      crawlers: { getByID: () => Promise.resolve({ ...mockCrawler, input_schema: {} }) },
    });
    await expect(executeCrawler(services, silentLogger, CRAWLER_ID, {})).rejects.toThrow(
      'no URL available',
    );
  });

  it('continues execution when the URL does not match url_pattern (warn만)', async () => {
    const recorder = createRunRecorder();
    const warnSpy = vi.fn();
    const logger = new Logger({
      transports: [
        {
          write: (record) => {
            if (record.level === 'warn') {
              warnSpy(record.message);
            }
          },
        },
      ],
      minimumLevel: 'warn',
    });
    const services = createFakeServices({
      crawlers: {
        getByID: () => Promise.resolve({ ...mockCrawler, url_pattern: '^https://only\\.this\\.host/' }),
      },
      codeRunner: recorder.codeRunner,
    });

    const result = await executeCrawler(services, logger, CRAWLER_ID, {
      url: 'https://different.example.com',
    });
    expect(result).toEqual({ type: 'web', result: { ok: true } });
    expect(warnSpy).toHaveBeenCalledWith('URL does not match crawler url_pattern — executing anyway');
  });

  it('passes data input straight through for data crawlers', async () => {
    const recorder = createRunRecorder();
    const services = createFakeServices({
      crawlers: {
        getByID: () => Promise.resolve({ ...mockCrawler, type: 'data', url_pattern: null }),
      },
      codeRunner: recorder.codeRunner,
    });

    const input = { rows: [1, 2, 3] };
    const result = await executeCrawler(services, silentLogger, CRAWLER_ID, input);
    expect(recorder.calls[0]?.request).toMatchObject({ type: 'data', mode: 'run', data: input });
    expect(result.type).toBe('data');
  });

  it('mints the service token for the crawler owner', async () => {
    const recorder = createRunRecorder();
    const services = createFakeServices({
      crawlers: { getByID: () => Promise.resolve({ ...mockCrawler, type: 'data' }) },
      codeRunner: recorder.codeRunner,
    });
    await executeCrawler(services, silentLogger, CRAWLER_ID, {});
    expect(recorder.calls[0]?.bearerToken).toBe('service-token');
  });

  it('propagates code runner failures', async () => {
    const services = createFakeServices({
      crawlers: { getByID: () => Promise.resolve({ ...mockCrawler, type: 'data' }) },
      codeRunner: { run: () => Promise.reject(new Error('CodeRunner error 422')) },
    });
    await expect(executeCrawler(services, silentLogger, CRAWLER_ID, {})).rejects.toThrow(
      'CodeRunner error 422',
    );
  });
});
