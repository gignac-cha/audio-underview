import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import { SUPABASE_ORIGIN, WORKER_URL, testEnvironment, uniqueUUID, workerRequest } from './runtime-harness.ts';

// GET /files/:id: the cases beyond files-route.test.ts.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);
const FUTURE = '2099-01-01T00:00:00.000Z';

async function storeFile(options: {
  userUUID: string;
  name?: string | null;
  contentType?: string;
  content?: string | Uint8Array;
  expiresAt?: string | null;
  runID?: string | null;
}) {
  const id = uniqueUUID();
  const objectKey = `${options.userUUID}/${id}`;
  const content = options.content ?? 'file content';
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  await testEnvironment.CRAWLER_FILES.put(objectKey, bytes);
  supabase.tables.crawler_files ??= [];
  supabase.tables.crawler_files.push({
    id,
    user_uuid: options.userUUID,
    run_id: options.runID ?? null,
    crawler_id: null,
    object_key: objectKey,
    name: options.name === undefined ? null : options.name,
    content_type: options.contentType ?? 'application/octet-stream',
    size: bytes.byteLength,
    expires_at: options.expiresAt === undefined ? FUTURE : options.expiresAt,
    created_at: '2026-10-13T00:00:00.000Z',
  });
  return { id, objectKey };
}

// Reads the body every time: an R2 body left open breaks the isolated storage of the test
async function download(path: string, userUUID: string | null, method = 'GET') {
  const response = await SELF.fetch(await workerRequest(path, { method, userUUID }));
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, text: new TextDecoder().decode(bytes) };
}

describe('GET /files/:id', () => {
  it('sends the bytes as they are, with their length', async () => {
    const user = uniqueUUID();
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
    const { id } = await storeFile({ userUUID: user, contentType: 'application/octet-stream', content: bytes });

    const response = await download(`/files/${id}`, user);

    expect(response.status).toBe(200);
    expect(response.bytes).toEqual(bytes);
    expect(response.headers.get('Content-Length')).toBe('7');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('percent-encodes the name as UTF-8 and keeps its quotes, semicolons and backslashes out of the header structure', async () => {
    const user = uniqueUUID();
    const { id } = await storeFile({ userUUID: user, name: 'a"b;c\\d e.txt' });

    const response = await download(`/files/${id}`, user);

    const disposition = response.headers.get('Content-Disposition') ?? '';
    expect(disposition).toBe("attachment; filename*=UTF-8''a%22b%3Bc%5Cd%20e.txt");
    expect(disposition.split(';')).toHaveLength(2);
  });

  it('percent-encodes the characters encodeURIComponent leaves, so the header holds ASCII only', async () => {
    const user = uniqueUUID();
    const name = "한국어 이름 (1) 'a' *b*.mp3";
    const { id } = await storeFile({ userUUID: user, name });

    const response = await download(`/files/${id}`, user);

    const disposition = response.headers.get('Content-Disposition') ?? '';
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    const encodedName = disposition.split("''")[1] ?? '';
    expect(encodedName).not.toMatch(/['()*]/);
    expect(decodeURIComponent(encodedName)).toBe(name);
  });

  it('sends a file whose stored type holds text beyond ASCII instead of failing', async () => {
    const user = uniqueUUID();
    // The type may hold any text after the semicolon when it is saved
    const { id } = await storeFile({ userUUID: user, contentType: 'text/plain; note=é中' });

    const response = await download(`/files/${id}`, user);

    expect(response.status).toBe(200);
    expect(response.text).toBe('file content');
    expect(response.headers.get('Content-Type')).toMatch(/^text\/plain/);
  });

  it('sends a file of a scheduled run, which has no expiry', async () => {
    const user = uniqueUUID();
    const { id } = await storeFile({ userUUID: user, expiresAt: null, runID: uniqueUUID() });

    expect((await download(`/files/${id}`, user)).status).toBe(200);
  });

  it('answers 404 File not found, the same, for a file of another user, an expired file, a missing object, an unknown ID and a malformed one', async () => {
    const owner = uniqueUUID();
    const { id } = await storeFile({ userUUID: owner });
    const expired = await storeFile({ userUUID: owner, expiresAt: '2020-01-01T00:00:00.000Z' });
    const withoutObject = await storeFile({ userUUID: owner });
    await testEnvironment.CRAWLER_FILES.delete(withoutObject.objectKey);

    for (const [fileID, userUUID] of [
      [id, uniqueUUID()],
      [expired.id, owner],
      [withoutObject.id, owner],
      [uniqueUUID(), owner],
      ['not-a-uuid', owner],
      [`${id}x`, owner],
    ]) {
      const response = await download(`/files/${fileID}`, userUUID);
      expect(response.status, fileID).toBe(404);
      expect(JSON.parse(response.text), fileID).toEqual({ error: 'not_found', error_description: 'File not found' });
    }
  });

  it('answers 401 without a valid token, sends nothing of the file and reads nothing', async () => {
    const owner = uniqueUUID();
    const { id } = await storeFile({ userUUID: owner });
    supabase.requests.length = 0;

    const withoutToken = await download(`/files/${id}`, null);
    const garbage = await SELF.fetch(new Request(`${WORKER_URL}/files/${id}`, { headers: { Origin: 'https://example.com', Authorization: 'Bearer garbage' } }));
    const garbageText = await garbage.text();

    expect(withoutToken.status).toBe(401);
    expect(withoutToken.text).not.toContain('file content');
    expect(garbage.status).toBe(401);
    expect(garbageText).not.toContain('file content');
    expect(supabase.requests).toEqual([]);
  });

  it('answers 405 to the other methods', async () => {
    const owner = uniqueUUID();
    const { id } = await storeFile({ userUUID: owner });

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await download(`/files/${id}`, owner, method);
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toContain('GET');
    }
  });

  it('does not take /files without an ID or with a longer path for a file', async () => {
    const owner = uniqueUUID();
    const { id } = await storeFile({ userUUID: owner });

    for (const path of ['/files', '/files/', `/files/${id}/extra`]) {
      const response = await download(path, owner);
      expect(response.status, path).toBe(404);
      expect(JSON.parse(response.text).error_description, path).toBe('Endpoint not found');
    }
  });
});
