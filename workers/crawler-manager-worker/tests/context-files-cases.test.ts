import { describe, it, expect } from 'vitest';
import type { CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { runLoadedCrawler } from '../sources/crawler-runtime/run-crawler.ts';
import { useInMemorySupabase, type Row } from './in-memory-supabase.ts';
import { SUPABASE_ORIGIN, crawlerRow, createTestDependencies, testEnvironment, uniqueUUID } from './runtime-harness.ts';

// context.files in the Dynamic Worker: the cases beyond file-capability.test.ts.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);
const bucket = testEnvironment.CRAWLER_FILES;
const MAXIMUM_SIZE = 26_214_400;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fileRows(): Row[] {
  return supabase.tables.crawler_files ?? [];
}

async function run(
  code: string,
  options: { input?: unknown; userUUID?: string | null; runID?: string; dependencies?: ReturnType<typeof createTestDependencies> } = {},
): Promise<CrawlerRunOutcome> {
  const userUUID = options.userUUID === undefined ? uniqueUUID() : options.userUUID;
  return runLoadedCrawler(
    options.dependencies ?? createTestDependencies(),
    crawlerRow({ code }),
    options.input ?? {},
    userUUID === null ? undefined : { userUUID, ...(options.runID === undefined ? {} : { runID: options.runID }) },
  );
}

function resultOf(outcome: CrawlerRunOutcome): any {
  expect(outcome, JSON.stringify(outcome).slice(0, 500)).toMatchObject({ status: 'completed' });
  return outcome.status === 'completed' ? outcome.result : undefined;
}

async function storedText(userUUID: string, reference: { file_id: string }): Promise<string | undefined> {
  return (await bucket.get(`${userUUID}/${reference.file_id}`))?.text();
}

describe('context.files.save', () => {
  it('saves a string as UTF-8 and returns a reference with the name, the type and the size in bytes', async () => {
    const user = uniqueUUID();

    const result = resultOf(await run(`async (input, context) => {
      const audio = await context.files.save('안녕 hello', { name: 'episode.txt', contentType: 'text/plain; charset=utf-8' });
      return { title: 'Episode', audio };
    }`, { userUUID: user }));

    expect(result.audio).toEqual({
      file_id: expect.any(String),
      name: 'episode.txt',
      content_type: 'text/plain; charset=utf-8',
      size: new TextEncoder().encode('안녕 hello').byteLength,
    });
    expect(await storedText(user, result.audio)).toBe('안녕 hello');
    expect(fileRows()[0]).toMatchObject({ user_uuid: user, size: result.audio.size });
  });

  it('defaults the name to null and the type to application/octet-stream in the reference', async () => {
    const result = resultOf(await run('async (input, context) => context.files.save("x")'));

    expect(result).toEqual({ file_id: expect.any(String), name: null, content_type: 'application/octet-stream', size: 1 });
  });

  it('saves every kind of data a Response takes, offsets and element sizes included, and the same bytes come back', async () => {
    const user = uniqueUUID();

    const references = resultOf(await run(`async (input, context) => {
      const bytes = new Uint8Array([104, 101, 108, 108, 111]);
      const references = {};
      references.arrayBuffer = await context.files.save(bytes.buffer.slice(0));
      references.subarray = await context.files.save(bytes.subarray(1, 4));
      references.dataView = await context.files.save(new DataView(bytes.buffer, 0, 3));
      references.uint16Array = await context.files.save(new Uint16Array([0x6568, 0x6c6c]));
      references.blob = await context.files.save(new Blob(['hel', 'lo']));
      references.chunks = await context.files.save(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('he')); controller.enqueue(new TextEncoder().encode('llo')); controller.close(); },
      }));
      references.searchParameters = await context.files.save(new URLSearchParams({ a: '1', b: '2' }));
      return references;
    }`, { userUUID: user })) as Record<string, { file_id: string; size: number }>;

    const texts: Record<string, string | undefined> = {};
    for (const [name, reference] of Object.entries(references)) {
      texts[name] = await storedText(user, reference);
      expect(new TextEncoder().encode(texts[name]).byteLength, name).toBe(reference.size);
    }
    expect(texts).toEqual({
      arrayBuffer: 'hello',
      subarray: 'ell',
      dataView: 'hel',
      uint16Array: 'hell',
      blob: 'hello',
      chunks: 'hello',
      searchParameters: 'a=1&b=2',
    });
  });

  it('saves an empty file in each form', async () => {
    const user = uniqueUUID();

    const references = resultOf(await run(`async (input, context) => ({
      empty: await context.files.save(''),
      emptyBuffer: await context.files.save(new ArrayBuffer(0)),
      emptyStream: await context.files.save(new ReadableStream({ start(controller) { controller.close(); } })),
    })`, { userUUID: user })) as Record<string, { file_id: string; size: number }>;

    for (const reference of Object.values(references)) {
      expect(reference.size).toBe(0);
      expect(await storedText(user, reference)).toBe('');
    }
  });

  it('refuses data over 25 MiB in every form, records nothing for them, and accepts exactly 25 MiB', async () => {
    const result = resultOf(await run(`async (input, context) => {
      const limit = ${MAXIMUM_SIZE};
      const attempts = {
        arrayBuffer: () => context.files.save(new ArrayBuffer(limit + 1)),
        uint8Array: () => context.files.save(new Uint8Array(limit + 1)),
        blob: () => context.files.save(new Blob([new Uint8Array(limit), new Uint8Array(1)])),
        stream: () => {
          let sent = 0;
          return context.files.save(new ReadableStream({
            pull(controller) {
              if (sent > limit) return controller.close();
              controller.enqueue(new Uint8Array(1_048_576));
              sent += 1_048_576;
            },
          }));
        },
        string: () => context.files.save('x'.repeat(limit + 1)),
      };
      const errors = {};
      for (const [name, attempt] of Object.entries(attempts)) {
        try { await attempt(); errors[name] = 'saved'; } catch (error) { errors[name] = error.message; }
      }
      const exact = await context.files.save(new ArrayBuffer(limit));
      return { errors, exactSize: exact.size };
    }`));

    const message = `File exceeds the maximum size of ${MAXIMUM_SIZE} bytes`;
    expect(result).toEqual({
      errors: { arrayBuffer: message, uint8Array: message, blob: message, stream: message, string: message },
      exactSize: MAXIMUM_SIZE,
    });
    expect(fileRows()).toHaveLength(1);
  });

  it('refuses names and types that are not valid with the same messages', async () => {
    const result = resultOf(await run(`async (input, context) => {
      const errors = [];
      for (const options of [{ name: '' }, { name: 'a'.repeat(256) }, { name: 'bad\\nname' }, { contentType: 'not a type' }, { contentType: 'text/plain\\r\\nx: y' }, { contentType: '' }]) {
        try { await context.files.save('x', options); errors.push('saved'); } catch (error) { errors.push(error.message); }
      }
      return errors;
    }`));

    expect(result).toEqual(['Invalid file name', 'Invalid file name', 'Invalid file name', 'Invalid content type', 'Invalid content type', 'Invalid content type']);
    expect(fileRows()).toEqual([]);
  });

  it('answers File could not be saved to code that catches it when the object cannot be stored, and leaves no row', async () => {
    const failingBucket = { put: () => Promise.reject(new Error('R2 is down')), delete: () => Promise.resolve() } as unknown as R2Bucket;

    const result = resultOf(await run(`async (input, context) => {
      try { await context.files.save('x'); return 'saved'; } catch (error) { return error.message; }
    }`, { dependencies: createTestDependencies({ bucket: failingBucket }) }));

    expect(result).toBe('File could not be saved');
    expect(fileRows()).toEqual([]);
  });
});

describe('context.files.read', () => {
  it('gives a Response with the stored type and length, readable as JSON, text, bytes and a stream, by reference or by file_id', async () => {
    const result = resultOf(await run(`async (input, context) => {
      const reference = await context.files.save('{"hello":"world"}', { name: 'data.json', contentType: 'application/json' });
      const byReference = await context.files.read(reference);
      const byID = await context.files.read(reference.file_id);
      const small = await context.files.save(new Uint8Array([1, 2, 3, 250]));
      const buffer = await (await context.files.read(small)).arrayBuffer();
      const reader = (await context.files.read(small)).body.getReader();
      const chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(...value); }
      return {
        isResponse: byReference instanceof Response,
        status: byReference.status,
        contentType: byReference.headers.get('content-type'),
        contentLength: byReference.headers.get('content-length'),
        json: await byReference.json(),
        text: await byID.text(),
        bytes: Array.from(new Uint8Array(buffer)),
        chunks,
      };
    }`));

    expect(result).toEqual({
      isResponse: true,
      status: 200,
      contentType: 'application/json',
      contentLength: '17',
      json: { hello: 'world' },
      text: '{"hello":"world"}',
      bytes: [1, 2, 3, 250],
      chunks: [1, 2, 3, 250],
    });
  });

  it('lets the next stage read the file by the reference that came in as its input', async () => {
    const user = uniqueUUID();
    const runID = uniqueUUID();
    const first = resultOf(await run(
      'async (input, context) => ({ audio: await context.files.save("episode audio", { name: "a.mp3", contentType: "audio/mpeg" }) })',
      { userUUID: user, runID },
    ));

    const second = resultOf(await run(
      'async (input, context) => { const response = await context.files.read(input.audio); return { text: await response.text(), type: response.headers.get("content-type") }; }',
      { userUUID: user, runID, input: first },
    ));

    expect(second).toEqual({ text: 'episode audio', type: 'audio/mpeg' });
  });

  it('answers File not found, the same, to another user for any reference, and to the owner for a malformed one', async () => {
    const user = uniqueUUID();
    const reference = resultOf(await run('async (input, context) => context.files.save("private")', { userUUID: user }));
    const code = `async (input, context) => {
      const errors = [];
      for (const target of input.targets) {
        try { await (await context.files.read(target)).text(); errors.push('read'); } catch (error) { errors.push(error.message); }
      }
      return errors;
    }`;
    const targets = [reference, reference.file_id, '00000000-0000-0000-0000-000000000000', 'nope', '', 42, null, {}, { file_id: 5 }];

    const byOther = resultOf(await run(code, { input: { targets } }));
    const byOwner = resultOf(await run(code, { userUUID: user, input: { targets } }));

    expect(byOther).toEqual(targets.map(() => 'File not found'));
    expect(byOwner).toEqual(['read', 'read', ...targets.slice(2).map(() => 'File not found')]);
  });

  it('does not read an expired file', async () => {
    const user = uniqueUUID();
    const reference = resultOf(await run('async (input, context) => context.files.save("short lived")', { userUUID: user }));
    (fileRows()[0] as Row).expires_at = new Date(Date.now() - 1000).toISOString();

    const result = resultOf(await run(
      'async (input, context) => { try { await context.files.read(input); return "read"; } catch (error) { return error.message; } }',
      { userUUID: user, input: reference },
    ));

    expect(result).toBe('File not found');
  });
});

describe('without a user', () => {
  it('has the methods, which throw Files are not available in this run and touch nothing', async () => {
    const result = resultOf(await run(`async (input, context) => {
      const results = {};
      try { await context.files.save('x'); results.save = 'saved'; } catch (error) { results.save = error.message; }
      try { await context.files.read('00000000-0000-0000-0000-000000000000'); results.read = 'read'; } catch (error) { results.read = error.message; }
      results.keys = Object.keys(context.files);
      return results;
    }`, { userUUID: null }));

    expect(result).toEqual({
      save: 'Files are not available in this run',
      read: 'Files are not available in this run',
      keys: ['save', 'read'],
    });
    expect(supabase.requests).toEqual([]);
  });
});

describe('after the host gave up on the run', () => {
  it('lets the code that is still running save no file: a run stopped on the host side cannot add files', async () => {
    const user = uniqueUUID();
    // Same user and same code, so the same isolate: the second run reads what the abandoned one left behind
    const code = `async (input, context) => {
      if (input.report) return globalThis.lateResult ?? 'nothing yet';
      await new Promise((resolve) => setTimeout(resolve, 150));
      try { await context.files.save('too late'); globalThis.lateResult = 'saved'; } catch (error) { globalThis.lateResult = error.message; }
      return 'finished';
    }`;

    const stopped = await run(code, {
      userUUID: user,
      input: { report: false },
      dependencies: createTestDependencies({ timeouts: { runnerMilliseconds: 5_000, hostMilliseconds: 40 } }),
    });
    expect(stopped).toMatchObject({ status: 'failed', error_code: 'execution_timeout' });

    await sleep(400);
    const report = resultOf(await run(code, { userUUID: user, input: { report: true } }));

    expect(report).toBe('Files are not available in this run');
    expect(fileRows()).toEqual([]);
    expect((await bucket.list({ prefix: `${user}/` })).objects).toEqual([]);
  });
});
