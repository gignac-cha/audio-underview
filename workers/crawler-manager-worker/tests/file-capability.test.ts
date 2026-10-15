import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { CrawlerFileCapability, closeFileCapability } from '../sources/crawler-runtime/file-capability.ts';
import { createRedactor } from '../sources/crawler-runtime/redaction.ts';
import { CRAWLER_WORKER_OPTIONS, runCrawler, runLoadedCrawler } from '../sources/crawler-runtime/run-crawler.ts';
import { useInMemorySupabase, type Row } from './in-memory-supabase.ts';
import {
  SUPABASE_ORIGIN,
  addCrawler,
  crawlerRow,
  createMockLogger,
  createTestDependencies,
  testEnvironment,
  uniqueUUID,
  vaultEnvironment,
} from './runtime-harness.ts';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);
const bucket = testEnvironment.CRAWLER_FILES;
const MAXIMUM_SIZE = 26_214_400;

function fileRows(): Row[] {
  return supabase.tables.crawler_files ?? [];
}

function completedResult(outcome: CrawlerRunOutcome): unknown {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'completed' });
  return outcome.status === 'completed' ? outcome.result : undefined;
}

function failedDescription(outcome: CrawlerRunOutcome): string {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'failed' });
  return outcome.status === 'failed' ? outcome.error_description : '';
}

async function run(code: string, options: { userUUID?: string; runID?: string; input?: unknown; dependencies?: ReturnType<typeof createTestDependencies> } = {}) {
  const userUUID = options.userUUID ?? uniqueUUID();
  const crawler = addCrawler(supabase, crawlerRow({ code }));
  const outcome = await runCrawler(options.dependencies ?? createTestDependencies(), crawler.id, options.input ?? {}, {
    userUUID,
    ...(options.runID === undefined ? {} : { runID: options.runID }),
  });
  return { outcome, crawler, userUUID };
}

function createCapability(overrides: Partial<ConstructorParameters<typeof CrawlerFileCapability>[0]> = {}) {
  return new CrawlerFileCapability({
    userUUID: uniqueUUID(),
    runID: undefined,
    crawlerID: uniqueUUID(),
    supabaseClient: createTestDependencies().supabaseClient,
    bucket,
    redactor: createRedactor({}),
    logger: createMockLogger(),
    ...overrides,
  });
}

function streamOf(text: string): ReadableStream {
  return new Response(text).body as ReadableStream;
}

