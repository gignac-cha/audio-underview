import { cleanup, renderHook } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import type { JobStatus, NewscastJobSummary } from '@audio-underview/newscast-core';
import { loadAuthenticationData } from '@audio-underview/sign-provider';
import { test, expect } from '../tests/extensions.ts';
import { worker } from '../tests/mocks/browser.ts';
import {
  audioURLForJob,
  audioURLForJobPart,
  clearMediaTokens,
  isPlayable,
  mediaTokenKey,
  newscastsEndpoint,
  signalAudioURLForJob,
  useNewscastJobDetail,
  useNewscastJobs,
} from './use-newscast-jobs.ts';

const NEWSCAST_URL = 'http://localhost:6666';
const TEST_CREDENTIAL = 'test-access-token';
// Short enough for a test to see several reads
const REFRESH_INTERVAL_MILLISECONDS = 40;

vi.mock('@audio-underview/sign-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@audio-underview/sign-provider')>();
  return {
    ...actual,
    loadAuthenticationData: vi.fn(),
  };
});

function signIn() {
  vi.mocked(loadAuthenticationData).mockReturnValue({
    user: { id: 'u1', name: 'Test', email: 'test@example.com', provider: 'google' },
    credential: TEST_CREDENTIAL,
    expiresAt: Date.now() + 3_600_000,
  });
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function summary(overrides: Partial<NewscastJobSummary> = {}): NewscastJobSummary {
  return {
    id: 'job-1',
    status: 'done',
    stage: 'done',
    overallProgress: 1,
    createdAt: '2026-10-26T04:00:00.000+00:00',
    title: 'A newscast',
    ...overrides,
  };
}

const DONE_JOB: JobStatus = {
  id: 'job-1',
  stage: 'done',
  stageProgress: 1,
  overallProgress: 1,
  status: 'done',
  result: {
    sources: [],
    script: [],
    segments: [],
    audioKey: 'job-1/part-1',
    parts: [{ index: 1, audioKey: 'job-1/part-1', script: [], segments: [], durationMs: 1_000 }],
  },
};

beforeEach(() => {
  vi.stubEnv('VITE_NEWSCAST_WORKER_URL', NEWSCAST_URL);
  signIn();
});

afterEach(async () => {
  // Unmounted before the URL goes, since a mounted hook builds audio URLs on it while it renders
  await cleanup();
  clearMediaTokens();
  vi.unstubAllEnvs();
});

describe('useNewscastJobs', () => {
  test('reads the data of GET /newscasts with the session credential', async () => {
    const authorizations: (string | null)[] = [];
    worker.use(
      http.get(`${NEWSCAST_URL}/newscasts`, ({ request }) => {
        authorizations.push(request.headers.get('Authorization'));
        return HttpResponse.json({ data: [summary()] });
      }),
    );
    const { wrapper } = createWrapper();

    const { result } = await renderHook(() => useNewscastJobs(), { wrapper });

    await vi.waitFor(() => expect(result.current.jobs).toEqual([summary()]));
    expect(authorizations[0]).toBe(`Bearer ${TEST_CREDENTIAL}`);
  });

  test('reads the list again while a newscast runs, and stops once none does', async () => {
    let reads = 0;
    worker.use(
      http.get(`${NEWSCAST_URL}/newscasts`, () => {
        reads += 1;
        return HttpResponse.json({
          data: [reads < 3 ? summary({ status: 'running', stage: 'tts', overallProgress: 0.5 }) : summary()],
        });
      }),
    );
    const { wrapper } = createWrapper();

    const { result } = await renderHook(
      () => useNewscastJobs({ refreshIntervalMilliseconds: REFRESH_INTERVAL_MILLISECONDS }),
      { wrapper },
    );

    await vi.waitFor(() => expect(result.current.jobs[0]?.status).toBe('done'));
    const readsWhenSettled = reads;
    await new Promise((resolve) => setTimeout(resolve, REFRESH_INTERVAL_MILLISECONDS * 4));
    expect(reads).toBe(readsWhenSettled);
  });

  test('reads the list again while a run that makes newscasts is in progress, before they are listed', async () => {
    let reads = 0;
    worker.use(
      http.get(`${NEWSCAST_URL}/newscasts`, () => {
        reads += 1;
        return HttpResponse.json({ data: [] });
      }),
    );
    const { wrapper } = createWrapper();

    await renderHook(
      () => useNewscastJobs({ isRunInProgress: true, refreshIntervalMilliseconds: REFRESH_INTERVAL_MILLISECONDS }),
      { wrapper },
    );

    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
  });

  test('reports a list it cannot read', async () => {
    worker.use(http.get(`${NEWSCAST_URL}/newscasts`, () => HttpResponse.json([summary()])));
    const { wrapper } = createWrapper();

    const { result } = await renderHook(() => useNewscastJobs(), { wrapper });

    await vi.waitFor(() =>
      expect(result.current.error?.message).toBe('The server sent a response this page cannot read.'),
    );
  });

  test('reports the error_description of a failed read', async () => {
    worker.use(
      http.get(`${NEWSCAST_URL}/newscasts`, () =>
        HttpResponse.json({ error: 'job_list_failed', error_description: 'Could not list the newscasts.' }, { status: 500 }),
      ),
    );
    const { wrapper } = createWrapper();

    const { result } = await renderHook(() => useNewscastJobs(), { wrapper });

    await vi.waitFor(() => expect(result.current.error?.message).toBe('Could not list the newscasts.'));
  });
});

describe('useNewscastJobDetail', () => {
  test('answers an audio URL only for a newscast that is done and has parts', async () => {
    expect(isPlayable(DONE_JOB)).toBe(true);
    expect(isPlayable({ ...DONE_JOB, result: { ...DONE_JOB.result!, parts: [] } })).toBe(false);
    expect(isPlayable({ ...DONE_JOB, status: 'running' })).toBe(false);

    worker.use(
      http.get(`${NEWSCAST_URL}/newscasts/job-1`, () => HttpResponse.json({ ...DONE_JOB, result: { ...DONE_JOB.result!, parts: [] } })),
      http.post(`${NEWSCAST_URL}/newscasts/job-1/media-token`, () => HttpResponse.json({ token: 't', expiresIn: 3600 })),
    );
    const { wrapper } = createWrapper();

    const { result } = await renderHook(() => useNewscastJobDetail('job-1'), { wrapper });

    await vi.waitFor(() => expect(result.current.status?.status).toBe('done'));
    expect(result.current.audioURL).toBeUndefined();
  });
});

/**
 * The audio URLs carry a media token that the detail hook mints and refreshes, never the session
 * credential (which authorizes every route), and nothing at all until the token arrives.
 */
describe('audio URLs', () => {
  const MEDIA_TOKEN = 'media-token-for-job-1';

  function answerMediaToken(token: () => string, requests: Request[] = []) {
    worker.use(
      http.get(`${NEWSCAST_URL}/newscasts/:id`, () => HttpResponse.json(DONE_JOB)),
      http.post(`${NEWSCAST_URL}/newscasts/:id/media-token`, ({ request }) => {
        requests.push(request);
        return HttpResponse.json({ token: token(), expiresIn: 3600 });
      }),
    );
  }

  /** Mount the detail hook for `jobID` and wait until its media token has landed. */
  async function withDetailHookFor(jobID: string) {
    const { queryClient, wrapper } = createWrapper();
    await renderHook(() => useNewscastJobDetail(jobID), { wrapper });
    await vi.waitFor(() => expect(audioURLForJob(jobID)).toContain('token='));
    return queryClient;
  }

  test('carries no credential at all before a media token has been fetched', () => {
    // The builders run during render, so "no token yet" must be a bare URL rather than a throw
    expect(audioURLForJob('job-1')).toBe(`${newscastsEndpoint()}/job-1/audio`);
    expect(audioURLForJobPart('job-1', 2)).toBe(`${newscastsEndpoint()}/job-1/audio?part=2`);
  });

  test('never puts the session credential in a URL', async () => {
    answerMediaToken(() => MEDIA_TOKEN);
    await withDetailHookFor('job-1');

    for (const url of [audioURLForJob('job-1'), audioURLForJobPart('job-1', 2), signalAudioURLForJob('job-1')]) {
      expect(url).not.toContain(TEST_CREDENTIAL);
    }
  });

  test('POSTs the media-token route with the Authorization header, not a URL credential', async () => {
    const requests: Request[] = [];
    answerMediaToken(() => MEDIA_TOKEN, requests);
    await withDetailHookFor('job-1');

    expect(requests[0]?.url).toBe(`${NEWSCAST_URL}/newscasts/job-1/media-token`);
    expect(requests[0]?.headers.get('Authorization')).toBe(`Bearer ${TEST_CREDENTIAL}`);
  });

  test('appends the media token, after any existing query parameter', async () => {
    answerMediaToken(() => MEDIA_TOKEN);
    await withDetailHookFor('job-1');

    expect(audioURLForJob('job-1')).toBe(`${NEWSCAST_URL}/newscasts/job-1/audio?token=${MEDIA_TOKEN}`);
    expect(audioURLForJobPart('job-1', 2)).toBe(`${NEWSCAST_URL}/newscasts/job-1/audio?part=2&token=${MEDIA_TOKEN}`);
    expect(signalAudioURLForJob('job-1')).toBe(`${NEWSCAST_URL}/newscasts/job-1/audio?part=signal&token=${MEDIA_TOKEN}`);
  });

  test("does not lend one newscast's token to another newscast", async () => {
    answerMediaToken(() => MEDIA_TOKEN);
    await withDetailHookFor('job-1');

    expect(audioURLForJob('job-2')).toBe(`${NEWSCAST_URL}/newscasts/job-2/audio`);
  });

  test('percent-encodes the token so a URL-unsafe character cannot break the query', async () => {
    answerMediaToken(() => 'a+b/c=d');
    await withDetailHookFor('job-1');

    expect(audioURLForJob('job-1')).toBe(`${NEWSCAST_URL}/newscasts/job-1/audio?token=a%2Bb%2Fc%3Dd`);
  });

  test('keeps an already-playing URL byte-identical when the token is refreshed', async () => {
    let minted = 0;
    answerMediaToken(() => {
      minted += 1;
      return `media-token-${minted}`;
    });
    const queryClient = await withDetailHookFor('job-1');
    const playingURL = audioURLForJobPart('job-1', 1);
    expect(playingURL).toContain('token=media-token-1');

    await queryClient.invalidateQueries({ queryKey: mediaTokenKey('job-1') });
    await vi.waitFor(() => expect(minted).toBe(2));

    // A changed <audio> src makes the browser drop its buffer and restart the track, so the URL
    // already playing is not rewritten...
    expect(audioURLForJobPart('job-1', 1)).toBe(playingURL);
    // ...while the part that has not started yet gets the fresh token
    expect(audioURLForJobPart('job-1', 2)).toContain('token=media-token-2');
  });

  test('degrades to the bare URL when signed out instead of throwing mid-render', async () => {
    answerMediaToken(() => MEDIA_TOKEN);
    await withDetailHookFor('job-1');

    vi.mocked(loadAuthenticationData).mockReturnValue(null);

    expect(audioURLForJob('job-1')).toBe(`${NEWSCAST_URL}/newscasts/job-1/audio`);
  });
});
