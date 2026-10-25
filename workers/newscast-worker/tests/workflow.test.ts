import { describe, expect, it } from 'vitest';
import { VERBATIM_READING_STYLE_PROMPT } from '@audio-underview/newscast-tts';
import type { JobDetails, NewscastResult } from '@audio-underview/newscast-core';
import type { Environment, NewscastRequest } from '../sources/environment.ts';
import { NewscastWorkflow } from '../sources/workflow.ts';
import { NEWSCAST_STATE_TIME_TO_LIVE_SECONDS } from '../sources/environment.ts';
import { useNewscastsInMemorySupabase, type Row } from './newscasts-in-memory-supabase.ts';
import {
  NO_KEY_ANSWER,
  ORGANIZE_ANSWER,
  SCRIPT_ANSWER,
  SIGNAL_PATH,
  TEXT_TO_SPEECH_PATH,
  TRANSCRIPTION_PATH,
  configureCrawler,
  configureScheduler,
  configureVault,
  crawlerCalls,
  createFakeStep,
  environment,
  keyStatusAnswer,
  newscastRequest,
  providerAnswer,
  receiveExecutionContext,
  schedulerCalls,
  signalAnswer,
  textToSpeechAnswer,
  transcriptionAnswer,
  vaultRequests,
  workflowEvent,
} from './workflow-harness.ts';

const supabase = useNewscastsInMemorySupabase();

const TWO_SPEAKER_SCRIPT = '화자1: 첫 문장입니다.\n화자2: 둘째 문장입니다.';

/** Long enough to split into two parts: 8 lines × 500 characters closes a part after the line that passes 3,000 */
const TWO_PART_SCRIPT = Array.from({ length: 8 }, (_value, index) => `화자${(index % 2) + 1}: ${'가'.repeat(500)}`).join('\n');

interface Run {
  newscastID: string;
  userUUID: string;
  stageRunID: string;
  stepNames: string[];
  outcome: PromiseSettledResult<void>;
  /** Every KV put the run made, with its options */
  statePuts: Array<{ key: string; options: KVNamespacePutOptions | undefined }>;
}

/** A KV binding that records every put, then passes it on */
function recordingState(puts: Run['statePuts']): KVNamespace {
  const state = environment.NEWSCAST_STATE;
  return {
    get: state.get.bind(state),
    list: state.list.bind(state),
    delete: state.delete.bind(state),
    put: async (key: string, value: never, options?: KVNamespacePutOptions) => {
      puts.push({ key, options });
      return state.put(key, value, options);
    },
  } as unknown as KVNamespace;
}

