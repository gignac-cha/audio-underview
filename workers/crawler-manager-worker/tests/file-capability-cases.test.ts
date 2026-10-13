import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlerFileCapability, closeFileCapability } from '../sources/crawler-runtime/file-capability.ts';
import { createRedactor } from '../sources/crawler-runtime/redaction.ts';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import { SUPABASE_ORIGIN, createMockLogger, createTestDependencies, testEnvironment, uniqueUUID } from './runtime-harness.ts';

// CrawlerFileCapability on its own, beyond file-capability.test.ts: the arguments the Dynamic Worker can pass,
// the failures of the database and of R2, and what a reference looks like.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);
const bucket = testEnvironment.CRAWLER_FILES;
const MAXIMUM_SIZE = 26_214_400;

function streamOf(text: string): ReadableStream {
  return new Response(text).body as ReadableStream;
}

function createCapability(overrides: Partial<ConstructorParameters<typeof CrawlerFileCapability>[0]> = {}) {
  const logger = createMockLogger();
  const userUUID = overrides.userUUID ?? uniqueUUID();
  const capability = new CrawlerFileCapability({
    userUUID,
    runID: undefined,
    crawlerID: uniqueUUID(),
    supabaseClient: createTestDependencies().supabaseClient,
    bucket,
    redactor: createRedactor({}),
    logger,
    ...overrides,
  });
  return { capability, logger, userUUID };
}

async function listObjects(userUUID: string) {
  return (await bucket.list({ prefix: `${userUUID}/` })).objects;
}

beforeEach(() => {
  supabase.tables.crawler_files = [];
});

describe('the reference', () => {
  it('is a plain object with the four fields, so it passes to the next stage as JSON', async () => {
    const { capability } = createCapability();

    const reference = await capability.save(streamOf('x'), { size: 1 });

    expect(Object.getPrototypeOf(reference)).toBe(Object.prototype);
    expect(Object.keys(reference).sort()).toEqual(['content_type', 'file_id', 'name', 'size']);
    expect(JSON.parse(JSON.stringify(reference))).toEqual(reference);
    expect(reference).toEqual({ file_id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: null, content_type: 'application/octet-stream', size: 1 });
  });

  it('is stored with the object key of the user and the file, the type on the object', async () => {
    const { capability, userUUID } = createCapability();

    const reference = await capability.save(streamOf('hello audio'), { size: 11, name: 'episode.mp3', contentType: 'audio/mpeg' });

    const object = await bucket.get(`${userUUID}/${reference.file_id}`);
    expect(await object?.text()).toBe('hello audio');
    expect(object?.httpMetadata?.contentType).toBe('audio/mpeg');
  });
});

describe('save: what the Dynamic Worker passes', () => {
  it('stores an empty file and a file of exactly 25 MiB', async () => {
    const { capability, userUUID } = createCapability();

    const empty = await capability.save(new ReadableStream({ start: (controller) => controller.close() }), { size: 0 });
    const chunk = new Uint8Array(1_048_576).fill(97);
    let sent = 0;
    const full = await capability.save(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 25) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    }), { size: MAXIMUM_SIZE });

    expect(empty.size).toBe(0);
    expect(await (await bucket.get(`${userUUID}/${empty.file_id}`))?.text()).toBe('');
    expect((await bucket.head(`${userUUID}/${full.file_id}`))?.size).toBe(MAXIMUM_SIZE);
  });

  it('refuses a size that is not an integer from 0 to 25 MiB before it records anything', async () => {
    const { capability } = createCapability();

    for (const size of [-1, 1.5, NaN, Infinity, '5', null, undefined]) {
      await expect(capability.save(streamOf('x'), { size } as never), String(size)).rejects.toThrow('Invalid file size');
    }
    await expect(capability.save(streamOf('x'), { size: MAXIMUM_SIZE + 1 })).rejects.toThrow(`File exceeds the maximum size of ${MAXIMUM_SIZE} bytes`);
    expect(supabase.requests).toEqual([]);
  });

  it('refuses options or data that are not what the runner passes, and records nothing', async () => {
    const { capability } = createCapability();

    await expect(capability.save(streamOf('x'), undefined as never)).rejects.toThrow();
    await expect(capability.save(streamOf('x'), null as never)).rejects.toThrow();
    await expect(capability.save('not a stream' as never, { size: 1 })).rejects.toThrow();
    await expect(capability.save(undefined as never, { size: 1 })).rejects.toThrow();
    expect(supabase.tables.crawler_files).toEqual([]);
  });

  it('refuses a name of 0 or more than 255 characters or with a control character, and takes 255', async () => {
    const { capability } = createCapability();

    for (const name of ['', 'a'.repeat(256), 'tab\there', 'new\nline', 'nul\u0000', 'del\u007f', 'bell\u0007', 42, {}]) {
      await expect(capability.save(streamOf('x'), { size: 1, name } as never), JSON.stringify(name)).rejects.toThrow('Invalid file name');
    }
    await expect(capability.save(streamOf('x'), { size: 1, name: 'a'.repeat(255) })).resolves.toMatchObject({ size: 1 });
    await expect(capability.save(streamOf('x'), { size: 1, name: '한국어 이름.mp3' })).resolves.toMatchObject({ name: '한국어 이름.mp3' });
    expect(supabase.tables.crawler_files).toHaveLength(2);
  });

  it('counts the 255 characters of a name in code points', async () => {
    const { capability } = createCapability();

    await expect(capability.save(streamOf('x'), { size: 1, name: '😀'.repeat(255) })).resolves.toMatchObject({ size: 1 });
    await expect(capability.save(streamOf('x'), { size: 1, name: '😀'.repeat(256) })).rejects.toThrow('Invalid file name');
  });

  it('refuses a content type that is not type/subtype or is too long, and takes the usual ones', async () => {
    const { capability } = createCapability();

    for (const contentType of [
      '', 'audio', 'audio/', '/mpeg', 'audio mpeg/x', 'audio/mp eg', 'a/b/c', `audio/${'x'.repeat(128)}`, `text/plain;${'x'.repeat(260)}`,
      'text/plain;\nx', 'text/plain\r\nx-injected: 1', 42,
    ]) {
      await expect(capability.save(streamOf('x'), { size: 1, contentType } as never), String(contentType)).rejects.toThrow('Invalid content type');
    }
    for (const contentType of ['audio/mpeg', 'image/svg+xml', 'application/vnd.api+json', 'text/plain; charset=utf-8', 'application/x-www-form-urlencoded', 'a/b']) {
      await expect(capability.save(streamOf('x'), { size: 1, contentType }), contentType).resolves.toMatchObject({ content_type: contentType });
    }
  });
});

