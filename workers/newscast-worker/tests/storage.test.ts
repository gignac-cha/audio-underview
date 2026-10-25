import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { NEWSCAST_STAGES } from '@audio-underview/newscast-core';
import type { Environment } from '../sources/environment.ts';
import {
  computeOverallProgress,
  createNewscastSupabaseClient,
  getNewscastForUser,
  getNewscastRowForUser,
  insertNewscastsOfStageRun,
  listNewscastsForUser,
  listNewscastsOfStageRun,
  markNewscastDone,
  markNewscastError,
  mergeNewscastDetails,
  newscastExistsForUser,
  rowToJobSummary,
  rowToOwnerJobStatus,
  setNewscastTitleForUser,
  updateNewscastStage,
  type NewscastInsert,
} from '../sources/storage.ts';
import { useNewscastsInMemorySupabase, type Row } from './newscasts-in-memory-supabase.ts';

const supabase = useNewscastsInMemorySupabase();
const client = createNewscastSupabaseClient(env as unknown as Environment);

const OWNER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const STAGE_RUN_ID = '55555555-5555-4555-8555-555555555555';

function newscastRows(): Row[] {
  return supabase.tables.newscasts ?? [];
}

function seedNewscast(values: Row = {}): Row {
  const row: Row = {
    id: crypto.randomUUID(),
    user_uuid: OWNER,
    stage_run_id: STAGE_RUN_ID,
    source_index: 0,
    status: 'running',
    stage: 'crawl-list',
    stage_progress: 0,
    overall_progress: 0,
    title: '기사 제목',
    title_override: null,
    request: { limit: 1, provider: 'google', speaker1Voice: 'Charon', speaker2Voice: 'Leda', signal: false },
    details: {},
    result: null,
    error: null,
    error_code: null,
    created_at: '2026-10-26T01:00:00.000Z',
    updated_at: '2026-10-26T01:00:00.000Z',
    ...values,
  };
  supabase.tables.newscasts ??= [];
  supabase.tables.newscasts.push(row);
  return row;
}

describe('computeOverallProgress (six-way 1/6 split)', () => {
  it('places each working stage start on a 1/6 boundary', () => {
    // crawl-list 0/6, crawl-articles 1/6, organize 2/6, script 3/6, tts 4/6,
    // merge 5/6, done 6/6 — the organize stage turned the old 0.20 split into 1/6.
    expect(computeOverallProgress('crawl-list', 0)).toBeCloseTo(0 / 6);
    expect(computeOverallProgress('crawl-articles', 0)).toBeCloseTo(1 / 6);
    expect(computeOverallProgress('organize', 0)).toBeCloseTo(2 / 6);
    expect(computeOverallProgress('script', 0)).toBeCloseTo(3 / 6);
    expect(computeOverallProgress('tts', 0)).toBeCloseTo(4 / 6);
    expect(computeOverallProgress('merge', 0)).toBeCloseTo(5 / 6);
    expect(computeOverallProgress('done', 0)).toBeCloseTo(1);
  });

  it('advances one full 1/6 slice across a stage, meeting the next stage base', () => {
    // Half-way through crawl-articles is 1/6 + (1/6)*0.5 = 3/12.
    expect(computeOverallProgress('crawl-articles', 0.5)).toBeCloseTo(1 / 6 + 1 / 12);
    // A completed stage lines up exactly with the next stage's base.
    expect(computeOverallProgress('organize', 1)).toBeCloseTo(
      computeOverallProgress('script', 0),
    );
  });

  it('clamps out-of-range stage progress into 0..1', () => {
    expect(computeOverallProgress('crawl-list', -1)).toBe(0);
    expect(computeOverallProgress('merge', 5)).toBe(1);
  });

  it('has a base entry for every stage in NEWSCAST_STAGES', () => {
    for (const stage of NEWSCAST_STAGES) {
      expect(Number.isFinite(computeOverallProgress(stage, 0))).toBe(true);
    }
  });
});

const BASE_SUMMARY_ROW = {
  id: 'newscast-1',
  status: 'running' as const,
  stage: 'script',
  overall_progress: 0.45,
  created_at: '2026-07-14T04:56:31.000Z',
};

