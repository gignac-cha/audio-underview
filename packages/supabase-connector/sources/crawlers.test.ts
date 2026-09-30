import {
  SYSTEM_USER_UUID,
  createCrawler,
  listCrawlersByUser,
  getCrawler,
  getSystemCrawlerByName,
  updateCrawler,
  deleteCrawler,
} from './crawlers.ts';
import { createMockClient, setupTracerMock } from './test-helpers.ts';

setupTracerMock();

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
    expect(result).toBeUndefined();
  });
});

describe('SYSTEM_USER_UUID', () => {
  test('is the system user seeded by migration 010', () => {
    expect(SYSTEM_USER_UUID).toBe('00000000-0000-0000-0000-000000000001');
  });
});

describe('getSystemCrawlerByName', () => {
  const systemCrawler = { ...sampleCrawler, user_uuid: SYSTEM_USER_UUID, name: 'geeknews-list' };

  test('queries crawlers by the system user and name', async () => {
    const client = createMockClient({ crawlers: { data: systemCrawler, error: null } });

    await getSystemCrawlerByName(client, 'geeknews-list');

    expect(client.from).toHaveBeenCalledWith('crawlers');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq).toHaveBeenCalledWith('user_uuid', SYSTEM_USER_UUID);
    expect(chain.eq).toHaveBeenCalledWith('name', 'geeknews-list');
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns crawler when found', async () => {
    const client = createMockClient({ crawlers: { data: systemCrawler, error: null } });

    const result = await getSystemCrawlerByName(client, 'geeknews-list');
    expect(result).toEqual(systemCrawler);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ crawlers: { data: null, error: null } });

    const result = await getSystemCrawlerByName(client, 'missing');
    expect(result).toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({
      crawlers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(getSystemCrawlerByName(client, 'geeknews-list')).rejects.toThrow(
      'Failed to get system crawler: fail',
    );
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
    expect(result).toBeUndefined();
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
