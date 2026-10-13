import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import { SUPABASE_ORIGIN, testEnvironment, uniqueUUID, workerRequest } from './runtime-harness.ts';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

async function storeFile(options: { userUUID: string; name?: string | null; contentType?: string; content?: string; expiresAt?: string | null; runID?: string | null }) {
  const id = uniqueUUID();
  const objectKey = `${options.userUUID}/${id}`;
  const content = options.content ?? 'file content';
  await testEnvironment.CRAWLER_FILES.put(objectKey, content);
  supabase.tables.crawler_files ??= [];
  supabase.tables.crawler_files.push({
    id,
    user_uuid: options.userUUID,
    run_id: options.runID ?? null,
    crawler_id: uniqueUUID(),
    object_key: objectKey,
    name: options.name === undefined ? null : options.name,
    content_type: options.contentType ?? 'application/octet-stream',
    size: new TextEncoder().encode(content).byteLength,
    expires_at: options.expiresAt === undefined ? new Date(Date.now() + 60_000).toISOString() : options.expiresAt,
    created_at: new Date().toISOString(),
  });
  return { id, objectKey };
}

// Reads the body every time: an R2 body left open breaks the isolated storage of the test
async function download(id: string, userUUID: string | null) {
  const response = await SELF.fetch(await workerRequest(`/files/${id}`, { userUUID }));
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
}

describe('GET /files/:id', () => {
  it('sends the file of the user with its headers', async () => {
    const user = uniqueUUID();
    const { id } = await storeFile({ userUUID: user, name: "episode 1 (final)'s.mp3", contentType: 'audio/mpeg', content: 'mp3 bytes' });

    const response = await download(id, user);

    expect(response.status).toBe(200);
    expect(response.text).toBe('mp3 bytes');
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(response.headers.get('Content-Length')).toBe('9');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''episode%201%20%28final%29%27s.mp3");
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('Content-Disposition');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  });

  it('percent-encodes a name that is not ASCII', async () => {
    const user = uniqueUUID();
    const { id } = await storeFile({ userUUID: user, name: '뉴스.mp3' });

    const response = await download(id, user);

    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('뉴스.mp3')}`);
  });

  it('sends no Content-Disposition for a file without a name', async () => {
    const user = uniqueUUID();
    const { id } = await storeFile({ userUUID: user, name: null });

    const response = await download(id, user);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Access-Control-Expose-Headers')).toBeNull();
  });

  it('sends a file of a scheduled run, which has no expiry', async () => {
    const user = uniqueUUID();
    const { id } = await storeFile({ userUUID: user, expiresAt: null, runID: uniqueUUID() });

    expect((await download(id, user)).status).toBe(200);
  });

  it('answers the same 404 for another user, an expired file, a missing file, a missing object and an invalid ID', async () => {
    const owner = uniqueUUID();
    const { id } = await storeFile({ userUUID: owner });
    const expired = await storeFile({ userUUID: owner, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const withoutObject = await storeFile({ userUUID: owner });
    await testEnvironment.CRAWLER_FILES.delete(withoutObject.objectKey);

    for (const [fileID, userUUID] of [
      [id, uniqueUUID()],
      [expired.id, owner],
      [uniqueUUID(), owner],
      [withoutObject.id, owner],
      ['not-a-uuid', owner],
    ]) {
      const response = await download(fileID, userUUID);
      expect(response.status, fileID).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found', error_description: 'File not found' });
    }
  });

  it('answers 401 without authentication and 405 for another method', async () => {
    const user = uniqueUUID();
    const { id } = await storeFile({ userUUID: user });

    expect((await download(id, null)).status).toBe(401);
    const deleted = await SELF.fetch(await workerRequest(`/files/${id}`, { method: 'DELETE', userUUID: user }));
    await deleted.text();
    expect(deleted.status).toBe(405);
    expect(deleted.headers.get('Allow')).toBe('GET');
  });
});