describe('context.files', () => {
  it('saves a file and reads it back in the same run', async () => {
    const { outcome, userUUID, crawler } = await run(`async (input, context) => {
      const reference = await context.files.save('hello file', { name: 'greeting.txt', contentType: 'text/plain; charset=utf-8' });
      const response = await context.files.read(reference);
      return {
        reference,
        text: await response.text(),
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
      };
    }`);

    const result = completedResult(outcome) as Record<string, any>;
    expect(result.reference).toEqual({
      file_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'greeting.txt',
      content_type: 'text/plain; charset=utf-8',
      size: 10,
    });
    expect(result).toMatchObject({ text: 'hello file', contentType: 'text/plain; charset=utf-8', contentLength: '10' });

    const [row] = fileRows();
    expect(row).toMatchObject({
      id: result.reference.file_id,
      user_uuid: userUUID,
      crawler_id: crawler.id,
      object_key: `${userUUID}/${result.reference.file_id}`,
      name: 'greeting.txt',
      content_type: 'text/plain; charset=utf-8',
      size: 10,
    });
    const object = await bucket.get(String(row.object_key));
    expect(await object?.text()).toBe('hello file');
    expect(object?.httpMetadata?.contentType).toBe('text/plain; charset=utf-8');
  });

  it('gives a direct run file an expiry 24 hours ahead and no run', async () => {
    const before = Date.now();
    await run(`(input, context) => context.files.save(new Uint8Array([1, 2, 3]))`);

    const [row] = fileRows();
    expect(row.run_id).toBeNull();
    expect(supabase.requestsOf('POST', 'crawler_files')[0].body).not.toHaveProperty('run_id');
    const expiresAt = Date.parse(String(row.expires_at));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    expect(row).toMatchObject({ content_type: 'application/octet-stream', name: null, size: 3 });
  });

  it('gives a scheduled run file its run and no expiry', async () => {
    const runID = uniqueUUID();
    await run(`(input, context) => context.files.save('data')`, { runID });

    const [row] = fileRows();
    expect(row.run_id).toBe(runID);
    expect(row.expires_at).toBeNull();
    expect(supabase.requestsOf('POST', 'crawler_files')[0].body).not.toHaveProperty('expires_at');
  });

  it('reads a file of a previous run of the same user from its reference', async () => {
    const userUUID = uniqueUUID();
    const first = await run(`(input, context) => context.files.save('from the first stage', { name: 'a.txt' })`, { userUUID });
    const reference = completedResult(first.outcome);

    const second = await run(`async (input, context) => {
      const byReference = await (await context.files.read(input)).text();
      const byID = await (await context.files.read(input.file_id)).text();
      return [byReference, byID];
    }`, { userUUID, input: reference });

    expect(completedResult(second.outcome)).toEqual(['from the first stage', 'from the first stage']);
  });

  it('saves every kind of data', async () => {
    const { outcome } = await run(`async (input, context) => {
      const sizes = [];
      const sources = [
        'text',
        new TextEncoder().encode('bytes'),
        new TextEncoder().encode('array buffer').buffer,
        new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2),
        new Blob(['blob']),
        new Response('stream').body,
        new ReadableStream({ start(controller) { controller.enqueue('chunk-'); controller.enqueue(new Uint8Array([65])); controller.close(); } }),
        new URLSearchParams({ a: '1' }),
      ];
      for (const source of sources) {
        const reference = await context.files.save(source);
        sizes.push([reference.size, await (await context.files.read(reference)).text()]);
      }
      return sizes;
    }`);

    expect(completedResult(outcome)).toEqual([
      [4, 'text'],
      [5, 'bytes'],
      [12, 'array buffer'],
      [2, '\u0002\u0003'],
      [4, 'blob'],
      [6, 'stream'],
      [7, 'chunk-A'],
      [3, 'a=1'],
    ]);
  });

  it('saves an empty file', async () => {
    const { outcome } = await run(`async (input, context) => {
      const reference = await context.files.save('');
      return [reference.size, await (await context.files.read(reference)).text()];
    }`);

    expect(completedResult(outcome)).toEqual([0, '']);
  });

  it('answers the same error for a missing file, a file of another user and an expired file', async () => {
    const owner = uniqueUUID();
    const saved = completedResult((await run(`(input, context) => context.files.save('mine')`, { userUUID: owner })).outcome) as { file_id: string };
    const expired = completedResult((await run(`(input, context) => context.files.save('old')`, { userUUID: owner })).outcome) as { file_id: string };
    const expiredRow = fileRows().find((row) => row.id === expired.file_id) as Row;
    expiredRow.expires_at = new Date(Date.now() - 1000).toISOString();

    const errors = completedResult((await run(`async (input, context) => {
      const errors = [];
      for (const reference of input.references) {
        try { await context.files.read(reference); errors.push('read'); } catch (error) { errors.push(error.message); }
      }
      return errors;
    }`, {
      userUUID: uniqueUUID(),
      input: { references: [saved, saved.file_id, uniqueUUID(), 'not-a-uuid', { file_id: 42 }, null] },
    })).outcome);
    const ownErrors = completedResult((await run(`async (input, context) => {
      try { await context.files.read(input); return 'read'; } catch (error) { return error.message; }
    }`, { userUUID: owner, input: expired })).outcome);

    expect(errors).toEqual(Array(6).fill('File not found'));
    expect(ownErrors).toBe('File not found');
  });

  it('answers File not found when the object is gone from R2', async () => {
    const userUUID = uniqueUUID();
    const reference = completedResult((await run(`(input, context) => context.files.save('soon gone')`, { userUUID })).outcome) as { file_id: string };
    await bucket.delete(`${userUUID}/${reference.file_id}`);

    const outcome = (await run(`(input, context) => context.files.read(input)`, { userUUID, input: reference })).outcome;

    expect(failedDescription(outcome)).toBe('File not found');
  });

  it('refuses data over 25 MiB as an ArrayBuffer, a Blob or a ReadableStream', async () => {
    const { outcome } = await run(`async (input, context) => {
      const errors = [];
      const tooLarge = ${MAXIMUM_SIZE + 1};
      const sources = [
        () => new ArrayBuffer(tooLarge),
        () => new Blob([new Uint8Array(tooLarge)]),
        () => new ReadableStream({
          pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
        }),
      ];
      for (const source of sources) {
        try { await context.files.save(source()); errors.push('saved'); } catch (error) { errors.push(error.message); }
      }
      return errors;
    }`);

    expect(completedResult(outcome)).toEqual(Array(3).fill(`File exceeds the maximum size of ${MAXIMUM_SIZE} bytes`));
    expect(fileRows()).toEqual([]);
  });

  it('accepts exactly 25 MiB', async () => {
    const { outcome } = await run(`async (input, context) => (await context.files.save(new Uint8Array(${MAXIMUM_SIZE}))).size`);

    expect(completedResult(outcome)).toBe(MAXIMUM_SIZE);
  });

  it('refuses an invalid name or content type', async () => {
    const { outcome } = await run(`async (input, context) => {
      const errors = [];
      const options = [
        { name: '' },
        { name: 'a'.repeat(256) },
        { name: 'line\\nbreak' },
        { name: 'nul\\u0000' },
        { name: 'delete\\u007f' },
        { name: 42 },
        { contentType: 'text' },
        { contentType: 'text/plain\\r\\nX-Injected: 1' },
        { contentType: 'a/' + 'b'.repeat(300) },
        { contentType: '' },
        { contentType: 5 },
      ];
      for (const option of options) {
        try { await context.files.save('x', option); errors.push('saved'); } catch (error) { errors.push(error.message); }
      }
      return errors;
    }`);

    expect(completedResult(outcome)).toEqual([
      ...Array(6).fill('Invalid file name'),
      ...Array(5).fill('Invalid content type'),
    ]);
    expect(fileRows()).toEqual([]);
  });

  it('accepts a name of 255 characters and a content type with parameters', async () => {
    const { outcome } = await run(`async (input, context) => {
      const reference = await context.files.save('x', { name: '가'.repeat(255), contentType: 'audio/mpeg; codecs="mp3"' });
      return [reference.name.length, reference.content_type];
    }`);

    expect(completedResult(outcome)).toEqual([255, 'audio/mpeg; codecs="mp3"']);
  });

  it('hides environment variable values in the file name', async () => {
    const author = uniqueUUID();
    await vaultEnvironment(author, { TOKEN: 'token-value-1234' });
    const crawler = addCrawler(supabase, crawlerRow({
      user_uuid: author,
      code: `(input, context) => context.files.save('content', { name: 'report-' + context.environment.TOKEN + '.txt' })`,
    }));

    const outcome = await runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: author });

    expect(completedResult(outcome)).toMatchObject({ name: 'report-[REDACTED].txt' });
    expect(fileRows()[0].name).toBe('report-[REDACTED].txt');
  });

  it('is not available without a user', async () => {
    const crawler = crawlerRow({ code: `async (input, context) => {
      const errors = [];
      for (const call of [() => context.files.save('x'), () => context.files.read('00000000-0000-0000-0000-000000000000')]) {
        try { await call(); errors.push('worked'); } catch (error) { errors.push(error.message); }
      }
      return errors;
    }` });

    const outcome = await runLoadedCrawler(createTestDependencies(), crawler, {}, undefined);

    expect(completedResult(outcome)).toEqual(['Files are not available in this run', 'Files are not available in this run']);
  });

  it('is closed when the run ends, so code still running after a timeout saves nothing', async () => {
    const dependencies = createTestDependencies({ timeouts: { runnerMilliseconds: 20, hostMilliseconds: 5_000 } });
    const { outcome } = await run(`async (input, context) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await context.files.save('too late');
      return 'never';
    }`, { dependencies });

    expect(outcome).toMatchObject({ status: 'failed', error_code: 'execution_timeout' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fileRows()).toEqual([]);
  });
});