function seedNewscast(values: Row): Row {
  const row: Row = {
    id: crypto.randomUUID(),
    user_uuid: values.user_uuid,
    stage_run_id: values.stage_run_id,
    source_index: 0,
    status: 'running',
    stage: 'crawl-list',
    stage_progress: 0,
    overall_progress: 0,
    title: 'Title',
    title_override: null,
    request: {},
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

async function runWorkflow(
  request: NewscastRequest,
  options: { vault?: Record<string, unknown>; title?: string; environment?: Partial<Environment> } = {},
): Promise<Run> {
  const userUUID = crypto.randomUUID();
  const stageRunID = crypto.randomUUID();
  const row = seedNewscast({ user_uuid: userUUID, stage_run_id: stageRunID, request, title: options.title ?? 'Title' });
  await configureVault(userUUID, options.vault ?? {});
  const statePuts: Run['statePuts'] = [];
  const workflow = new NewscastWorkflow(await receiveExecutionContext(), {
    ...environment,
    NEWSCAST_STATE: recordingState(statePuts),
    ...options.environment,
  } as unknown as Environment);
  const { step, names } = createFakeStep();

  const [outcome] = await Promise.allSettled([
    workflow.run(workflowEvent({ newscastID: row.id as string, userUUID, stageRunID, request }), step),
  ]);
  return { newscastID: row.id as string, userUUID, stageRunID, stepNames: names, outcome, statePuts };
}

function rowOf(run: Run): Row {
  const row = (supabase.tables.newscasts ?? []).find((candidate) => candidate.id === run.newscastID);
  if (row === undefined) throw new Error('The newscast row is gone');
  return row;
}

function detailsOf(run: Run): JobDetails {
  return rowOf(run).details as JobDetails;
}

function resultOf(run: Run): NewscastResult {
  return rowOf(run).result as NewscastResult;
}

/** A user with a Google key and no OpenAI key, so the captions keep the estimate */
const VERBATIM_VAULT = {
  [`proxy:google:${TEXT_TO_SPEECH_PATH}`]: textToSpeechAnswer(),
  'keys/status': keyStatusAnswer(['google']),
};

describe('a verbatim newscast (design §3)', () => {
  it('runs NO organize and NO script step, makes the audio, finishes, and reports the stage run', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true } }),
      { vault: VERBATIM_VAULT, title: '첫 문장입니다.' },
    );

    expect(run.outcome.status).toBe('fulfilled');
    expect(run.stepNames).toEqual(['tts-part-1-chunk-0', 'check-alignment-key', 'merge-part-1', 'finalize', 'report-stage-run']);
    expect(rowOf(run)).toMatchObject({ status: 'done', stage: 'done', overall_progress: 1 });
    // The guarantee the whole feature exists for: what was pasted is what is read.
    expect(resultOf(run).script).toEqual([
      { speaker: 1, text: '첫 문장입니다.' },
      { speaker: 2, text: '둘째 문장입니다.' },
    ]);
    expect(resultOf(run).parts?.map((part) => part.audioKey)).toEqual([`${run.newscastID}/part-1`]);
    expect(resultOf(run).signalAudioKey).toBeUndefined();
    expect(detailsOf(run).crawlList).toMatchObject({ count: 1, titles: ['첫 문장입니다.'] });
    expect(detailsOf(run).script).toBeUndefined();

    const audio = await environment.NEWSCAST_AUDIO.get(`${run.newscastID}/part-1`);
    expect(audio?.httpMetadata?.contentType).toBe('audio/mpeg');
    expect((await audio?.arrayBuffer())?.byteLength).toBeGreaterThan(0);

    expect(await schedulerCalls(run.stageRunID)).toEqual([{
      method: 'complete',
      stageRunID: run.stageRunID,
      output: { newscasts: [{ id: run.newscastID, status: 'done', title: '첫 문장입니다.' }] },
    }]);
  });

  it('makes every provider call through the vault with the user and the internal token, never with a key', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true } }),
      { vault: VERBATIM_VAULT },
    );

    const requests = await vaultRequests(run.userUUID);
    expect(requests.map((request) => [request.route, request.body.provider, request.body.path])).toEqual([
      ['proxy', 'google', TEXT_TO_SPEECH_PATH],
      // Whether the user has an OpenAI key for the Whisper alignment; this one has none
      ['keys/status', undefined, undefined],
    ]);
    expect(requests.every((request) => request.token === 'test-vault-token')).toBe(true);
    // The reading register, NOT the two-host chat directive
    expect(requests[0].body.body).toContain(VERBATIM_READING_STYLE_PROMPT.slice(0, 20));
    expect(JSON.stringify(requests)).not.toMatch(/x-goog-api-key|authorization/i);
  });

  it('puts the chunk PCM and the checkpoints in KV with the 7-day TTL, and deletes them at the end', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true } }),
      { vault: VERBATIM_VAULT },
    );

    expect(run.statePuts.map((put) => put.key)).toEqual([
      `seg/${run.newscastID}/p1/0`,
      `chk/${run.userUUID}/${run.newscastID}/tts/p1`,
      `chk/${run.userUUID}/${run.newscastID}/part/p1`,
    ]);
    expect(run.statePuts.every((put) => put.options?.expirationTtl === NEWSCAST_STATE_TIME_TO_LIVE_SECONDS)).toBe(true);
    expect(NEWSCAST_STATE_TIME_TO_LIVE_SECONDS).toBe(604_800);
    expect((await environment.NEWSCAST_STATE.list({ prefix: `seg/${run.newscastID}/` })).keys).toEqual([]);
    expect((await environment.NEWSCAST_STATE.list({ prefix: `chk/${run.userUUID}/` })).keys).toEqual([]);
  });
});

