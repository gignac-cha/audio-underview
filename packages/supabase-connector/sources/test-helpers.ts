import { vi } from 'vitest';

export function setupTracerMock() {
  vi.mock('@audio-underview/axiom-logger/tracers', () => ({
    traceDatabaseOperation: async (_options: unknown, operation: Function) =>
      operation({
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        end: vi.fn(),
        recordException: vi.fn(),
        addEvent: vi.fn(),
      }),
    SpanStatusCode: { OK: 0, ERROR: 2 },
  }));
}

export type FakeQueryOperation = 'select' | 'insert' | 'update' | 'delete';

export interface FakeQuery {
  table: string;
  operation?: FakeQueryOperation;
  filters: Record<string, string>;
  payload?: unknown;
  single: boolean;
}

export interface FakeQueryResult {
  data?: unknown;
  error?: unknown;
  count?: number;
}

/**
 * Supabase client fake that dispatches on the recorded query instead of on the
 * table alone, so a test can answer a `select` and the following `delete` on the
 * same table differently. Every issued query is recorded for assertions.
 */
export function createFakeSupabaseClient(respond: (query: FakeQuery) => FakeQueryResult) {
  const queries: FakeQuery[] = [];

  function createChain(table: string) {
    const query: FakeQuery = { table, filters: {}, single: false };
    let recorded = false;

    const settle = () => {
      if (!recorded) {
        recorded = true;
        queries.push(query);
      }
      return Promise.resolve(respond(query));
    };

    const chain: Record<string, unknown> = {
      select: (_columns?: unknown) => {
        query.operation ??= 'select';
        return chain;
      },
      insert: (payload: unknown) => {
        query.operation ??= 'insert';
        query.payload = payload;
        return chain;
      },
      update: (payload: unknown) => {
        query.operation ??= 'update';
        query.payload = payload;
        return chain;
      },
      delete: () => {
        query.operation ??= 'delete';
        return chain;
      },
      eq: (column: string, value: string) => {
        query.filters[column] = value;
        return chain;
      },
      order: () => chain,
      range: () => chain,
      single: () => {
        query.single = true;
        return settle();
      },
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        settle().then(onFulfilled, onRejected),
    };

    return chain;
  }

  return {
    queries,
    client: { from: (table: string) => createChain(table) } as any,
  };
}

/**
 * In-memory stand-in for the OAuth state KV namespace.
 */
export function createMemoryAccountStateStorage(initialEntries: Record<string, string> = {}) {
  const entries = new Map<string, string>(Object.entries(initialEntries));
  const writes: { key: string; value: string; options?: { expirationTtl?: number } }[] = [];
  const deletions: string[] = [];

  return {
    entries,
    writes,
    deletions,
    storage: {
      async get(key: string): Promise<string | null> {
        return entries.has(key) ? (entries.get(key) as string) : null;
      },
      async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
        writes.push({ key, value, options });
        entries.set(key, value);
      },
      async delete(key: string): Promise<void> {
        deletions.push(key);
        entries.delete(key);
      },
    },
  };
}

export function createMockClient(
  tableResults: Record<string, { data?: unknown; error?: unknown; count?: number }> = {},
  rpcResults: Record<string, { data?: unknown; error?: unknown }> = {},
) {
  const defaultResult = { data: null, error: null, count: 0 };

  return {
    from: vi.fn((table: string) => {
      const result = tableResults[table] ?? defaultResult;

      const createChain = () => {
        const promise = Promise.resolve(result) as any;
        for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'range', 'order']) {
          promise[method] = vi.fn().mockReturnValue(promise);
        }
        promise.single = vi.fn().mockImplementation(() => Promise.resolve(result));
        return promise;
      };

      return createChain();
    }),
    rpc: vi.fn((functionName: string) => {
      const result = rpcResults[functionName] ?? defaultResult;
      return Promise.resolve(result);
    }),
  } as any;
}