describe('CrawlerFileCapability', () => {
  it('throws Files are not available in this run after close()', async () => {
    const capability = createCapability();
    closeFileCapability(capability);

    await expect(capability.save(streamOf('x'), { size: 1 })).rejects.toThrow('Files are not available in this run');
    await expect(capability.read(uniqueUUID())).rejects.toThrow('Files are not available in this run');
    expect(fileRows()).toEqual([]);
  });

  it('deletes the row when R2 refuses the object', async () => {
    const failingBucket = {
      put: () => Promise.reject(new Error('R2 is down')),
      get: bucket.get.bind(bucket),
      delete: bucket.delete.bind(bucket),
    } as unknown as R2Bucket;
    const logger = createMockLogger();
    const capability = createCapability({ bucket: failingBucket, logger });

    await expect(capability.save(streamOf('abc'), { size: 3 })).rejects.toThrow('File could not be saved');

    expect(fileRows()).toEqual([]);
    // The trigger queued the key, so the cron removes whatever reached R2
    expect(supabase.tables.crawler_file_deletions).toHaveLength(1);
    expect(supabase.requestsOf('DELETE', 'crawler_files')).toHaveLength(1);
  });

  it('deletes the object when the row went while it was written', async () => {
    let objectKey = '';
    const racingBucket = {
      put: async (key: string, value: ReadableStream, options: R2PutOptions) => {
        objectKey = key;
        const object = await bucket.put(key, value, options);
        // The run was deleted in the meantime
        supabase.tables.crawler_files = [];
        return object;
      },
      get: bucket.get.bind(bucket),
      delete: bucket.delete.bind(bucket),
    } as unknown as R2Bucket;
    const capability = createCapability({ bucket: racingBucket });

    await expect(capability.save(streamOf('abc'), { size: 3 })).rejects.toThrow('File could not be saved');

    expect(objectKey).not.toBe('');
    expect(await bucket.get(objectKey)).toBeNull();
  });

  it('gives up a save that was still writing when the run ended', async () => {
    let capability: CrawlerFileCapability | undefined;
    const closingBucket = {
      put: async (key: string, value: ReadableStream, options: R2PutOptions) => {
        const object = await bucket.put(key, value, options);
        // The host gave up on the run in the meantime
        closeFileCapability(capability as CrawlerFileCapability);
        return object;
      },
      get: bucket.get.bind(bucket),
      delete: bucket.delete.bind(bucket),
    } as unknown as R2Bucket;
    capability = createCapability({ bucket: closingBucket });

    await expect(capability.save(streamOf('abc'), { size: 3 })).rejects.toThrow('Files are not available in this run');

    expect(fileRows()).toEqual([]);
    // The trigger queued the key, so the cron removes the object
    expect(supabase.tables.crawler_file_deletions).toHaveLength(1);
  });

  it('answers File could not be saved when the row cannot be written', async () => {
    supabase.intercept = (request) => (request.method === 'POST' && request.table === 'crawler_files'
      ? { statusCode: 500, data: { code: 'XX000', message: 'database is down' } }
      : undefined);
    const capability = createCapability();

    await expect(capability.save(streamOf('abc'), { size: 3 })).rejects.toThrow('File could not be saved');
  });

  it('refuses a stream longer than its declared size', async () => {
    const capability = createCapability();

    await expect(capability.save(streamOf('abcdef'), { size: 3 })).rejects.toThrow('File could not be saved');
    expect(fileRows()).toEqual([]);
  });

  it.each([
    [{ size: -1 }, 'Invalid file size'],
    [{ size: 1.5 }, 'Invalid file size'],
    [{ size: '3' }, 'Invalid file size'],
    [{ size: MAXIMUM_SIZE + 1 }, `File exceeds the maximum size of ${MAXIMUM_SIZE} bytes`],
  ])('refuses the size of %j', async (options, message) => {
    await expect(createCapability().save(streamOf('abc'), options as { size: number })).rejects.toThrow(message);
  });

  it('keeps its fields out of reach of the Dynamic Worker, which sees only its methods', async () => {
    const capability = createCapability();
    const probe = env.LOADER.get(`file-capability-probe-${uniqueUUID()}`, async () => ({
      // The date of the crawler Dynamic Workers, which receive the capability
      compatibilityDate: CRAWLER_WORKER_OPTIONS.compatibilityDate,
      mainModule: 'probe.js',
      modules: {
        'probe.js': `
          import { WorkerEntrypoint } from 'cloudflare:workers';
          export class Probe extends WorkerEntrypoint {
            async run(capabilities) {
              const files = capabilities.files;
              const seen = {};
              for (const key of ['supabaseClient', 'bucket', 'userUUID', 'runID', 'crawlerID', 'redactor', 'logger', 'closed', 'close', 'store']) {
                try {
                  const value = await files[key];
                  seen[key] = value === undefined ? 'undefined' : typeof value;
                } catch (error) {
                  seen[key] = 'threw';
                }
              }
              for (const key of ['close', 'store']) {
                try { await files[key](files); seen[key + 'Call'] = 'called'; } catch (error) { seen[key + 'Call'] = 'threw'; }
              }
              seen.saveType = typeof files.save;
              return seen;
            }
          }
        `,
      },
      globalOutbound: null,
    }));
    const entrypoint = probe.getEntrypoint('Probe') as unknown as { run(capabilities: unknown): Promise<Record<string, string>> };

    const seen = await entrypoint.run({ files: capability });

    for (const key of ['supabaseClient', 'bucket', 'userUUID', 'runID', 'crawlerID', 'redactor', 'logger', 'closed']) {
      expect(seen[key], key).not.toBe('object');
      expect(seen[key], key).not.toBe('string');
    }
    expect(seen.closeCall).toBe('threw');
    expect(seen.storeCall).toBe('threw');
    expect(seen.saveType).toBe('function');
    // The capability is still open: nothing reached close()
    await expect(capability.save(streamOf('abc'), { size: 3 })).resolves.toMatchObject({ size: 3 });
  });
});
