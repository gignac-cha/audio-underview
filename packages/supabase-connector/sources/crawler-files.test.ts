import {
  createCrawlerFile,
  getCrawlerFileForUser,
  crawlerFileExists,
  deleteCrawlerFile,
  deleteExpiredCrawlerFiles,
  listCrawlerFileDeletions,
  deleteCrawlerFileDeletions,
} from './crawler-files.ts';
import { createMockClient, setupTracerMock } from './test-helpers.ts';

setupTracerMock();

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const USER_UUID = '00000000-0000-0000-0000-000000000001';
const FILE_ID = '00000000-0000-0000-0000-0000000000f1';

const sampleFile = {
  id: FILE_ID,
  user_uuid: USER_UUID,
  run_id: null,
  crawler_id: '00000000-0000-0000-0000-0000000000c1',
  object_key: `${USER_UUID}/${FILE_ID}`,
  name: 'episode.mp3',
  content_type: 'audio/mpeg',
  size: 19_000_000,
  expires_at: '2026-10-14T00:00:00Z',
  created_at: '2026-10-13T00:00:00Z',
};

describe('createCrawlerFile', () => {
  test('inserts the file row and returns it', async () => {
    const client = createMockClient({ crawler_files: { data: sampleFile, error: null } });
    const input = {
      id: FILE_ID,
      user_uuid: USER_UUID,
      crawler_id: sampleFile.crawler_id,
      object_key: sampleFile.object_key,
      name: 'episode.mp3',
      content_type: 'audio/mpeg',
      size: 19_000_000,
      expires_at: '2026-10-14T00:00:00Z',
    };

    const result = await createCrawlerFile(client, input);

    expect(result).toEqual(sampleFile);
    expect(client.from).toHaveBeenCalledWith('crawler_files');
    const chain = client.from.mock.results[0].value;
    expect(chain.insert).toHaveBeenCalledWith(input);
    expect(chain.single).toHaveBeenCalled();
  });

  test('throws on error', async () => {
    const client = createMockClient({ crawler_files: { data: null, error: { code: 'OTHER', message: 'fail' } } });

    await expect(
      createCrawlerFile(client, { user_uuid: USER_UUID, object_key: 'k', content_type: 'text/plain', size: 1, run_id: 'run-1' }),
    ).rejects.toThrow('Failed to create crawler file: fail');
  });
});

describe('getCrawlerFileForUser', () => {
  test('queries the file by ID and owner, unexpired or without expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
    const client = createMockClient({ crawler_files: { data: sampleFile, error: null } });

    await getCrawlerFileForUser(client, FILE_ID, USER_UUID);

    expect(client.from).toHaveBeenCalledWith('crawler_files');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([
      ['id', FILE_ID],
      ['user_uuid', USER_UUID],
    ]);
    expect(chain.or).toHaveBeenCalledWith('expires_at.is.null,expires_at.gt.2026-10-13T12:00:00.000Z');
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns the file when found', async () => {
    const client = createMockClient({ crawler_files: { data: sampleFile, error: null } });

    await expect(getCrawlerFileForUser(client, FILE_ID, USER_UUID)).resolves.toEqual(sampleFile);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ crawler_files: { data: null, error: null } });

    await expect(getCrawlerFileForUser(client, FILE_ID, USER_UUID)).resolves.toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({ crawler_files: { data: null, error: { code: 'OTHER', message: 'fail' } } });

    await expect(getCrawlerFileForUser(client, FILE_ID, USER_UUID)).rejects.toThrow('Failed to get crawler file: fail');
  });
});

describe('crawlerFileExists', () => {
  test('queries the file by ID alone', async () => {
    const client = createMockClient({ crawler_files: { data: { id: FILE_ID }, error: null } });

    await crawlerFileExists(client, FILE_ID);

    const chain = client.from.mock.results[0].value;
    expect(chain.select).toHaveBeenCalledWith('id');
    expect(chain.eq.mock.calls).toEqual([['id', FILE_ID]]);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns true when the row exists', async () => {
    const client = createMockClient({ crawler_files: { data: { id: FILE_ID }, error: null } });

    await expect(crawlerFileExists(client, FILE_ID)).resolves.toBe(true);
  });

  test('returns false when the row is gone', async () => {
    const client = createMockClient({ crawler_files: { data: null, error: null } });

    await expect(crawlerFileExists(client, FILE_ID)).resolves.toBe(false);
  });

  test('throws on error', async () => {
    const client = createMockClient({ crawler_files: { data: null, error: { code: 'OTHER', message: 'fail' } } });

    await expect(crawlerFileExists(client, FILE_ID)).rejects.toThrow('Failed to check crawler file: fail');
  });
});