describe('save: names and content', () => {
  it('hides an environment variable value in the name before storing it, and returns the stored name', async () => {
    const { capability } = createCapability({ redactor: createRedactor({ KEY: 'secret-api-key-1' }) });

    const reference = await capability.save(streamOf('x'), { size: 1, name: 'export-secret-api-key-1.txt' });

    expect(reference.name).toBe('export-[REDACTED].txt');
    expect(supabase.tables.crawler_files[0].name).toBe('export-[REDACTED].txt');
    expect(JSON.stringify(supabase.tables.crawler_files)).not.toContain('secret-api-key-1');
  });

  it('keeps a name within 255 characters when hiding a value makes it longer', async () => {
    const { capability } = createCapability({ redactor: createRedactor({ KEY: 'abcd' }) });

    const reference = await capability.save(streamOf('x'), { size: 1, name: `${'abcd'.repeat(63)}abc` });

    expect(Array.from(reference.name as string)).toHaveLength(255);
    expect(supabase.tables.crawler_files[0].name).toBe(reference.name);
  });

  it('does not hide anything in the content of a file', async () => {
    const { capability, userUUID } = createCapability({ redactor: createRedactor({ KEY: 'secret-api-key-1' }) });

    const reference = await capability.save(streamOf('contains secret-api-key-1'), { size: 25 });

    expect(await (await bucket.get(`${userUUID}/${reference.file_id}`))?.text()).toBe('contains secret-api-key-1');
  });
});

describe('save: failures', () => {
  it('deletes the row, queues the key and says File could not be saved when R2 refuses the object', async () => {
    const failingBucket = { put: vi.fn().mockRejectedValue(new Error('R2 is down')), delete: vi.fn() } as unknown as R2Bucket;
    const { capability } = createCapability({ bucket: failingBucket });

    await expect(capability.save(streamOf('x'), { size: 1, name: 'a.txt' })).rejects.toThrow(new Error('File could not be saved'));

    expect(supabase.tables.crawler_files).toEqual([]);
    expect(supabase.requestsOf('POST', 'crawler_files')).toHaveLength(1);
    expect(supabase.requestsOf('DELETE', 'crawler_files')).toHaveLength(1);
    expect(supabase.tables.crawler_file_deletions).toHaveLength(1);
  });

  it('deletes the row when the data is shorter or longer than the size it was announced with', async () => {
    const { capability } = createCapability();

    await expect(capability.save(streamOf('short'), { size: 20 })).rejects.toThrow('File could not be saved');
    expect(supabase.tables.crawler_files).toEqual([]);
    await expect(capability.save(streamOf('this is too long'), { size: 4 })).rejects.toThrow('File could not be saved');
    expect(supabase.tables.crawler_files).toEqual([]);
  });

  it('deletes the row when the stream breaks half way', async () => {
    const { capability } = createCapability();
    const broken = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('part'));
        controller.error(new Error('stream broke'));
      },
    });

    await expect(capability.save(broken, { size: 10 })).rejects.toThrow('File could not be saved');

    expect(supabase.tables.crawler_files).toEqual([]);
  });

  it('stores nothing and says File could not be saved when the row cannot be recorded', async () => {
    supabase.intercept = (request) => (request.method === 'POST' && request.table === 'crawler_files'
      ? { statusCode: 500, data: { message: 'insert failed' } }
      : undefined);
    const { capability, userUUID } = createCapability();

    await expect(capability.save(streamOf('x'), { size: 1 })).rejects.toThrow(new Error('File could not be saved'));

    expect(await listObjects(userUUID)).toEqual([]);
  });

  it('says File could not be saved when it cannot check that the row is still there', async () => {
    supabase.intercept = (request) => (request.method === 'GET' && request.table === 'crawler_files'
      ? { statusCode: 500, data: { message: 'select failed' } }
      : undefined);
    const { capability } = createCapability();

    await expect(capability.save(streamOf('x'), { size: 1 })).rejects.toThrow(new Error('File could not be saved'));
  });
});

