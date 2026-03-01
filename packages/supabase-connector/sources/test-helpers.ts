import { vi } from 'vitest';

export function setupTracerMock() {
  vi.mock('@audio-underview/axiom-logger/tracers', () => ({
    traceDatabaseOperation: async (_options: unknown, fn: Function) =>
      fn({
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        end: vi.fn(),
        recordException: vi.fn(),
        addEvent: vi.fn(),
      }),
    SpanStatusCode: { OK: 0, ERROR: 2 },
  }));
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
        for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'range', 'order']) {
          promise[m] = vi.fn().mockReturnValue(promise);
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
