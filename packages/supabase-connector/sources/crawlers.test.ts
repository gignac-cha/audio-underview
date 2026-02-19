import {
  createCrawler,
  listCrawlersByUser,
  getCrawler,
  updateCrawler,
  deleteCrawler,
} from './crawlers.ts';

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

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleCrawler = {
  id: 'crawler-1',
  user_uuid: 'uuid-1',
  name: 'Test Crawler',
  url_pattern: 'https://example.com/*',
  code: 'console.log("test")',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function createMockClient(tableResults: Record<string, { data?: unknown; error?: unknown; count?: number }> = {}) {
  const defaultResult = { data: null, error: null, count: 0 };

  return {
    from: vi.fn((table: string) => {
      const result = tableResults[table] ?? defaultResult;

      const createChain = (): Record<string, Function> => {
        const self: Record<string, Function> = {};
        for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'range', 'order']) {
          self[m] = vi.fn().mockReturnValue(self);
        }
        (self as any).then = (resolve: Function) => resolve(result);
        self.single = vi.fn().mockImplementation(() => Promise.resolve(result));
        return self;
      };

      return createChain();
    }),
  } as any;
}

describe('createCrawler', () => {
  test('returns created crawler', async () => {
    const client = createMockClient({ crawlers: { data: sampleCrawler, error: null } });
    const input = {
      user_uuid: 'uuid-1',
      name: 'Test Crawler',
      url_pattern: 'https://example.com/*',
      code: 'console.log("test")',
    };

    const result = await createCrawler(client, input);
    expect(result).toEqual(sampleCrawler);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      crawlers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(
      createCrawler(client, { user_uuid: 'uuid-1', name: 'c', url_pattern: '*', code: '' }),
    ).rejects.toThrow('Failed to create crawler');
  });
});

describe('listCrawlersByUser', () => {
  test('returns paginated crawlers', async () => {
    const crawlers = [sampleCrawler];
    const client = createMockClient({ crawlers: { data: crawlers, error: null, count: 1 } });

    const result = await listCrawlersByUser(client, 'uuid-1');
    expect(result.data).toEqual(crawlers);
    expect(result.total).toBe(1);
  });

  test('uses default offset=0 and limit=20', async () => {
    const client = createMockClient({ crawlers: { data: [], error: null, count: 0 } });

    const result = await listCrawlersByUser(client, 'uuid-1');
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  test('clamps negative offset to 0', async () => {
    const client = createMockClient({ crawlers: { data: [], error: null, count: 0 } });

    const result = await listCrawlersByUser(client, 'uuid-1', { offset: -5 });
    expect(result.data).toEqual([]);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      crawlers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(listCrawlersByUser(client, 'uuid-1')).rejects.toThrow('Failed to list crawlers');
  });
});

describe('getCrawler', () => {
  test('returns crawler when found', async () => {
    const client = createMockClient({ crawlers: { data: sampleCrawler, error: null } });

    const result = await getCrawler(client, 'crawler-1', 'uuid-1');
    expect(result).toEqual(sampleCrawler);
  });

  test('returns null on PGRST116', async () => {
    const client = createMockClient({
      crawlers: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await getCrawler(client, 'crawler-1', 'uuid-1');
    expect(result).toBeNull();
  });
});

describe('updateCrawler', () => {
  test('returns updated crawler', async () => {
    const updated = { ...sampleCrawler, name: 'Updated' };
    const client = createMockClient({ crawlers: { data: updated, error: null } });

    const result = await updateCrawler(client, 'crawler-1', 'uuid-1', { name: 'Updated' });
    expect(result).toEqual(updated);
  });

  test('returns null on PGRST116', async () => {
    const client = createMockClient({
      crawlers: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await updateCrawler(client, 'crawler-1', 'uuid-1', { name: 'Updated' });
    expect(result).toBeNull();
  });
});

describe('deleteCrawler', () => {
  test('returns true when deleted', async () => {
    const client = createMockClient({ crawlers: { data: [sampleCrawler], error: null } });

    const result = await deleteCrawler(client, 'crawler-1', 'uuid-1');
    expect(result).toBe(true);
  });

  test('returns false when not found', async () => {
    const client = createMockClient({ crawlers: { data: [], error: null } });

    const result = await deleteCrawler(client, 'crawler-1', 'uuid-1');
    expect(result).toBe(false);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      crawlers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(deleteCrawler(client, 'crawler-1', 'uuid-1')).rejects.toThrow('Failed to delete crawler');
  });
});
