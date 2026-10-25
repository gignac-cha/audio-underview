import { describe, expect, it } from 'vitest';
import { verifyJWT } from '@audio-underview/worker-tools';
import {
  ALLOWED_ORIGIN,
  JWT_SECRET,
  addRow,
  fetchWorker,
  newscastRow,
  putAudio,
  sessionToken,
  uniqueUUID,
  useInMemorySupabase,
  type Row,
} from './http-harness.ts';

// The owner's routes under /newscasts: who may call them, whose newscasts they reach, and the audio
// they serve with ranges.

const supabase = useInMemorySupabase();

function addNewscast(overrides: Row = {}): Row {
  return addRow(supabase, 'newscasts', newscastRow(overrides));
}

async function mintMediaToken(id: string, userUUID: string): Promise<{ token: string; expiresIn: number }> {
  const response = await fetchWorker(`/newscasts/${id}/media-token`, { method: 'POST', userUUID });
  expect(response.status).toBe(200);
  return await response.json() as { token: string; expiresIn: number };
}

const OWNER_ROUTES: Array<{ name: string; method: string; path: (id: string) => string; body?: unknown }> = [
  { name: 'GET /newscasts', method: 'GET', path: () => '/newscasts' },
  { name: 'GET /newscasts/:id', method: 'GET', path: (id) => `/newscasts/${id}` },
  { name: 'POST /newscasts/:id/title', method: 'POST', path: (id) => `/newscasts/${id}/title`, body: { title: 'x' } },
  { name: 'POST /newscasts/:id/media-token', method: 'POST', path: (id) => `/newscasts/${id}/media-token` },
  { name: 'GET /newscasts/:id/audio', method: 'GET', path: (id) => `/newscasts/${id}/audio?part=1` },
  { name: 'PUT /newscasts/:id/share', method: 'PUT', path: (id) => `/newscasts/${id}/share`, body: { metadata: {} } },
  { name: 'GET /newscasts/:id/share', method: 'GET', path: (id) => `/newscasts/${id}/share` },
  { name: 'DELETE /newscasts/:id/share', method: 'DELETE', path: (id) => `/newscasts/${id}/share` },
];

