import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_ORIGIN,
  addRow,
  fetchWorker,
  newscastRow,
  putAudio,
  uniqueUUID,
  useInMemorySupabase,
  type Row,
} from './http-harness.ts';

// The public share permalinks (GET /share/:token, GET /share/:token/audio) and the owner's three routes
// that manage them (PUT, GET, DELETE /newscasts/:id/share).

const supabase = useInMemorySupabase();

const TOKEN = '0189d3f2-4c1b-7c9a-9f2e-6b7c8d9e0f11';

interface PublicViewBody {
  version: number;
  title: string;
  parts: Array<{ index: number; durationMs: number; script: unknown[]; segments: unknown[] }>;
  hasSignalAudio: boolean;
  metadata: Record<string, unknown>;
}

/** A done newscast of OWNER with its audio stored, and optionally its share row */
async function sharedNewscast(options: { shared?: boolean; newscast?: Row; share?: Row } = {}): Promise<{ owner: string; id: string; newscast: Row }> {
  const owner = uniqueUUID();
  const newscast = addRow(supabase, 'newscasts', newscastRow({ user_uuid: owner, ...options.newscast }));
  const id = newscast.id as string;
  await putAudio(`${id}/part-1`, [1, 2, 3]);
  await putAudio(`${id}/part-2`, [4, 5, 6]);
  await putAudio(`${id}/signal`, [7, 8, 9]);
  if (options.shared ?? true) {
    addRow(supabase, 'newscast_shares', {
      token: TOKEN,
      newscast_id: id,
      user_uuid: owner,
      included_metadata: {},
      created_at: '2026-10-26T10:00:00.000Z',
      ...options.share,
    });
  }
  return { owner, id, newscast };
}

/** The public GET, with NO credential of any kind — that is the whole point. */
function sharePath(token: string, suffix = ''): string {
  return `/share/${token}${suffix}`;
}

function putShare(id: string, userUUID: string, body: unknown): Promise<Response> {
  return fetchWorker(`/newscasts/${id}/share`, { method: 'PUT', userUUID, body });
}

/** Every request the in-memory Supabase answered for a table */
function requestsTo(table: string): number {
  return supabase.requests.filter((request) => request.table === table).length;
}