describe('rowToJobSummary title resolution', () => {
  it('uses the source title written with the row', () => {
    const summary = rowToJobSummary({ ...BASE_SUMMARY_ROW, title: '기사 제목', title_override: null });
    expect(summary).toEqual({
      id: 'newscast-1',
      status: 'running',
      stage: 'script',
      overallProgress: 0.45,
      createdAt: '2026-07-14T04:56:31.000Z',
      title: '기사 제목',
    });
  });

  it('prefers title_override over the source title', () => {
    expect(rowToJobSummary({ ...BASE_SUMMARY_ROW, title: '기사 제목', title_override: '수정된 제목' }).title).toBe('수정된 제목');
  });

  it('treats a blank title_override as absent, still falling back to the source title', () => {
    expect(rowToJobSummary({ ...BASE_SUMMARY_ROW, title: '기사 제목', title_override: '   ' }).title).toBe('기사 제목');
  });

  it('returns null when neither is there', () => {
    expect(rowToJobSummary({ ...BASE_SUMMARY_ROW, title: null, title_override: null }).title).toBeNull();
  });
});

/** A failed `newscasts` row carrying owner-only text in both leaky columns. */
const FAILED_ROW = {
  id: 'newscast-1',
  status: 'error' as const,
  stage: 'script',
  stage_progress: 0.5,
  overall_progress: 0.5,
  title_override: null,
  request: { limit: 1, provider: 'openai', speaker1Voice: 'Charon', speaker2Voice: 'Leda', signal: false },
  error: 'OpenAI 401: {"error":{"message":"Incorrect API key provided: sk-proj-abc"}}',
  error_code: null,
  result: null,
  details: {
    failure: { stage: 'script', message: 'sk-proj-abc rejected', at: '2026-08-10T00:00:00Z' },
  },
};

describe('rowToOwnerJobStatus (the one newscast projection)', () => {
  it('carries the progress fields, the safe error CODE, the message, and the details with the request', () => {
    const status = rowToOwnerJobStatus(FAILED_ROW);
    expect(status).toEqual({
      id: 'newscast-1',
      stage: 'script',
      stageProgress: 0.5,
      overallProgress: 0.5,
      status: 'error',
      errorCode: 'pipeline_failed',
      error: FAILED_ROW.error,
      details: { ...FAILED_ROW.details, request: FAILED_ROW.request },
    });
    expect(status.details?.failure?.stage).toBe('script');
  });

  it('omits errorCode while the newscast has not failed', () => {
    const status = rowToOwnerJobStatus({ ...FAILED_ROW, status: 'running', error: null });
    expect(status.errorCode).toBeUndefined();
    expect(status.error).toBeUndefined();
  });

  it('lifts the stored blocked_no_key from its column onto the wire shape (design §5.4)', () => {
    // This is the code the web branches on to offer "register your key" instead
    // of an ordinary failure panel.
    expect(rowToOwnerJobStatus({ ...FAILED_ROW, error_code: 'blocked_no_key' }).errorCode).toBe('blocked_no_key');
  });

  it('degrades an unknown stored code to the generic bucket rather than passing it on', () => {
    expect(rowToOwnerJobStatus({ ...FAILED_ROW, error_code: 'quota_exhausted' }).errorCode).toBe('pipeline_failed');
  });

  it('folds title_override into details.titleOverride, and carries the result of a done newscast', () => {
    const result = { sources: [], script: [], segments: [], audioKey: 'newscast-1/part-1', parts: [] };
    const status = rowToOwnerJobStatus({
      ...FAILED_ROW,
      status: 'done',
      error: null,
      title_override: ' 수정된 제목 ',
      result,
    });
    expect(status.result).toEqual(result);
    expect(status.details?.titleOverride).toBe('수정된 제목');
  });

  it('never echoes the owning user id back to the client', () => {
    // A row read with every column WOULD carry user_uuid; the mapper must drop it.
    const status = rowToOwnerJobStatus({ ...FAILED_ROW, user_uuid: OWNER } as Parameters<typeof rowToOwnerJobStatus>[0]);
    expect(JSON.stringify(status)).not.toContain(OWNER);
  });

  it('survives details and request that are not objects', () => {
    const status = rowToOwnerJobStatus({ ...FAILED_ROW, details: 'not json', request: null });
    expect(status.details).toBeUndefined();
  });
});

function insertOf(sourceIndex: number, title: string): NewscastInsert {
  return {
    user_uuid: OWNER,
    stage_run_id: STAGE_RUN_ID,
    source_index: sourceIndex,
    status: 'running',
    stage: 'crawl-list',
    stage_progress: 0,
    overall_progress: 0,
    title,
    request: { limit: 1, provider: 'google', speaker1Voice: `voice-${title}`, speaker2Voice: 'Leda', signal: false },
    details: {},
  };
}