describe('the signal setting (design §2)', () => {
  it('makes the sting for two or more parts when the setting is on', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_PART_SCRIPT, verbatim: true }, signal: true }),
      { vault: { ...VERBATIM_VAULT, [`proxy:google:${SIGNAL_PATH}`]: signalAnswer() } },
    );

    expect(run.outcome.status).toBe('fulfilled');
    expect(run.stepNames).toContain('generate-signal');
    expect(resultOf(run).parts).toHaveLength(2);
    expect(resultOf(run).signalAudioKey).toBe(`${run.newscastID}/signal`);
    expect(detailsOf(run).signal).toEqual({ generated: true, bytes: 3 });
    const signal = await environment.NEWSCAST_AUDIO.get(`${run.newscastID}/signal`);
    expect(await signal?.text()).toBe('ABC');
  });

  it('makes no sting, and shows none, when the setting is off', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_PART_SCRIPT, verbatim: true }, signal: false }),
      { vault: VERBATIM_VAULT },
    );

    expect(run.outcome.status).toBe('fulfilled');
    expect(run.stepNames).not.toContain('generate-signal');
    expect(resultOf(run).parts).toHaveLength(2);
    expect(resultOf(run).signalAudioKey).toBeUndefined();
    expect(detailsOf(run).signal).toBeUndefined();
    expect((await vaultRequests(run.userUUID)).some((request) => request.body.path === SIGNAL_PATH)).toBe(false);
  });

  it('makes no sting for one part even when the setting is on', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true }, signal: true }),
      { vault: VERBATIM_VAULT },
    );

    expect(run.stepNames).not.toContain('generate-signal');
    expect(resultOf(run).signalAudioKey).toBeUndefined();
  });

  it('still ships the newscast when the user has no Google key for the sting', async () => {
    // TTS answers on its own path, the sting finds no key: the parts advance in silence
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_PART_SCRIPT, verbatim: true }, signal: true }),
      { vault: { ...VERBATIM_VAULT, [`proxy:google:${SIGNAL_PATH}`]: NO_KEY_ANSWER } },
    );

    expect(run.outcome.status).toBe('fulfilled');
    expect(rowOf(run).status).toBe('done');
    expect(detailsOf(run).signal).toEqual({ generated: false });
    expect(resultOf(run).signalAudioKey).toBeUndefined();
  });
});

describe('the Whisper alignment (design §4)', () => {
  function openAIRequests(requests: Awaited<ReturnType<typeof vaultRequests>>) {
    return requests.filter((request) => request.route === 'proxy' && request.body.provider === 'openai');
  }

  it('asks for the OpenAI key once, and without one transcribes nothing and keeps the estimated timings', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_PART_SCRIPT, verbatim: true } }),
      { vault: VERBATIM_VAULT },
    );

    expect(run.outcome.status).toBe('fulfilled');
    const requests = await vaultRequests(run.userUUID);
    // Once for the newscast, though it merges two parts
    expect(requests.filter((request) => request.route === 'keys/status')).toEqual([
      { userId: run.userUUID, route: 'keys/status', method: 'POST', token: 'test-vault-token', body: { userId: run.userUUID } },
    ]);
    expect(openAIRequests(requests)).toEqual([]);
    expect(detailsOf(run).merge).toMatchObject({ aligned: false });
    const parts = resultOf(run).parts ?? [];
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      // The proportional estimate: one segment per line, no words, tiling the part
      expect(part.segments).toHaveLength(part.script.length);
      expect(part.segments.every((segment) => segment.words === undefined)).toBe(true);
      expect(part.segments[0].startMs).toBe(0);
      const last = part.segments[part.segments.length - 1];
      expect(last.startMs + last.durationMs).toBe(part.durationMs);
    }
  });

  it('transcribes the part on the OpenAI key of the user when the status shows one, and uses the aligned timings', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true } }),
      {
        vault: {
          [`proxy:google:${TEXT_TO_SPEECH_PATH}`]: textToSpeechAnswer(),
          'keys/status': keyStatusAnswer(['google', 'openai']),
          [`proxy:openai:${TRANSCRIPTION_PATH}`]: transcriptionAnswer(['첫', '문장입니다.', '둘째', '문장입니다.']),
        },
      },
    );

    expect(run.outcome.status).toBe('fulfilled');
    const transcriptions = openAIRequests(await vaultRequests(run.userUUID));
    expect(transcriptions).toHaveLength(1);
    expect(transcriptions[0].body).toMatchObject({ path: TRANSCRIPTION_PATH, bodyBase64: expect.any(String) });
    expect(detailsOf(run).merge).toMatchObject({ aligned: true, words: 4 });
    const [part] = resultOf(run).parts ?? [];
    expect(part.segments.map((segment) => segment.words?.map((word) => word.text))).toEqual([
      ['첫', '문장입니다.'],
      ['둘째', '문장입니다.'],
    ]);
  });

  it.each([
    ['cannot be reached', { status: 'unreachable' }],
    ['is refused', { status: 503, body: { error: 'vault_unavailable' } }],
  ])('attempts the alignment, as before, when the key status %s', async (_case, answer) => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true } }),
      { vault: { [`proxy:google:${TEXT_TO_SPEECH_PATH}`]: textToSpeechAnswer(), 'keys/status': answer, 'proxy:openai': NO_KEY_ANSWER } },
    );

    expect(run.outcome.status).toBe('fulfilled');
    expect(rowOf(run).status).toBe('done');
    expect(openAIRequests(await vaultRequests(run.userUUID)).map((request) => request.body.path)).toEqual([TRANSCRIPTION_PATH]);
    // The attempt found no key, so the estimate stays
    expect(detailsOf(run).merge).toMatchObject({ aligned: false });
  });
});

