import { createSupabaseClient } from './client.ts';

// supabase-js retries an idempotent request that Supabase answers with 503 or 520,
// waiting 1s, 2s and 4s between the attempts when the answer has no Retry-After

const SUPABASE_URL = 'https://supabase.example.com';
const SCHEMA = 'staging';

function unavailable(): Response {
  return new Response(JSON.stringify({ message: 'error code: 1016' }), { status: 503 });
}

function rows(): Response {
  return new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { 'content-type': 'application/json' } });
}

function stubFetch(...answers: Array<() => Response>) {
  const fetchFunction = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error('No answer left for this request');
    return answer();
  });
  vi.stubGlobal('fetch', fetchFunction);
  return fetchFunction;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function retryCountOf(init: RequestInit | undefined): string | null {
  return headerOf(init, 'X-Retry-Count');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createSupabaseClient', () => {
  test('retries a GET that Supabase answers with 503, after a second', async () => {
    const fetchFunction = stubFetch(unavailable, rows);
    const client = createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key', schema: SCHEMA });

    const query = client.from('accounts').select('*');
    const result = Promise.resolve(query);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFunction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    const { data, error } = await result;
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 1 }]);
    expect(fetchFunction).toHaveBeenCalledTimes(2);
    expect(retryCountOf(fetchFunction.mock.calls[0][1])).toBeNull();
    expect(retryCountOf(fetchFunction.mock.calls[1][1])).toBe('1');
  });

  test('gives up after three retries and returns the 503 as an error', async () => {
    const fetchFunction = stubFetch(unavailable, unavailable, unavailable, unavailable);
    const client = createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key', schema: SCHEMA });

    const result = Promise.resolve(client.from('accounts').select('*'));
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);

    const { data, error } = await result;
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: 'error code: 1016' });
    expect(fetchFunction).toHaveBeenCalledTimes(4);
  });

  test('does not retry a POST', async () => {
    const fetchFunction = stubFetch(unavailable);
    const client = createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key', schema: SCHEMA });

    const { error } = await client.from('accounts').insert({ provider: 'google', identifier: 'google-sub-123', uuid: '00000000-0000-0000-0000-000000000001' });

    expect(error).toMatchObject({ message: 'error code: 1016' });
    expect(fetchFunction).toHaveBeenCalledTimes(1);
  });

  test('sends the schema as Accept-Profile on a read', async () => {
    const fetchFunction = stubFetch(rows);
    const client = createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key', schema: SCHEMA });

    await client.from('accounts').select('*');

    expect(fetchFunction).toHaveBeenCalledTimes(1);
    const init = fetchFunction.mock.calls[0][1];
    expect(headerOf(init, 'Accept-Profile')).toBe(SCHEMA);
    expect(headerOf(init, 'Content-Profile')).toBeNull();
  });

  test('sends the schema as Content-Profile on a write', async () => {
    const fetchFunction = stubFetch(rows);
    const client = createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key', schema: SCHEMA });

    await client.from('accounts').insert({ provider: 'google', identifier: 'google-sub-123', uuid: '00000000-0000-0000-0000-000000000001' });

    expect(fetchFunction).toHaveBeenCalledTimes(1);
    const init = fetchFunction.mock.calls[0][1];
    expect(headerOf(init, 'Content-Profile')).toBe(SCHEMA);
    expect(headerOf(init, 'Accept-Profile')).toBeNull();
  });

  test('sends the schema it was given, not a fixed one', async () => {
    const fetchFunction = stubFetch(rows, rows);

    for (const schema of ['public', 'development']) {
      const client = createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key', schema });
      await client.from('accounts').select('*');
    }

    expect(headerOf(fetchFunction.mock.calls[0][1], 'Accept-Profile')).toBe('public');
    expect(headerOf(fetchFunction.mock.calls[1][1], 'Accept-Profile')).toBe('development');
  });
});

// Without a schema the client sends no profile header and PostgREST serves `public`, the tables of
// production, so a variable that is missing at run time has to stop the client from being created

describe('createSupabaseClient schema check', () => {
  function create(schema: unknown) {
    return createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key', schema: schema as string });
  }

  test.each([
    ['undefined, as when SUPABASE_SCHEMA is missing from the vars', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number', 1],
    ['an object', {}],
  ])('throws for %s', (_name, schema) => {
    expect(() => create(schema)).toThrow(/Supabase schema must be a lowercase SQL identifier/);
    expect(() => create(schema)).toThrow(/SUPABASE_SCHEMA/);
  });

  test.each([
    ['upper case letters', 'Staging'],
    ['a leading digit', '1staging'],
    ['a hyphen', 'staging-environment'],
    ['a dot', 'public.staging'],
    ['a space', 'public staging'],
    ['a surrounding space', ' staging '],
    ['a trailing newline', 'staging\n'],
    ['a comma', 'public,staging'],
    ['a quote', '"public"'],
    ['a semicolon', 'public; drop schema public'],
    ['a non-ASCII letter', 'stagíng'],
  ])('throws for a schema with %s', (_name, schema) => {
    expect(() => create(schema)).toThrow(/Supabase schema must be a lowercase SQL identifier/);
  });

  test('names the rejected value in the error', () => {
    expect(() => create('Staging')).toThrow('received "Staging"');
  });

  test('sends no request when the schema is rejected', () => {
    const fetchFunction = stubFetch(rows);

    expect(() => create(undefined)).toThrow();

    expect(fetchFunction).not.toHaveBeenCalled();
  });

  test.each(['public', 'staging', 'development', 'test_schema', '_private', 'schema_2', 'a'])('accepts %s', (schema) => {
    expect(() => create(schema)).not.toThrow();
  });
});