describe('read', () => {
  async function saveFile(capability: CrawlerFileCapability, text: string, options: { name?: string; contentType?: string } = {}) {
    return capability.save(streamOf(text), { size: new TextEncoder().encode(text).byteLength, ...options });
  }

  it('reads back what was saved with its type, name and size', async () => {
    const { capability } = createCapability();
    const reference = await saveFile(capability, 'audio bytes', { name: 'episode.mp3', contentType: 'audio/mpeg' });

    const file = await capability.read(reference.file_id);

    expect(await new Response(file.body).text()).toBe('audio bytes');
    expect(file).toMatchObject({ name: 'episode.mp3', content_type: 'audio/mpeg', size: 11 });
  });

  it('answers File not found, the same, for another user, an expired file, a missing file, a missing object and a bad ID', async () => {
    const { capability, userUUID } = createCapability();
    const { capability: other } = createCapability();
    const reference = await saveFile(capability, 'private');
    const expired = await saveFile(capability, 'old');
    (supabase.tables.crawler_files.find((row) => row.id === expired.file_id) as Record<string, unknown>).expires_at = new Date(Date.now() - 1000).toISOString();
    const orphaned = await saveFile(capability, 'no object');
    await bucket.delete(`${userUUID}/${orphaned.file_id}`);

    const attempts: [CrawlerFileCapability, unknown][] = [
      [other, reference.file_id],
      [capability, expired.file_id],
      [capability, orphaned.file_id],
      [capability, '00000000-0000-0000-0000-000000000000'],
      [capability, 'not-a-uuid'],
      [capability, ''],
      [capability, 42],
      [capability, undefined],
      [capability, { file_id: reference.file_id }],
    ];
    for (const [reader, fileID] of attempts) {
      await expect(reader.read(fileID as string), String(fileID)).rejects.toThrow(new Error('File not found'));
    }
  });

  it('does not answer File not found when the database or R2 fails, since the file may be there', async () => {
    const { capability } = createCapability();
    const reference = await saveFile(capability, 'x');
    supabase.intercept = (request) => (request.method === 'GET' && request.table === 'crawler_files'
      ? { statusCode: 500, data: { message: 'select failed' } }
      : undefined);

    const databaseError = await capability.read(reference.file_id).catch((caught: Error) => caught);
    expect(databaseError).toBeInstanceOf(Error);
    expect((databaseError as Error).message).not.toBe('File not found');

    supabase.intercept = undefined;
    const { capability: broken } = createCapability({
      userUUID: (supabase.tables.crawler_files[0].user_uuid as string),
      bucket: { get: vi.fn().mockRejectedValue(new Error('R2 is down')) } as unknown as R2Bucket,
    });
    const bucketError = await broken.read(reference.file_id).catch((caught: Error) => caught);
    expect(bucketError).toBeInstanceOf(Error);
    expect((bucketError as Error).message).not.toBe('File not found');
  });
});

describe('after close', () => {
  it('refuses save and read with Files are not available in this run, and reads and writes nothing', async () => {
    const { capability } = createCapability();
    const reference = await capability.save(streamOf('x'), { size: 1 });
    const requests = supabase.requests.length;

    closeFileCapability(capability);

    await expect(capability.save(streamOf('y'), { size: 1 })).rejects.toThrow(new Error('Files are not available in this run'));
    await expect(capability.read(reference.file_id)).rejects.toThrow(new Error('Files are not available in this run'));
    expect(supabase.requests).toHaveLength(requests);
    expect(supabase.tables.crawler_files).toHaveLength(1);
  });

  it('shows only save and read on the instance, so the Dynamic Worker cannot close it', () => {
    const { capability } = createCapability();

    expect('close' in capability).toBe(false);
    expect(Object.keys(capability)).toEqual([]);
    expect(Object.getOwnPropertyNames(CrawlerFileCapability.prototype).filter((name) => name !== 'constructor').sort()).toEqual(['read', 'save']);
  });
});