describe('a newscast of a listed article', () => {
  it('reads the article through the crawler manager, writes the script on the user key, and finishes', async () => {
    const id = crypto.randomUUID();
    const entry = { title: '목록의 기사', originalUrl: `https://example.com/${id}`, discussionUrl: `https://news.hada.io/topic?id=${id}` };
    await configureCrawler('article-content', { url: entry.originalUrl }, { value: { type: 'web', result: '기사 본문입니다.' } });
    await configureCrawler('geeknews-summary', { url: entry.discussionUrl }, { value: { type: 'web', result: '긱뉴스 요약입니다.' } });
    await configureCrawler('hn-search', undefined, { value: { type: 'data', result: null } });

    const run = await runWorkflow(newscastRequest({ entries: [entry] }), {
      vault: { ...VERBATIM_VAULT, 'proxy:google': [ORGANIZE_ANSWER, SCRIPT_ANSWER] },
      title: entry.title,
    });

    expect(run.outcome.status).toBe('fulfilled');
    expect(run.stepNames).toEqual([
      'crawl-articles', 'organize', 'script-part-1', 'tts-part-1-chunk-0', 'check-alignment-key', 'merge-part-1', 'finalize', 'report-stage-run',
    ]);
    expect(resultOf(run).sources).toEqual([{ ...entry, content: '기사 본문입니다.', geeknewsSummary: '긱뉴스 요약입니다.', hackerNewsComments: '' }]);
    expect(resultOf(run).script).toEqual([
      { speaker: 1, text: '안녕하세요, 오늘의 소식입니다.' },
      { speaker: 2, text: '네, 핵심 사실부터 보시죠.' },
    ]);
    expect(detailsOf(run)).toMatchObject({
      crawlList: { count: 1, titles: [entry.title] },
      organize: { provider: 'google', unitCount: 1, partCount: 1 },
      script: { provider: 'google', turns: 2 },
    });
    const calls = (await crawlerCalls()).filter((call) => call.input.url.includes(id));
    expect(calls.map((call) => call.name).sort()).toEqual(['article-content', 'geeknews-summary', 'hn-search']);
    const scriptRequests = (await vaultRequests(run.userUUID)).filter((request) => request.body.path !== TEXT_TO_SPEECH_PATH && request.body.provider === 'google');
    expect(scriptRequests).toHaveLength(2);
    expect(scriptRequests[0].body.body).toContain(entry.title);
  });
});

describe('a newscast of { url }', () => {
  it('reads the page with article-content alone', async () => {
    const url = `https://example.com/${crypto.randomUUID()}`;
    await configureCrawler('article-content', { url }, { value: { type: 'web', result: '페이지 본문입니다.' } });

    const run = await runWorkflow(newscastRequest({ url }), {
      vault: { ...VERBATIM_VAULT, 'proxy:google': [ORGANIZE_ANSWER, SCRIPT_ANSWER] },
      title: url,
    });

    expect(run.outcome.status).toBe('fulfilled');
    expect(resultOf(run).sources).toEqual([{ title: url, originalUrl: url, discussionUrl: '', content: '페이지 본문입니다.', geeknewsSummary: '', hackerNewsComments: '' }]);
    const calls = (await crawlerCalls()).filter((call) => call.input.url.includes(encodeURIComponent(url)) || call.input.url === url);
    expect(calls.map((call) => call.name)).toEqual(['article-content']);
  });

  it('fails when the page cannot be read, instead of writing a script of the URL alone', async () => {
    const url = `https://example.com/${crypto.randomUUID()}`;
    await configureCrawler('article-content', { url }, { error: '[execution_failed] 404' });

    const run = await runWorkflow(newscastRequest({ url }), { vault: VERBATIM_VAULT, title: url });

    expect(run.outcome.status).toBe('rejected');
    expect(run.stepNames).toEqual(['crawl-articles', 'record-error', 'report-stage-run']);
    expect(rowOf(run)).toMatchObject({ status: 'error', error: `The article at ${url} could not be read.`, error_code: 'pipeline_failed' });
    expect(detailsOf(run).crawlArticles?.articles[0].degradations?.[0]).toContain('[execution_failed] 404');
    expect(await schedulerCalls(run.stageRunID)).toEqual([{
      method: 'fail',
      stageRunID: run.stageRunID,
      errorMessage: `All 1 newscasts failed: The article at ${url} could not be read.`,
    }]);
  });
});

