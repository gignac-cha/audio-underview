import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import { SUPABASE_ORIGIN, addCrawler, crawlerRow, uniqueUUID, workerRequest } from './runtime-harness.ts';

// environment_variable_names of POST /crawlers and PUT /crawlers/:id: the names of the account
// environment variables a crawler declares.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

const ARRAY_MESSAGE = "Field 'environment_variable_names' must be an array of strings";
const NAME_MESSAGE = 'Environment variable name must match ^[A-Z_][A-Z0-9_]{0,63}$';
const DUPLICATES_MESSAGE = "Field 'environment_variable_names' must not contain duplicates";
const COUNT_MESSAGE = "Field 'environment_variable_names' must not exceed 100 names";

function names(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `NAME_${index}`);
}

const INVALID_NAMES: [string, unknown, string][] = [
  ['a string', 'API_KEY', ARRAY_MESSAGE],
  ['null', null, ARRAY_MESSAGE],
  ['an object', { API_KEY: true }, ARRAY_MESSAGE],
  ['an array with a number', ['API_KEY', 5], ARRAY_MESSAGE],
  ['an array with null', [null], ARRAY_MESSAGE],
  ['a lowercase name', ['api_key'], NAME_MESSAGE],
  ['an empty name', [''], NAME_MESSAGE],
  ['a name starting with a digit', ['1_KEY'], NAME_MESSAGE],
  ['a name with a dash', ['API-KEY'], NAME_MESSAGE],
  ['a name of 65 characters', [`A${'B'.repeat(64)}`], NAME_MESSAGE],
  ['a duplicate name', ['API_KEY', 'OTHER', 'API_KEY'], DUPLICATES_MESSAGE],
  ['101 names', names(101), COUNT_MESSAGE],
];

function webCrawlerBody(extra: Record<string, unknown> = {}) {
  return { name: 'Crawler', url_pattern: '^https://example\\.com/', code: '(body) => body', ...extra };
}

async function send(path: string, method: string, userUUID: string, body: unknown) {
  const response = await SELF.fetch(await workerRequest(path, { method, userUUID, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe('POST /crawlers environment_variable_names', () => {
  it('saves the declared names and answers them in the crawler', async () => {
    const user = uniqueUUID();

    const { status, body } = await send('/crawlers', 'POST', user, webCrawlerBody({ environment_variable_names: ['API_KEY', '_PRIVATE', 'TOKEN_2'] }));

    expect(status).toBe(201);
    expect(body.environment_variable_names).toEqual(['API_KEY', '_PRIVATE', 'TOKEN_2']);
    expect(supabase.tables.crawlers).toEqual([expect.objectContaining({ id: body.id, user_uuid: user, environment_variable_names: ['API_KEY', '_PRIVATE', 'TOKEN_2'] })]);
  });

  it('saves no names when the field is absent', async () => {
    const { status, body } = await send('/crawlers', 'POST', uniqueUUID(), webCrawlerBody());

    expect(status).toBe(201);
    expect(body.environment_variable_names).toEqual([]);
    expect(supabase.requestsOf('POST', 'crawlers')[0].body).toMatchObject({ environment_variable_names: [] });
  });

  it('accepts 100 names and a name of 64 characters', async () => {
    const longest = `A${'B'.repeat(63)}`;

    const many = await send('/crawlers', 'POST', uniqueUUID(), webCrawlerBody({ environment_variable_names: names(100) }));
    const long = await send('/crawlers', 'POST', uniqueUUID(), webCrawlerBody({ environment_variable_names: [longest] }));

    expect(many.status).toBe(201);
    expect(many.body.environment_variable_names).toHaveLength(100);
    expect(long.status).toBe(201);
    expect(long.body.environment_variable_names).toEqual([longest]);
  });

  it.each(INVALID_NAMES)('answers 400 for %s, saving nothing', async (_, value, message) => {
    const { status, body } = await send('/crawlers', 'POST', uniqueUUID(), webCrawlerBody({ environment_variable_names: value }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request', error_description: message });
    expect(supabase.requests).toEqual([]);
  });
});

describe('PUT /crawlers/:id environment_variable_names', () => {
  function savedCrawler(environmentVariableNames: string[]) {
    const owner = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: owner, type: 'web', url_pattern: '.*', environment_variable_names: environmentVariableNames }));
    return { crawler, owner };
  }

  it('replaces the declared names', async () => {
    const { crawler, owner } = savedCrawler(['OLD_KEY']);

    const { status, body } = await send(`/crawlers/${crawler.id}`, 'PUT', owner, webCrawlerBody({ environment_variable_names: ['NEW_KEY', 'OTHER_KEY'] }));

    expect(status).toBe(200);
    expect(body.environment_variable_names).toEqual(['NEW_KEY', 'OTHER_KEY']);
    expect(supabase.tables.crawlers[0].environment_variable_names).toEqual(['NEW_KEY', 'OTHER_KEY']);
  });

  it('clears the declared names with an empty array', async () => {
    const { crawler, owner } = savedCrawler(['OLD_KEY']);

    const { status, body } = await send(`/crawlers/${crawler.id}`, 'PUT', owner, webCrawlerBody({ environment_variable_names: [] }));

    expect(status).toBe(200);
    expect(body.environment_variable_names).toEqual([]);
  });

  it('keeps the declared names when the field is absent, as output_schema', async () => {
    const { crawler, owner } = savedCrawler(['KEEP_KEY']);

    const { status, body } = await send(`/crawlers/${crawler.id}`, 'PUT', owner, webCrawlerBody({ name: 'Renamed' }));

    expect(status).toBe(200);
    expect(body).toMatchObject({ name: 'Renamed', environment_variable_names: ['KEEP_KEY'] });
    expect(supabase.requestsOf('PATCH', 'crawlers')[0].body).not.toHaveProperty('environment_variable_names');
  });

  it('answers 404 for a crawler of another user, changing nothing', async () => {
    const { crawler } = savedCrawler(['OLD_KEY']);

    const { status } = await send(`/crawlers/${crawler.id}`, 'PUT', uniqueUUID(), webCrawlerBody({ environment_variable_names: ['NEW_KEY'] }));

    expect(status).toBe(404);
    expect(supabase.tables.crawlers[0].environment_variable_names).toEqual(['OLD_KEY']);
  });

  it.each(INVALID_NAMES)('answers 400 for %s, changing nothing', async (_, value, message) => {
    const { crawler, owner } = savedCrawler(['OLD_KEY']);

    const { status, body } = await send(`/crawlers/${crawler.id}`, 'PUT', owner, webCrawlerBody({ environment_variable_names: value }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request', error_description: message });
    expect(supabase.requests).toEqual([]);
  });
});