describe('insertNewscastsOfStageRun', () => {
  it('inserts one row per source, on the schema of the environment, and reads them back in source order', async () => {
    const rows = await insertNewscastsOfStageRun(client, STAGE_RUN_ID, [insertOf(1, 'B'), insertOf(0, 'A')]);

    expect(rows.map((row) => [row.source_index, row.title])).toEqual([[0, 'A'], [1, 'B']]);
    expect(rows.every((row) => typeof row.id === 'string' && row.status === 'running')).toBe(true);
    const [upsert] = supabase.requestsOf('POST', 'newscasts');
    expect(upsert.schema).toBe((env as unknown as Environment).SUPABASE_SCHEMA);
    expect(upsert.query.get('on_conflict')).toBe('stage_run_id,source_index');
    expect(upsert.headers.prefer).toContain('resolution=ignore-duplicates');
  });

  it('keeps the rows a first insert made when the same stage run is inserted again', async () => {
    const first = await insertNewscastsOfStageRun(client, STAGE_RUN_ID, [insertOf(0, 'A'), insertOf(1, 'B')]);

    const again = await insertNewscastsOfStageRun(client, STAGE_RUN_ID, [insertOf(0, 'other'), insertOf(1, 'other')]);

    expect(newscastRows()).toHaveLength(2);
    expect(again).toEqual(first);
    expect(again[0].request).toMatchObject({ speaker1Voice: 'voice-A' });
  });

  it('throws when the database answers an error', async () => {
    supabase.intercept = () => ({ statusCode: 500, data: { message: 'database is down' } });

    await expect(insertNewscastsOfStageRun(client, STAGE_RUN_ID, [insertOf(0, 'A')])).rejects.toThrow(
      'Failed to insert newscasts: database is down',
    );
  });
});

describe('the workflow writers', () => {
  it('merge details per key, and timings per stage', async () => {
    const row = seedNewscast({ details: { crawlList: { count: 1, titles: ['A'], bytes: 1 }, timings: { organize: { startedAt: 1 } } } });

    await mergeNewscastDetails(client, row.id as string, { timings: { organize: { finishedAt: 5, durationMs: 4 } }, signal: { generated: false } });

    expect(newscastRows()[0].details).toEqual({
      crawlList: { count: 1, titles: ['A'], bytes: 1 },
      timings: { organize: { startedAt: 1, finishedAt: 5, durationMs: 4 } },
      signal: { generated: false },
    });
  });

  it('merge nothing into a row that does not exist', async () => {
    await mergeNewscastDetails(client, crypto.randomUUID(), { signal: { generated: true } });

    expect(supabase.requestsOf('PATCH', 'newscasts')).toHaveLength(0);
  });

  it('move the stage with its derived overall progress', async () => {
    const row = seedNewscast();

    await updateNewscastStage(client, row.id as string, 'tts', 0.5);

    expect(newscastRows()[0]).toMatchObject({ stage: 'tts', stage_progress: 0.5, overall_progress: 4 / 6 + 1 / 12 });
  });

  it('mark a newscast done with its result', async () => {
    const row = seedNewscast();
    const result = { sources: [], script: [], segments: [], audioKey: `${row.id}/part-1`, parts: [] };

    await markNewscastDone(client, row.id as string, result);

    expect(newscastRows()[0]).toMatchObject({ status: 'done', stage: 'done', stage_progress: 1, overall_progress: 1, result });
  });
});

describe('markNewscastError (design §1.3: the error COLUMN is a sink too)', () => {
  it('masks provider credentials before they reach the database, and stores the code beside the status', async () => {
    const row = seedNewscast();

    await markNewscastError(
      client,
      row.id as string,
      'OpenAI request failed (401): Incorrect API key provided: sk-proj-abcdefghijklmnop (org-9dF2kQwErTyUiOpA)',
      'blocked_no_key',
    );

    const stored = newscastRows()[0];
    expect(stored.status).toBe('error');
    expect(stored.error_code).toBe('blocked_no_key');
    expect(stored.error).not.toContain('sk-proj-abcdefghijklmnop');
    expect(stored.error).toContain('sk-[REDACTED]');
    expect(stored.error).toContain('org-[REDACTED]');
    // The diagnosis itself must survive the masking.
    expect(stored.error).toContain('OpenAI request failed (401)');
  });

  it('caps a runaway provider body at the same 2,000 chars as details.failure', async () => {
    const row = seedNewscast();

    await markNewscastError(client, row.id as string, 'z'.repeat(10_000));

    expect(newscastRows()[0].error).toBe(`${'z'.repeat(2_000)}… [truncated]`);
    expect(newscastRows()[0].error_code).toBeNull();
  });

  it('leaves a newscast that is no longer running as it is', async () => {
    const row = seedNewscast({ status: 'done', stage: 'done' });

    await markNewscastError(client, row.id as string, 'late failure', 'pipeline_failed');

    expect(newscastRows()[0]).toMatchObject({ status: 'done', error: null });
  });
});