describe('deleteCrawlerFile', () => {
  test('deletes the row by ID', async () => {
    const client = createMockClient({ crawler_files: { data: [{ id: FILE_ID }], error: null } });

    await expect(deleteCrawlerFile(client, FILE_ID)).resolves.toBe(true);

    const chain = client.from.mock.results[0].value;
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq.mock.calls).toEqual([['id', FILE_ID]]);
  });

  test('returns false when no row was deleted', async () => {
    const client = createMockClient({ crawler_files: { data: [], error: null } });

    await expect(deleteCrawlerFile(client, FILE_ID)).resolves.toBe(false);
  });

  test('throws on error', async () => {
    const client = createMockClient({ crawler_files: { data: null, error: { code: 'OTHER', message: 'fail' } } });

    await expect(deleteCrawlerFile(client, FILE_ID)).rejects.toThrow('Failed to delete crawler file: fail');
  });
});

describe('deleteExpiredCrawlerFiles', () => {
  test('calls delete_expired_crawler_files with the limit and returns the count', async () => {
    const client = createMockClient({}, { delete_expired_crawler_files: { data: 3, error: null } });

    await expect(deleteExpiredCrawlerFiles(client, 500)).resolves.toBe(3);

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('delete_expired_crawler_files', { batch_limit: 500 });
  });

  test('returns 0 when nothing expired', async () => {
    const client = createMockClient({}, { delete_expired_crawler_files: { data: 0, error: null } });

    await expect(deleteExpiredCrawlerFiles(client, 500)).resolves.toBe(0);
  });

  test('throws on error', async () => {
    const client = createMockClient({}, { delete_expired_crawler_files: { data: null, error: { message: 'fail' } } });

    await expect(deleteExpiredCrawlerFiles(client, 500)).rejects.toThrow('Failed to delete expired crawler files: fail');
  });
});

describe('listCrawlerFileDeletions', () => {
  const deletions = [
    { object_key: `${USER_UUID}/a`, queued_at: '2026-10-13T00:00:00Z' },
    { object_key: `${USER_UUID}/b`, queued_at: '2026-10-13T00:01:00Z' },
  ];

  test('lists the queued keys, the oldest first, up to the limit', async () => {
    const client = createMockClient({ crawler_file_deletions: { data: deletions, error: null } });

    await expect(listCrawlerFileDeletions(client, 500)).resolves.toEqual(deletions);

    expect(client.from).toHaveBeenCalledWith('crawler_file_deletions');
    const chain = client.from.mock.results[0].value;
    expect(chain.order).toHaveBeenCalledWith('queued_at', { ascending: true });
    expect(chain.limit).toHaveBeenCalledWith(500);
  });

  test('returns an empty array when the queue is empty', async () => {
    const client = createMockClient({ crawler_file_deletions: { data: [], error: null } });

    await expect(listCrawlerFileDeletions(client, 500)).resolves.toEqual([]);
  });

  test('throws on error', async () => {
    const client = createMockClient({ crawler_file_deletions: { data: null, error: { code: 'OTHER', message: 'fail' } } });

    await expect(listCrawlerFileDeletions(client, 500)).rejects.toThrow('Failed to list crawler file deletions: fail');
  });
});

describe('deleteCrawlerFileDeletions', () => {
  test('calls delete_crawler_file_deletions with the keys and returns the count', async () => {
    const client = createMockClient({}, { delete_crawler_file_deletions: { data: 2, error: null } });

    await expect(deleteCrawlerFileDeletions(client, ['a', 'b'])).resolves.toBe(2);

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('delete_crawler_file_deletions', { object_keys: ['a', 'b'] });
  });

  test('does not call the database for no keys', async () => {
    const client = createMockClient();

    await expect(deleteCrawlerFileDeletions(client, [])).resolves.toBe(0);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  test('throws on error', async () => {
    const client = createMockClient({}, { delete_crawler_file_deletions: { data: null, error: { message: 'fail' } } });

    await expect(deleteCrawlerFileDeletions(client, ['a'])).rejects.toThrow('Failed to delete crawler file deletions: fail');
  });
});