describe('GET /share/:token — the public view', () => {
  it('serves a shared newscast to a caller with no credential at all', async () => {
    await sharedNewscast();

    const response = await fetchWorker(sharePath(TOKEN));

    expect(response.status).toBe(200);
    const body = await response.json() as PublicViewBody;
    expect(body.version).toBe(1);
    expect(body.title).toBe('이해가 새로운 병목이다');
    expect(body.parts.map((part) => part.index)).toEqual([1, 2]);
    expect(body.hasSignalAudio).toBe(true);
    // Nothing was published, so the card has nothing to render.
    expect(body.metadata).toEqual({});
  });

  it('answers only the allowlisted view: no owner, error, details, request or audio keys', async () => {
    const { owner, id } = await sharedNewscast({
      newscast: { error: 'SECRET-ERROR-MESSAGE', error_code: 'pipeline_failed', title_override: '고친 제목' },
      share: { included_metadata: { displayName: '차진혁', email: 'user@example.com', showModel: true, showSourceLinks: true, showCreatedAt: true } },
    });

    const response = await fetchWorker(sharePath(TOKEN));
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(Object.keys(body).sort()).toEqual(['hasSignalAudio', 'metadata', 'parts', 'title', 'version']);
    expect(body.title).toBe('고친 제목');
    for (const secret of [
      owner,
      id,
      'user_uuid',
      'SECRET-ERROR-MESSAGE',
      'error',
      'details',
      'SECRET-FAILURE-MESSAGE',
      'SECRET-CUSTOM-ARTICLE-BODY',
      'SECRET-ARTICLE-BODY',
      'audioKey',
      'signalAudioKey',
      'speaker1Voice',
      'Charon',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(body.metadata).toEqual({
      sharedBy: { displayName: '차진혁', email: 'user@example.com' },
      model: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' },
      sources: [
        {
          title: '이해가 새로운 병목이다',
          originalUrl: 'https://example.com/article',
          discussionUrl: 'https://news.hada.io/topic?id=1',
        },
      ],
      createdAt: '2026-10-26T09:30:00.000Z',
    });
    // The newscast read names its columns, and the owner is not one of them
    const newscastRead = supabase.requests.find((request) => request.table === 'newscasts');
    expect(newscastRead?.query.get('select')).toBe('status,request,result,details,title_override,created_at');
  });

  it('answers no-store, noindex and a wildcard CORS origin', async () => {
    await sharedNewscast();

    // An origin ALLOWED_ORIGINS does not list: only these routes may answer it.
    const response = await fetchWorker(sharePath(TOKEN), { headers: { Origin: 'https://share-viewer.example.org' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('answers the same 404 for an unknown token, a revoked one, and a deleted newscast', async () => {
    await sharedNewscast();

    const unknown = await fetchWorker(sharePath('nope'));
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json();
    expect(unknownBody).toEqual({ error: 'share_not_found', error_description: 'This share link is no longer available.' });

    // The newscast is gone, but the row survived: still the same 404.
    supabase.tables.newscasts = [];
    const missingNewscast = await fetchWorker(sharePath(TOKEN));
    expect(missingNewscast.status).toBe(404);
    expect(await missingNewscast.json()).toEqual(unknownBody);

    supabase.tables.newscast_shares = [];
    const revoked = await fetchWorker(sharePath(TOKEN));
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).toEqual(unknownBody);
    expect(revoked.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('answers 404 while the newscast is not done', async () => {
    for (const status of ['running', 'error']) {
      supabase.tables = {};
      await sharedNewscast({ newscast: { status, result: null } });
      expect((await fetchWorker(sharePath(TOKEN))).status).toBe(404);
    }
  });

  it('refuses every method but GET without reading anything, and a bare /share is no share route', async () => {
    await sharedNewscast();

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetchWorker(sharePath(TOKEN), { method });
      expect(response.status).toBe(404);
    }
    expect(supabase.requests).toEqual([]);

    const bare = await fetchWorker('/share');
    expect(bare.status).toBe(404);
    expect(await bare.json()).toEqual({ error: 'not_found', error_description: 'Endpoint not found' });
  });

  it('answers its own CORS preflight with the wildcard origin', async () => {
    const response = await fetchWorker(sharePath(TOKEN), { method: 'OPTIONS', headers: { Origin: 'https://share-viewer.example.org' } });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});

describe('GET /share/:token/audio', () => {
  it('streams a part with no credential, advertising ranges', async () => {
    await sharedNewscast();

    const response = await fetchWorker(sharePath(TOKEN, '/audio?part=1'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('serves the signal sting and a later part', async () => {
    await sharedNewscast();

    for (const [part, bytes] of [['2', [4, 5, 6]], ['signal', [7, 8, 9]]] as const) {
      const response = await fetchWorker(sharePath(TOKEN, `/audio?part=${part}`));
      expect(response.status).toBe(200);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(bytes);
    }
  });

  it('honours a byte range, so the viewer can seek', async () => {
    await sharedNewscast();

    const response = await fetchWorker(sharePath(TOKEN, '/audio?part=1'), { headers: { Range: 'bytes=1-2' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 1-2/3');
    expect(response.headers.get('Content-Length')).toBe('2');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3]);
  });

  it('answers 404 the moment the link is revoked, without reading the newscast', async () => {
    await sharedNewscast();
    expect((await fetchWorker(sharePath(TOKEN, '/audio?part=1'))).status).toBe(200);

    supabase.tables.newscast_shares = [];
    supabase.requests.length = 0;

    const revoked = await fetchWorker(sharePath(TOKEN, '/audio?part=1'));
    expect(revoked.status).toBe(404);
    expect(requestsTo('newscasts')).toBe(0);
  });

  it('re-checks the newscast status on EVERY request, not just at share time', async () => {
    await sharedNewscast();
    expect((await fetchWorker(sharePath(TOKEN, '/audio?part=1'))).status).toBe(200);

    supabase.tables.newscasts[0].status = 'running';

    expect((await fetchWorker(sharePath(TOKEN, '/audio?part=1'))).status).toBe(404);
  });

  it('answers 400 for a part that is not a positive integer in range', async () => {
    await sharedNewscast();

    const response = await fetchWorker(sharePath(TOKEN, '/audio?part=99'));

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_part');
  });
});

interface ShareStateBody {
  shared: boolean;
  token?: string;
  metadata?: Record<string, unknown>;
}

describe('the owner routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a link, reports it, and revokes it', async () => {
    const { owner, id } = await sharedNewscast({ shared: false });

    const created = await putShare(id, owner, { metadata: {} });
    expect(created.status).toBe(200);
    const { token } = await created.json() as { token: string };
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(supabase.tables.newscast_shares).toHaveLength(1);
    expect(supabase.tables.newscast_shares[0]).toMatchObject({ token, newscast_id: id, user_uuid: owner, included_metadata: {} });

    const state = await fetchWorker(`/newscasts/${id}/share`, { userUUID: owner });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ shared: true, token, metadata: {} });

    // The link works for a stranger with no session...
    expect((await fetchWorker(sharePath(token))).status).toBe(200);

    const revoked = await fetchWorker(`/newscasts/${id}/share`, { method: 'DELETE', userUUID: owner });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ removed: true });
    expect(supabase.tables.newscast_shares).toHaveLength(0);

    // ...and stops working the moment it is revoked.
    expect((await fetchWorker(sharePath(token))).status).toBe(404);
    expect((await fetchWorker(sharePath(token, '/audio?part=1'))).status).toBe(404);
  });

  it('reports an un-shared newscast as { shared: false }', async () => {
    const { owner, id } = await sharedNewscast({ shared: false });

    const response = await fetchWorker(`/newscasts/${id}/share`, { userUUID: owner });

    expect(response.status).toBe(200);
    expect(await response.json() as ShareStateBody).toEqual({ shared: false });
  });

  it('revokes idempotently — nothing to revoke is still a 200', async () => {
    const { owner, id } = await sharedNewscast({ shared: false });

    const response = await fetchWorker(`/newscasts/${id}/share`, { method: 'DELETE', userUUID: owner });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: false });
  });

  it('keeps the token when only the metadata changes', async () => {
    const { owner, id } = await sharedNewscast({ shared: false });
    const { token } = await (await putShare(id, owner, { metadata: {} })).json() as { token: string };

    const updated = await putShare(id, owner, {
      metadata: { displayName: '차진혁', showModel: true, showSourceLinks: true, showCreatedAt: true },
    });
    expect((await updated.json() as { token: string }).token).toBe(token);
    expect(supabase.tables.newscast_shares).toHaveLength(1);

    const view = await (await fetchWorker(sharePath(token))).json() as { metadata: Record<string, unknown> };
    expect(view.metadata).toEqual({
      sharedBy: { displayName: '차진혁' },
      model: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' },
      sources: [
        {
          title: '이해가 새로운 병목이다',
          originalUrl: 'https://example.com/article',
          discussionUrl: 'https://news.hada.io/topic?id=1',
        },
      ],
      createdAt: '2026-10-26T09:30:00.000Z',
    });
    expect(JSON.stringify(view)).not.toContain('SECRET-ARTICLE-BODY');
  });

  it('kills the previous URL when the owner re-issues the link', async () => {
    const { owner, id } = await sharedNewscast({ shared: false });
    const { token: first } = await (await putShare(id, owner, { metadata: {} })).json() as { token: string };

    const { token: second } = await (await putShare(id, owner, { regenerate: true, metadata: {} })).json() as { token: string };

    expect(second).not.toBe(first);
    // One live link per newscast, never two.
    expect(supabase.tables.newscast_shares).toHaveLength(1);
    expect((await fetchWorker(sharePath(first))).status).toBe(404);
    expect((await fetchWorker(sharePath(first, '/audio?part=1'))).status).toBe(404);
    expect((await fetchWorker(sharePath(second))).status).toBe(200);
  });

  it('answers 409 job_not_shareable for a newscast that is not finished, and creates nothing', async () => {
    for (const status of ['running', 'error']) {
      const { owner, id } = await sharedNewscast({ shared: false, newscast: { status, result: null } });

      const response = await putShare(id, owner, { metadata: {} });

      expect(response.status).toBe(409);
      expect((await response.json() as { error: string }).error).toBe('job_not_shareable');
      expect(supabase.tables.newscast_shares ?? []).toHaveLength(0);
    }
  });

  it("answers 404 — never 403 — on another user's newscast", async () => {
    const { id } = await sharedNewscast();
    const stranger = uniqueUUID();

    const put = await putShare(id, stranger, { metadata: {} });
    expect(put.status).toBe(404);
    expect((await put.json() as { error: string }).error).toBe('job_not_found');
    expect((await fetchWorker(`/newscasts/${id}/share`, { userUUID: stranger })).status).toBe(404);
    expect((await fetchWorker(`/newscasts/${id}/share`, { method: 'DELETE', userUUID: stranger })).status).toBe(404);

    // The owner's link is untouched by all three attempts.
    expect(supabase.tables.newscast_shares).toHaveLength(1);
    expect(supabase.tables.newscast_shares[0].token).toBe(TOKEN);
  });

  it('answers 404 for an unknown newscast, and for an ID that is not a UUID', async () => {
    for (const id of [uniqueUUID(), 'missing']) {
      const response = await putShare(id, uniqueUUID(), { metadata: {} });
      expect(response.status).toBe(404);
    }
  });

  it('drops unknown metadata keys instead of publishing them', async () => {
    const { owner, id } = await sharedNewscast({ shared: false });

    await putShare(id, owner, { metadata: { showError: true, showKeyIdentity: true, userId: uniqueUUID() } });

    expect(supabase.tables.newscast_shares[0].included_metadata).toEqual({});
  });

  it('survives a body that is not JSON at all', async () => {
    const { owner, id } = await sharedNewscast({ shared: false });

    expect((await putShare(id, owner, 'not json')).status).toBe(200);
  });

  it('answers 500 — never a fake 404 — when the shares table cannot be read', async () => {
    // A link must not report itself REVOKED (a permanent answer a viewer renders
    // and a scraper caches) because of an outage, and nothing may become public by
    // accident either.
    const { owner, id } = await sharedNewscast();
    supabase.intercept = (request) =>
      request.table === 'newscast_shares'
        ? { statusCode: 404, data: { code: '42P01', details: null, hint: null, message: 'relation "newscast_shares" does not exist' } }
        : undefined;

    const view = await fetchWorker(sharePath(TOKEN));
    expect(view.status).toBe(500);
    expect((await view.json() as { error: string }).error).toBe('share_unavailable');
    expect(view.headers.get('X-Robots-Tag')).toBe('noindex');

    expect((await fetchWorker(sharePath(TOKEN, '/audio?part=1'))).status).toBe(500);

    const put = await putShare(id, owner, { metadata: {} });
    expect(put.status).toBe(500);
    expect((await put.json() as { error: string }).error).toBe('share_unavailable');

    expect((await fetchWorker(`/newscasts/${id}/share`, { method: 'DELETE', userUUID: owner })).status).toBe(500);
    expect((await fetchWorker(`/newscasts/${id}/share`, { userUUID: owner })).status).toBe(500);
  });

  it('never writes a whole token to a log line', async () => {
    const { owner, id } = await sharedNewscast({ shared: false });
    const written: string[] = [];
    for (const level of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, level).mockImplementation((...values: unknown[]) => {
        written.push(values.map((value) => JSON.stringify(value)).join(' '));
      });
    }

    const { token } = await (await putShare(id, owner, { metadata: {} })).json() as { token: string };
    await fetchWorker(sharePath(token));
    await fetchWorker(sharePath(token, '/audio?part=1'));
    await fetchWorker(sharePath(token, '/audio?part=99'));
    await fetchWorker(sharePath('0189d3f2-0000-4000-8000-000000000000'));

    const logged = written.join('\n');
    expect(logged).toContain(token.slice(0, 8));
    expect(logged).not.toContain(token);
  });

  it('answers the CORS headers of ALLOWED_ORIGINS on the owner routes', async () => {
    const { owner, id } = await sharedNewscast({ shared: false });

    const response = await fetchWorker(`/newscasts/${id}/share`, { userUUID: owner, headers: { Origin: ALLOWED_ORIGIN } });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
  });
});
