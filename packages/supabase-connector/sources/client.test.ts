import { createSupabaseClient } from './client.ts';

// supabase-js retries an idempotent request that Supabase answers with 503 or 520,
// waiting 1s, 2s and 4s between the attempts when the answer has no Retry-After

const SUPABASE_URL = 'https://supabase.example.com';

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

function retryCountOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('X-Retry-Count');
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
    const client = createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key' });

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
    const client = createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key' });

    const result = Promise.resolve(client.from('accounts').select('*'));
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);

    const { data, error } = await result;
    expect(data).toBeNull();
    expect(error).toMatchObject({ message: 'error code: 1016' });
    expect(fetchFunction).toHaveBeenCalledTimes(4);
  });

  test('does not retry a POST', async () => {
    const fetchFunction = stubFetch(unavailable);
    const client = createSupabaseClient({ supabaseURL: SUPABASE_URL, supabaseSecretKey: 'test-secret-key' });

    const { error } = await client.from('accounts').insert({ provider: 'google', identifier: 'google-sub-123', uuid: '00000000-0000-0000-0000-000000000001' });

    expect(error).toMatchObject({ message: 'error code: 1016' });
    expect(fetchFunction).toHaveBeenCalledTimes(1);
  });
});