describe('a newscast without the key it needs (design §4: blocked_no_key)', () => {
  it('ends as blocked_no_key at organize when the user has no key for the script provider', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: '붙여넣은 기사 본문입니다.' } }),
      { vault: { proxy: NO_KEY_ANSWER } },
    );

    expect(run.outcome.status).toBe('rejected');
    expect(run.stepNames).toEqual(['organize', 'record-error', 'report-stage-run']);
    expect(rowOf(run)).toMatchObject({ status: 'error', error_code: 'blocked_no_key' });
    expect(rowOf(run).error).toContain('google: no key is registered for this provider.');
    expect(detailsOf(run).failure?.stage).toBe('organize');
    const [report] = await schedulerCalls(run.stageRunID);
    expect(report).toMatchObject({ method: 'fail' });
    expect(report.errorMessage).toContain('All 1 newscasts failed: google: no key is registered');
  });

  it('ends as blocked_no_key after ONE TTS attempt when Google refuses the key', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true } }),
      { vault: { [`proxy:google:${TEXT_TO_SPEECH_PATH}`]: providerAnswer('{"error":"API key not valid"}', 401) } },
    );

    expect(run.outcome.status).toBe('rejected');
    expect(rowOf(run)).toMatchObject({ status: 'error', error_code: 'blocked_no_key' });
    expect(detailsOf(run).failure?.stage).toBe('tts');
    // The refused key is presented once, never retried
    expect((await vaultRequests(run.userUUID)).filter((request) => request.body.path === TEXT_TO_SPEECH_PATH)).toHaveLength(1);
  });

  it('records any other failure as pipeline_failed, with the chunk that failed', async () => {
    const run = await runWorkflow(
      newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true } }),
      { vault: { [`proxy:google:${TEXT_TO_SPEECH_PATH}`]: providerAnswer('overloaded', 503) } },
    );

    expect(run.outcome.status).toBe('rejected');
    expect(rowOf(run)).toMatchObject({ status: 'error', error_code: 'pipeline_failed' });
    expect(detailsOf(run).failure).toMatchObject({ stage: 'tts', failedChunk: 0 });
    expect(rowOf(run).error).toContain('TTS part 1 chunk 1/1');
  });
});

describe('the report to the scheduler (design §1)', () => {
  it('reports progress while another newscast of the stage run is still running', async () => {
    const userUUID = crypto.randomUUID();
    const stageRunID = crypto.randomUUID();
    const request = newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true } });
    const first = seedNewscast({ user_uuid: userUUID, stage_run_id: stageRunID, request });
    seedNewscast({ user_uuid: userUUID, stage_run_id: stageRunID, source_index: 1, request });
    await configureVault(userUUID, VERBATIM_VAULT);
    const workflow = new NewscastWorkflow(await receiveExecutionContext(), environment);

    await workflow.run(workflowEvent({ newscastID: first.id as string, userUUID, stageRunID, request }), createFakeStep().step);

    expect(await schedulerCalls(stageRunID)).toEqual([
      { method: 'reportProgress', stageRunID, progress: { message: '1 of 2 newscasts finished', completed: 1, total: 2 } },
    ]);
  });

  it('keeps a finished newscast finished when the report cannot be sent', async () => {
    const userUUID = crypto.randomUUID();
    const stageRunID = crypto.randomUUID();
    const request = newscastRequest({ customArticle: { content: TWO_SPEAKER_SCRIPT, verbatim: true } });
    const row = seedNewscast({ user_uuid: userUUID, stage_run_id: stageRunID, request });
    await configureVault(userUUID, VERBATIM_VAULT);
    await configureScheduler(stageRunID, { complete: { error: 'instance unreachable' } });
    const workflow = new NewscastWorkflow(await receiveExecutionContext(), environment);

    await expect(
      workflow.run(workflowEvent({ newscastID: row.id as string, userUUID, stageRunID, request }), createFakeStep().step),
    ).resolves.toBeUndefined();
    expect(row.status).toBe('done');
  });
});