describe('the reads of a request handler', () => {
  it('list one user newest first, at most the limit', async () => {
    seedNewscast({ title: 'old', created_at: '2026-10-26T01:00:00.000Z' });
    seedNewscast({ title: 'new', title_override: '고친 제목', created_at: '2026-10-26T03:00:00.000Z', source_index: 1 });
    seedNewscast({ title: 'middle', created_at: '2026-10-26T02:00:00.000Z', source_index: 2 });
    seedNewscast({ user_uuid: STRANGER, title: 'stranger', created_at: '2026-10-26T04:00:00.000Z', stage_run_id: null });

    const summaries = await listNewscastsForUser(client, OWNER, 2);

    expect(summaries.map((summary) => summary.title)).toEqual(['고친 제목', 'middle']);
    const [list] = supabase.requestsOf('GET', 'newscasts');
    expect(list.query.get('select')).toBe('id,status,stage,overall_progress,title,title_override,created_at');
  });

  it('get one newscast of its owner, and null for anyone else or an id that is not a UUID', async () => {
    const row = seedNewscast({ details: { signal: { generated: false } } });

    expect(await getNewscastForUser(client, OWNER, row.id as string)).toMatchObject({
      id: row.id,
      status: 'running',
      details: { signal: { generated: false }, request: row.request },
    });
    expect(await getNewscastForUser(client, STRANGER, row.id as string)).toBeNull();
    const requestsBefore = supabase.requests.length;
    expect(await getNewscastForUser(client, OWNER, 'not-a-uuid')).toBeNull();
    expect(supabase.requests).toHaveLength(requestsBefore);
  });

  it('get the raw row of its owner', async () => {
    const row = seedNewscast();

    expect(await getNewscastRowForUser(client, OWNER, row.id as string)).toEqual(row);
    expect(await getNewscastRowForUser(client, STRANGER, row.id as string)).toBeNull();
    expect(await getNewscastRowForUser(client, OWNER, '../etc')).toBeNull();
  });

  it('tell whether a newscast is of its owner, selecting the id alone', async () => {
    const row = seedNewscast();

    expect(await newscastExistsForUser(client, OWNER, row.id as string)).toBe(true);
    expect(await newscastExistsForUser(client, STRANGER, row.id as string)).toBe(false);
    expect(await newscastExistsForUser(client, OWNER, crypto.randomUUID())).toBe(false);
    const reads = supabase.requestsOf('GET', 'newscasts');
    expect(reads.map((read) => read.query.get('select'))).toEqual(['id', 'id', 'id']);
    expect(reads[1].query.get('user_uuid')).toBe(`eq.${STRANGER}`);
    const requestsBefore = supabase.requests.length;
    expect(await newscastExistsForUser(client, OWNER, '../etc')).toBe(false);
    expect(supabase.requests).toHaveLength(requestsBefore);
  });

  it('set the title override of its owner only', async () => {
    const row = seedNewscast();

    expect(await setNewscastTitleForUser(client, STRANGER, row.id as string, '남의 제목')).toBe(false);
    expect(newscastRows()[0].title_override).toBeNull();
    expect(await setNewscastTitleForUser(client, OWNER, row.id as string, '내 제목')).toBe(true);
    expect(newscastRows()[0].title_override).toBe('내 제목');
    expect(await setNewscastTitleForUser(client, OWNER, crypto.randomUUID(), '없는 뉴스캐스트')).toBe(false);
  });

  it('list the newscasts of a stage run in source order', async () => {
    seedNewscast({ source_index: 1, title: 'second' });
    seedNewscast({ source_index: 0, title: 'first' });
    seedNewscast({ stage_run_id: crypto.randomUUID(), title: 'other run' });

    expect((await listNewscastsOfStageRun(client, STAGE_RUN_ID)).map((row) => row.title)).toEqual(['first', 'second']);
  });
});