describe('authentication', () => {
  it.each(OWNER_ROUTES)('answers 401 to $name without a session, reading nothing', async ({ method, path, body }) => {
    const newscast = addNewscast();

    const response = await fetchWorker(path(newscast.id as string), { method, body });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized', error_description: 'Valid authentication is required' });
    expect(supabase.requests).toEqual([]);
  });

  it('answers 401 to a JWT signed with another secret, an expired one, and one whose subject is not a UUID', async () => {
    const user = uniqueUUID();
    const now = Math.floor(Date.now() / 1000);
    for (const token of [
      await sessionToken(user, {}, 'another-fake-jwt-secret'),
      await sessionToken(user, { iat: now - 7200, exp: now - 3600 }),
      await sessionToken('not-a-uuid'),
    ]) {
      const response = await fetchWorker('/newscasts', { authorization: `Bearer ${token}` });
      expect(response.status).toBe(401);
    }
    expect(supabase.requests).toEqual([]);
  });

  it('refuses a token with a jid claim as a session, though JWT_SECRET signed it', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });
    const token = await sessionToken(user, { jid: newscast.id });

    for (const path of ['/newscasts', `/newscasts/${newscast.id}`, `/newscasts/${newscast.id}/audio?part=1`]) {
      const response = await fetchWorker(path, { authorization: `Bearer ${token}` });
      expect(response.status).toBe(401);
    }
    expect(supabase.requests).toEqual([]);
  });

  it('answers 404 Endpoint not found to a path outside /newscasts and /share/', async () => {
    const response = await fetchWorker('/crawlers', { userUUID: uniqueUUID() });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', error_description: 'Endpoint not found' });
  });

  it('answers 405 to a method a route does not have', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });

    const response = await fetchWorker(`/newscasts/${newscast.id}/title`, { userUUID: user });

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('media tokens', () => {
  it('mints a token for a newscast of the caller, valid for an hour, that JWT_SECRET does not verify', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });

    const { token, expiresIn } = await mintMediaToken(newscast.id as string, user);

    expect(expiresIn).toBe(3600);
    expect(await verifyJWT(token, JWT_SECRET)).toBeNull();
  });

  it("answers 404 for an unknown newscast and for another user's newscast", async () => {
    const newscast = addNewscast();

    for (const id of [uniqueUUID(), newscast.id as string, 'not-a-uuid']) {
      const response = await fetchWorker(`/newscasts/${id}/media-token`, { method: 'POST', userUUID: uniqueUUID() });
      expect(response.status).toBe(404);
      expect((await response.json() as { error: string }).error).toBe('job_not_found');
    }
  });

  it('streams the audio for a media token in the query string, with ?part= and for the signal', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });
    const id = newscast.id as string;
    await putAudio(`${id}/part-1`, [1, 2, 3]);
    await putAudio(`${id}/part-2`, [4, 5, 6]);
    await putAudio(`${id}/signal`, [7, 8, 9]);
    const { token } = await mintMediaToken(id, user);
    const encoded = encodeURIComponent(token);

    for (const [query, bytes] of [['', [1, 2, 3]], ['part=2&', [4, 5, 6]], ['part=signal&', [7, 8, 9]]] as const) {
      const response = await fetchWorker(`/newscasts/${id}/audio?${query}token=${encoded}`);
      expect(response.status).toBe(200);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(bytes);
    }
  });

  it('refuses a media token minted for a DIFFERENT newscast, before reading anything', async () => {
    const user = uniqueUUID();
    const first = addNewscast({ user_uuid: user });
    const second = addNewscast({ user_uuid: user });
    await putAudio(`${second.id}/part-1`, [1, 2, 3]);
    const { token } = await mintMediaToken(first.id as string, user);
    supabase.requests.length = 0;

    const response = await fetchWorker(`/newscasts/${second.id}/audio?part=1&token=${encodeURIComponent(token)}`);

    expect(response.status).toBe(401);
    expect(supabase.requests).toEqual([]);
  });

  it('refuses the SESSION credential in ?token=', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });
    await putAudio(`${newscast.id}/part-1`, [1, 2, 3]);

    const response = await fetchWorker(`/newscasts/${newscast.id}/audio?token=${encodeURIComponent(await sessionToken(user))}`);

    expect(response.status).toBe(401);
  });

  it('does not let a media token authorize anything but its newscast audio', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });
    const { token } = await mintMediaToken(newscast.id as string, user);

    // As a bearer
    for (const path of ['/newscasts', `/newscasts/${newscast.id}`, `/newscasts/${newscast.id}/audio`]) {
      expect((await fetchWorker(path, { authorization: `Bearer ${token}` })).status).toBe(401);
    }
    // In the query of a route that is not the audio
    expect((await fetchWorker(`/newscasts/${newscast.id}?token=${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await fetchWorker(`/newscasts/${newscast.id}/share?token=${encodeURIComponent(token)}`)).status).toBe(401);
  });
});

describe('ownership', () => {
  it("answers 404 — never 403 — on another user's newscast, as for an unknown one", async () => {
    const newscast = addNewscast();
    const stranger = uniqueUUID();

    const theirs = await fetchWorker(`/newscasts/${newscast.id}`, { userUUID: stranger });
    const unknownID = uniqueUUID();
    const unknown = await fetchWorker(`/newscasts/${unknownID}`, { userUUID: stranger });

    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    const theirsBody = await theirs.json() as { error: string; error_description: string };
    const unknownBody = await unknown.json() as { error: string; error_description: string };
    expect(theirsBody.error).toBe('not_found');
    expect(unknownBody.error).toBe(theirsBody.error);
    expect(unknownBody.error_description.replace(unknownID, newscast.id as string)).toBe(theirsBody.error_description);
  });

  it('answers the owner the newscast', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });

    const response = await fetchWorker(`/newscasts/${newscast.id}`, { userUUID: user });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: newscast.id, status: 'done' });
  });

  it('answers 404 for a newscast ID that is not a UUID, without a query', async () => {
    const response = await fetchWorker('/newscasts/not-a-uuid', { userUUID: uniqueUUID() });

    expect(response.status).toBe(404);
    expect(supabase.requests).toEqual([]);
  });

  it("lists ONLY the caller's newscasts, in { data }", async () => {
    const user = uniqueUUID();
    const mine = addNewscast({ user_uuid: user });
    addNewscast();

    const response = await fetchWorker('/newscasts', { userUUID: user });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((summary) => summary.id)).toEqual([mine.id]);
  });

  it("answers 404 on another user's audio, as for audio not stored yet", async () => {
    const newscast = addNewscast();
    await putAudio(`${newscast.id}/part-1`, [1, 2, 3]);

    const response = await fetchWorker(`/newscasts/${newscast.id}/audio?part=1`, { userUUID: uniqueUUID() });

    expect(response.status).toBe(404);
    expect((await response.json() as { error: string }).error).toBe('not_ready');
  });

  it("answers 404 when another user renames someone else's newscast, changing nothing", async () => {
    const newscast = addNewscast();

    const response = await fetchWorker(`/newscasts/${newscast.id}/title`, { method: 'POST', userUUID: uniqueUUID(), body: { title: 'Hijacked' } });

    expect(response.status).toBe(404);
    expect((await response.json() as { error: string }).error).toBe('job_not_found');
    expect(supabase.tables.newscasts[0].title_override).toBeNull();
  });
});

describe('POST /newscasts/:id/title', () => {
  it.each([
    ['no title', {}],
    ['a body that is not JSON', 'not json'],
    ['an empty title', { title: '' }],
    ['a title of spaces', { title: '   ' }],
    ['a title over 200 characters', { title: 'a'.repeat(201) }],
  ])('answers 400 invalid_title for %s', async (_name, body) => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });

    const response = await fetchWorker(`/newscasts/${newscast.id}/title`, { method: 'POST', userUUID: user, body });

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_title');
  });

  it('trims the title, stores it as the override, and accepts 200 characters', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });

    const response = await fetchWorker(`/newscasts/${newscast.id}/title`, { method: 'POST', userUUID: user, body: { title: '  Corrected Title  ' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: newscast.id, title: 'Corrected Title' });
    expect(supabase.tables.newscasts[0].title_override).toBe('Corrected Title');

    const longest = 'a'.repeat(200);
    const longestResponse = await fetchWorker(`/newscasts/${newscast.id}/title`, { method: 'POST', userUUID: user, body: { title: longest } });
    expect(longestResponse.status).toBe(200);
    expect(await longestResponse.json()).toEqual({ id: newscast.id, title: longest });
  });

  it('corrects the title of a newscast that failed, leaving its status alone', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user, status: 'error', result: null });

    const response = await fetchWorker(`/newscasts/${newscast.id}/title`, { method: 'POST', userUUID: user, body: { title: 'Fixed After Failure' } });

    expect(response.status).toBe(200);
    expect(supabase.tables.newscasts[0].status).toBe('error');
  });
});

describe('GET /newscasts/:id/audio', () => {
  async function ownedNewscastWithAudio(): Promise<{ user: string; id: string }> {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });
    const id = newscast.id as string;
    await putAudio(`${id}/part-1`, [1, 2, 3, 4, 5]);
    await putAudio(`${id}/part-2`, [6, 7]);
    await putAudio(`${id}/signal`, [8]);
    return { user, id };
  }

  it('serves a part to its owner over the Authorization header, advertising ranges', async () => {
    const { user, id } = await ownedNewscastWithAudio();

    const response = await fetchWorker(`/newscasts/${id}/audio?part=1`, { userUUID: user });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Length')).toBe('5');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    // The ownership check reads the id alone, never the request, details and result JSON
    const reads = supabase.requestsOf('GET', 'newscasts');
    expect(reads.map((read) => read.query.get('select'))).toEqual(['id']);
    expect(reads[0].query.get('user_uuid')).toBe(`eq.${user}`);
  });

  it.each([
    ['bytes=1-2', 'bytes 1-2/5', [2, 3]],
    ['bytes=3-', 'bytes 3-4/5', [4, 5]],
    ['bytes=-2', 'bytes 3-4/5', [4, 5]],
    ['bytes=2-99', 'bytes 2-4/5', [3, 4, 5]],
  ])('answers 206 with Content-Range for Range %s', async (range, contentRange, bytes) => {
    const { user, id } = await ownedNewscastWithAudio();

    const response = await fetchWorker(`/newscasts/${id}/audio?part=1`, { userUUID: user, headers: { Range: range } });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Length')).toBe(String(bytes.length));
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(bytes);
  });

  it('serves the whole object for a Range it cannot satisfy', async () => {
    const { user, id } = await ownedNewscastWithAudio();

    const response = await fetchWorker(`/newscasts/${id}/audio?part=1`, { userUUID: user, headers: { Range: 'bytes=9-12' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
  });

  it('serves a later part, the signal, and part 1 without ?part', async () => {
    const { user, id } = await ownedNewscastWithAudio();

    for (const [query, bytes] of [['?part=2', [6, 7]], ['?part=signal', [8]], ['', [1, 2, 3, 4, 5]]] as const) {
      const response = await fetchWorker(`/newscasts/${id}/audio${query}`, { userUUID: user });
      expect(response.status).toBe(200);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(bytes);
    }
  });

  it('answers 404 not_ready until the audio is stored, and 400 for a bad part', async () => {
    const { user, id } = await ownedNewscastWithAudio();

    const missing = await fetchWorker(`/newscasts/${id}/audio?part=3`, { userUUID: user });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: string }).error).toBe('not_ready');

    const bad = await fetchWorker(`/newscasts/${id}/audio?part=99`, { userUUID: user });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('invalid_part');
  });
});

describe('CORS', () => {
  it('answers the preflight of an allowed origin with the methods and the Authorization header', async () => {
    const response = await fetchWorker(`/newscasts/${uniqueUUID()}/share`, { method: 'OPTIONS', headers: { Origin: ALLOWED_ORIGIN } });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
  });

  it('allows no origin that ALLOWED_ORIGINS does not list', async () => {
    const response = await fetchWorker('/newscasts', { method: 'OPTIONS', headers: { Origin: 'https://elsewhere.example.org' } });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('adds the CORS headers to answers, errors and audio for an allowed origin', async () => {
    const user = uniqueUUID();
    const newscast = addNewscast({ user_uuid: user });
    await putAudio(`${newscast.id}/part-1`, [1, 2, 3]);
    const headers = { Origin: ALLOWED_ORIGIN };

    const list = await fetchWorker('/newscasts', { userUUID: user, headers });
    const unauthorized = await fetchWorker('/newscasts', { headers });
    const audio = await fetchWorker(`/newscasts/${newscast.id}/audio?part=1`, { userUUID: user, headers });

    for (const response of [list, unauthorized, audio]) {
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    }
    expect(unauthorized.status).toBe(401);
    expect(audio.status).toBe(200);
  });
});
