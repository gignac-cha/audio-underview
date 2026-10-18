import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';
import { SYSTEM_USER_UUID } from '@audio-underview/supabase-connector';
import type CrawlerManagerWorker from '../sources/index.ts';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import {
  SUPABASE_ORIGIN,
  addCrawler,
  configureVault,
  crawlerRow,
  runScheduledHandler,
  testEnvironment,
  uniqueUUID,
  vaultEnvironment,
  vaultRequests,
} from './runtime-harness.ts';

// The RPC methods, runCrawler the scheduler calls and executeCrawlerByName for system crawlers, and the cron,
// as a caller of the service binding meets them.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);
// An RPC promise is callable and expect().rejects calls what it is given, so rejecting calls are wrapped in a function
const crawlerManager = exports.default as unknown as Service<typeof CrawlerManagerWorker>;

describe('runCrawler', () => {
  it('runs the crawler for the user and answers the outcome with the logs', async () => {
    const user = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: user, code: '(input) => { console.log("stage input", input.n); return { n: input.n + 1 }; }' }));

    const outcome = await crawlerManager.runCrawler(crawler.id, { n: 1 }, { userUUID: user, runID: uniqueUUID() });

    expect(outcome).toEqual({
      status: 'completed',
      type: 'data',
      result: { n: 2 },
      logs: [{ level: 'log', message: 'stage input 1', timestamp: expect.any(String) }],
      logs_truncated: false,
    });
  });

  it('answers a failure of the code as a failed outcome with its logs instead of throwing', async () => {
    const user = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: user, code: '() => { console.log("progress"); throw new Error("stage failed"); }' }));

    const outcome = await crawlerManager.runCrawler(crawler.id, {}, { userUUID: user });

    expect(outcome).toMatchObject({
      status: 'failed',
      type: 'data',
      error_code: 'execution_failed',
      error: 'CodeRunner error 422: [execution_failed] stage failed',
      error_description: 'stage failed',
      logs_truncated: false,
    });
    expect(outcome.logs.map((entry) => entry.message.split('\n')[0])).toEqual(['progress', 'Error: stage failed']);
  });

  it('ties the files of a scheduled run to the run, with no expiry, and keeps their bytes', async () => {
    const user = uniqueUUID();
    const runID = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({
      user_uuid: user,
      code: 'async (input, context) => ({ audio: await context.files.save("sound", { contentType: "audio/mpeg" }) })',
    }));

    const outcome = await crawlerManager.runCrawler(crawler.id, {}, { userUUID: user, runID });

    expect(outcome.status).toBe('completed');
    const row = (supabase.tables.crawler_files ?? [])[0];
    expect(row).toMatchObject({ user_uuid: user, run_id: runID, expires_at: null, crawler_id: crawler.id });
    expect(await (await testEnvironment.CRAWLER_FILES.get(String(row.object_key)))?.text()).toBe('sound');
  });

  it('gives the author the declared environment variables and nobody else, asking the vault for the author only', async () => {
    const author = uniqueUUID();
    const other = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({
      user_uuid: author,
      code: '(input, context) => Object.keys(context.environment)',
      environment_variable_names: ['SPEECH_API_KEY', 'OTHER_KEY'],
    }));
    await vaultEnvironment(author, { SPEECH_API_KEY: 'speech-secret-value-0001' });
    await vaultEnvironment(other, { OTHER_KEY: 'other-secret-value-0002' });

    const byAuthor = await crawlerManager.runCrawler(crawler.id, {}, { userUUID: author });
    const byOther = await crawlerManager.runCrawler(crawler.id, {}, { userUUID: other });

    expect(byAuthor).toMatchObject({ status: 'completed', result: ['SPEECH_API_KEY'] });
    expect(byOther).toMatchObject({ status: 'completed', result: [] });
    expect((await vaultRequests(author)).map((request) => request.route)).toEqual(['resolve']);
    expect(await vaultRequests(other)).toEqual([]);
  });

  it('runs a crawler of the user from a database before migration 014, whose row has no environment_variable_names', async () => {
    const author = uniqueUUID();
    await vaultEnvironment(author, { KEY: 'key-value-0001' });
    const { environment_variable_names: _, ...row } = crawlerRow({ user_uuid: author, code: '(input, context) => Object.keys(context.environment)' });
    supabase.tables.crawlers ??= [];
    supabase.tables.crawlers.push(row);

    const outcome = await crawlerManager.runCrawler(row.id, {}, { userUUID: author, runID: uniqueUUID() });

    expect(outcome).toMatchObject({ status: 'completed', result: [] });
    expect(await vaultRequests(author)).toEqual([]);
  });

  it('throws Crawler <id> not found for a crawler that does not exist', async () => {
    const crawlerID = uniqueUUID();

    await expect(() => crawlerManager.runCrawler(crawlerID, {}, { userUUID: uniqueUUID() })).rejects.toThrow(`Crawler ${crawlerID} not found`);
  });

  it('throws Invalid user UUID or Invalid run ID for a context that is not valid, before anything is read', async () => {
    const crawlerID = uniqueUUID();

    for (const context of [{ userUUID: 'not-a-uuid' }, { userUUID: '' }, null, {}, { userUUID: 5 }]) {
      await expect(() => crawlerManager.runCrawler(crawlerID, {}, context as never)).rejects.toThrow('Invalid user UUID');
    }
    for (const runID of ['nope', 42, '']) {
      await expect(() => crawlerManager.runCrawler(crawlerID, {}, { userUUID: uniqueUUID(), runID } as never)).rejects.toThrow('Invalid run ID');
    }
    expect(supabase.requests).toEqual([]);
  });

  it('throws with the status and the code of the vault only when the environment variables cannot be read', async () => {
    const author = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author, environment_variable_names: ['KEY'] }));

    await configureVault(author, { resolve: { status: 503, body: { error: 'vault_unavailable' } } });
    await expect(() => crawlerManager.runCrawler(crawler.id, {}, { userUUID: author })).rejects.toThrow(
      'Environment variables could not be read: vault responded 503 vault_unavailable',
    );

    await configureVault(author, { resolve: { status: 'unreachable' } });
    await expect(() => crawlerManager.runCrawler(crawler.id, {}, { userUUID: author })).rejects.toThrow(
      'Environment variables could not be read: vault could not be reached',
    );
  });

  it('throws on a database error', async () => {
    supabase.intercept = () => ({ statusCode: 500, data: { message: 'database down' } });

    await expect(() => crawlerManager.runCrawler(uniqueUUID(), {}, { userUUID: uniqueUUID() })).rejects.toThrow(/Failed to get crawler by ID/);
  });
});

describe('executeCrawlerByName', () => {
  it('runs a system crawler without a user: no environment variables and no vault call', async () => {
    const caller = uniqueUUID();
    const name = `system-probe-${uniqueUUID()}`;
    addCrawler(supabase, crawlerRow({ user_uuid: SYSTEM_USER_UUID, name, code: '(input, context) => Object.keys(context.environment)' }));
    await vaultEnvironment(caller, { KEY: 'a-secret-value' });

    await expect(crawlerManager.executeCrawlerByName(name, {})).resolves.toEqual({ type: 'data', result: [] });
    expect(await vaultRequests(caller)).toEqual([]);
  });

  it('throws the text of the failure when the run fails', async () => {
    const name = `system-failing-${uniqueUUID()}`;
    addCrawler(supabase, crawlerRow({ user_uuid: SYSTEM_USER_UUID, name, code: '() => { throw new Error("system failure"); }' }));

    await expect(() => crawlerManager.executeCrawlerByName(name, {})).rejects.toThrow('[execution_failed] system failure');
  });

  it('does not run a crawler of a user by its name', async () => {
    const name = `user-crawler-${uniqueUUID()}`;
    addCrawler(supabase, crawlerRow({ user_uuid: uniqueUUID(), name, code: '() => "ran"' }));

    await expect(() => crawlerManager.executeCrawlerByName(name, {})).rejects.toThrow(`System crawler '${name}' not found`);
  });
});

describe('scheduled', () => {
  it('rejects, so that the cron shows as failed, when a step of the cleanup fails', async () => {
    supabase.intercept = (request) =>
      request.table === 'rpc/delete_expired_crawler_files' ? { statusCode: 500, data: { message: 'rpc failed' } } : undefined;

    await expect(() => runScheduledHandler({ scheduledTime: new Date('2026-10-13T00:15:00.000Z'), cron: '*/15 * * * *' })).rejects.toThrow(
      /Crawler file cleanup failed/,
    );
  });

  it('removes the objects of files whose rows are gone and keeps the live ones', async () => {
    const user = uniqueUUID();
    const orphanKey = `${user}/orphan`;
    const liveKey = `${user}/live`;
    await testEnvironment.CRAWLER_FILES.put(orphanKey, 'orphan');
    await testEnvironment.CRAWLER_FILES.put(liveKey, 'live');
    supabase.tables.crawler_files ??= [];
    supabase.tables.crawler_files.push({
      id: uniqueUUID(), user_uuid: user, run_id: null, crawler_id: null, object_key: liveKey, name: null,
      content_type: 'text/plain', size: 4, expires_at: '2099-01-01T00:00:00.000Z', created_at: '2026-10-13T00:00:00.000Z',
    });
    supabase.tables.crawler_file_deletions ??= [];
    supabase.tables.crawler_file_deletions.push({ object_key: orphanKey, queued_at: '2026-10-13T00:00:00.000Z' });

    await runScheduledHandler({ scheduledTime: new Date('2026-10-13T00:15:00.000Z'), cron: '*/15 * * * *' });

    expect(await testEnvironment.CRAWLER_FILES.get(orphanKey)).toBeNull();
    expect(await (await testEnvironment.CRAWLER_FILES.get(liveKey))?.text()).toBe('live');
    expect(supabase.tables.crawler_file_deletions).toEqual([]);
  });
});
