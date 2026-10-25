import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import type { JobDetails, JobStatus } from '@audio-underview/newscast-core';
import { StageRow, StageRowList, stageKeyMetric, stageRowStateFor } from './StageRow.tsx';

/** A healthy organize block (the multi-part case). */
const ORGANIZE: NonNullable<JobDetails['organize']> = {
  provider: 'google',
  model: 'gemini-2.5-flash',
  unitCount: 23,
  estimatedScriptCharacters: 11_700,
  partCount: 2,
  turnTargets: [50, 41],
  promptTokens: 4_200,
  completionTokens: 3_100,
};

/** A completed multi-part newscast's telemetry — every stage produced something. */
const DETAILS: JobDetails = {
  timings: {
    'crawl-list': { startedAt: 1_000, finishedAt: 3_500, durationMs: 2_500 },
    script: { startedAt: 10_000, finishedAt: 22_400, durationMs: 12_400 },
    tts: { startedAt: 30_000 },
  },
  crawlList: { count: 1, titles: ['The first article'], bytes: 27_546 },
  crawlArticles: {
    totalBytes: 27_546,
    articles: [
      {
        title: 'The first article',
        originalBytes: 20_000,
        geeknewsBytes: 7_546,
        hackerNewsBytes: 0,
        degradations: ['hackernews: HTTP 403'],
      },
    ],
  },
  organize: ORGANIZE,
  script: {
    provider: 'google',
    model: 'gemini-2.5-pro',
    turns: 117,
    characters: 9_100,
    promptTokens: 5_252,
    completionTokens: 8_100,
  },
  tts: { chunks: 15, audioDurationMs: 1_190_000 },
  merge: { mp3Bytes: 19_084_083, aligned: true, words: 3_400 },
  partsSummary: [
    { index: 1, turns: 41, characters: 3_170, audioDurationMs: 388_000 },
    { index: 2, turns: 48, characters: 3_744, audioDurationMs: 459_000 },
  ],
};

function doneStatus(details: JobDetails = DETAILS): JobStatus {
  return {
    id: 'job-done',
    stage: 'done',
    stageProgress: 1,
    overallProgress: 1,
    status: 'done',
    details,
  };
}

function textOf(locator: ReturnType<typeof page.getByRole>): string {
  return locator.element().textContent ?? '';
}

describe('StageRow — compact line', () => {
  test('renders the label, the one key metric, and the recorded duration', async () => {
    await render(<StageRow stage="script" state="complete" details={DETAILS} />);

    const row = page.getByRole('button', { name: /Write script/ });
    await expect.element(row).toHaveTextContent('Write script');
    await expect.element(row).toHaveTextContent('117 turns');
    await expect.element(row).toHaveTextContent('12.4s');
    // The full detail stays behind the row until it is clicked
    expect(page.getByRole('dialog').query()).toBeNull();
  });

  test('shows the live elapsed of the active stage from the shared tick', async () => {
    await render(<StageRow stage="tts" state="active" details={DETAILS} nowMilliseconds={42_400} />);

    // tts started at 30_000 and has not finished — 12.4s and still counting
    await expect.element(page.getByRole('button', { name: /Synthesize speech/ })).toHaveTextContent('12.4s');
  });

  test('falls back to "running" when the active stage has no recorded start', async () => {
    await render(<StageRow stage="merge" state="active" nowMilliseconds={42_400} />);

    await expect.element(page.getByRole('button', { name: /Merge audio/ })).toHaveTextContent('running');
  });

  test('shows no time for a stage that has not started', async () => {
    const screen = await render(<StageRow stage="merge" state="pending" details={DETAILS} />);

    expect(screen.container.textContent).toBe('Merge audio18.2 MB');
  });
});

describe('StageRow — detail dialog', () => {
  test('opens the full stage detail on click and closes again', async () => {
    await render(<StageRow stage="crawl-list" state="complete" details={DETAILS} />);

    await page.getByRole('button', { name: /Fetch list/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Fetch list' });
    await expect.element(dialog).toHaveTextContent('1 article · 26.9 KB');
    await expect.element(dialog).toHaveTextContent('The first article');
    await expect.element(dialog).toHaveTextContent('duration 2.5s');

    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
  });

  test('carries the organize model, tokens, turn targets, and per-part rollup', async () => {
    await render(<StageRow stage="organize" state="complete" details={DETAILS} />);

    await page.getByRole('button', { name: /Organize material/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Organize material' });
    await expect.element(dialog).toHaveTextContent('gemini-2.5-flash');
    const text = textOf(dialog);
    expect(text).toContain('23 units');
    expect(text).toContain('2 parts');
    expect(text).toContain('11,700 est chars');
    expect(text).toContain('turn targets 50 · 41');
    expect(text).toContain('prompt 4,200 · completion 3,100 tokens');
    // The per-part rollup belongs to the stage that planned the parts
    expect(text).toContain('Part 1 · 41 turns · 3,170 chars');
    expect(text).toContain('Part 2 · 48 turns · 3,744 chars');
    expect(text).not.toContain('degraded');
  });

  test('flags a degraded (single-part fallback) organize run', async () => {
    await render(
      <StageRow
        stage="organize"
        state="complete"
        details={{ organize: { ...ORGANIZE, unitCount: 0, partCount: 1, turnTargets: [41], degraded: true } }}
      />,
    );

    await page.getByRole('button', { name: /Organize material/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Organize material' });
    await expect.element(dialog).toHaveTextContent('0 units');
    await expect.element(dialog).toHaveTextContent('1 part');
    await expect.element(dialog).toHaveTextContent('degraded → single part');
  });

  test('shows the length factor only when it scaled the sizing', async () => {
    const scaled = await render(
      <StageRow stage="organize" state="complete" details={{ organize: { ...ORGANIZE, lengthFactor: 0.6 } }} />,
    );
    await page.getByRole('button', { name: /Organize material/ }).click();
    await expect.element(page.getByRole('dialog')).toHaveTextContent('length ×0.6');
    await scaled.unmount();

    // The default 'standard' factor (1.0) stays hidden to avoid clutter
    await render(<StageRow stage="organize" state="complete" details={{ organize: { ...ORGANIZE, lengthFactor: 1 } }} />);
    await page.getByRole('button', { name: /Organize material/ }).click();
    await expect.element(page.getByRole('dialog')).toBeVisible();
    expect(textOf(page.getByRole('dialog'))).not.toContain('length ×');
  });

  test('explains a stage that recorded nothing instead of showing an empty dialog', async () => {
    await render(<StageRow stage="merge" state="pending" />);

    await page.getByRole('button', { name: /Merge audio/ }).click();

    await expect
      .element(page.getByRole('dialog', { name: 'Merge audio' }))
      .toHaveTextContent('No details recorded for this stage yet.');
  });

  test('surfaces the persisted failure diagnosis on the stage that threw', async () => {
    await render(
      <StageRow
        stage="script"
        state="error"
        details={{
          scriptRequest: { provider: 'google', model: 'gemini-2.5-pro', effort: 'high' },
          failure: {
            stage: 'script',
            message: 'Gemini refused the request',
            stopReason: 'max_tokens',
            at: '2026-07-24T01:02:03.000Z',
          },
        }}
      />,
    );

    await page.getByRole('button', { name: /Write script/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Write script' });
    await expect.element(dialog).toHaveTextContent('Gemini refused the request');
    await expect.element(dialog).toHaveTextContent('stop reason max_tokens');
    await expect.element(dialog).toHaveTextContent('requested google · gemini-2.5-pro · effort high');
  });
});

describe('stageKeyMetric — the one number per stage', () => {
  test('derives the glanceable figure for every stage', () => {
    expect(stageKeyMetric('crawl-list', DETAILS)).toBe('1 article · 26.9 KB');
    expect(stageKeyMetric('crawl-articles', DETAILS)).toBe('1 article · 26.9 KB');
    expect(stageKeyMetric('organize', DETAILS)).toBe('23 units · 2 parts');
    expect(stageKeyMetric('script', DETAILS)).toBe('117 turns');
    expect(stageKeyMetric('tts', DETAILS)).toBe('15 chunks · 19:50');
    expect(stageKeyMetric('merge', DETAILS)).toBe('18.2 MB');
  });

  test('is undefined before the stage produced telemetry', () => {
    expect(stageKeyMetric('script', undefined)).toBeUndefined();
    expect(stageKeyMetric('script', {})).toBeUndefined();
  });

  test('recovers a legacy newscast’s part count from the rollup alone', () => {
    expect(stageKeyMetric('organize', { partsSummary: DETAILS.partsSummary })).toBe('2 parts');
  });
});

describe('stageRowStateFor', () => {
  const running: JobStatus = {
    id: 'job-running',
    stage: 'script',
    stageProgress: 0.5,
    overallProgress: 0.5,
    status: 'running',
    details: DETAILS,
  };

  test('splits a running newscast into complete / active / pending', () => {
    expect(stageRowStateFor('crawl-list', running)).toBe('complete');
    expect(stageRowStateFor('script', running)).toBe('active');
    expect(stageRowStateFor('tts', running)).toBe('pending');
  });

  test('marks the stage that threw as errored rather than active', () => {
    const failed: JobStatus = {
      ...running,
      status: 'error',
      error: 'boom',
      details: { ...DETAILS, failure: { stage: 'script', message: 'boom', at: '2026-07-24T00:00:00.000Z' } },
    };
    expect(stageRowStateFor('script', failed)).toBe('error');
    expect(stageRowStateFor('crawl-list', failed)).toBe('complete');
    expect(stageRowStateFor('tts', failed)).toBe('pending');
  });

  test('marks a finished newscast’s untouched stage as skipped, not complete', () => {
    const legacy = doneStatus({
      crawlList: DETAILS.crawlList,
      crawlArticles: DETAILS.crawlArticles,
      script: DETAILS.script,
      tts: DETAILS.tts,
      merge: DETAILS.merge,
    });
    expect(stageRowStateFor('organize', legacy)).toBe('skipped');
    expect(stageRowStateFor('script', legacy)).toBe('complete');
  });
});

describe('stageRowStateFor — direct input and read verbatim', () => {
  /** A running verbatim newscast, with the crawlList telemetry the worker keeps. */
  const verbatimRunning: JobStatus = {
    id: 'job-verbatim',
    stage: 'tts',
    stageProgress: 0.4,
    overallProgress: 0.7,
    status: 'running',
    details: { customArticle: { verbatim: true }, crawlList: DETAILS.crawlList },
  };

  test('skips crawl, organize and script on a running verbatim newscast', () => {
    expect(stageRowStateFor('crawl-list', verbatimRunning)).toBe('skipped');
    expect(stageRowStateFor('crawl-articles', verbatimRunning)).toBe('skipped');
    expect(stageRowStateFor('organize', verbatimRunning)).toBe('skipped');
    expect(stageRowStateFor('script', verbatimRunning)).toBe('skipped');
    expect(stageRowStateFor('tts', verbatimRunning)).toBe('active');
    expect(stageRowStateFor('merge', verbatimRunning)).toBe('pending');
  });

  test('skips only the crawl stages on a declared non-verbatim pasted newscast', () => {
    const pastedRunning: JobStatus = {
      ...verbatimRunning,
      stage: 'script',
      details: { customArticle: { verbatim: false }, crawlList: DETAILS.crawlList },
    };

    expect(stageRowStateFor('crawl-list', pastedRunning)).toBe('skipped');
    expect(stageRowStateFor('organize', pastedRunning)).toBe('complete');
    expect(stageRowStateFor('script', pastedRunning)).toBe('active');
  });
});

describe('StageRowList', () => {
  test('renders one row per working stage in pipeline order', async () => {
    await render(<StageRowList status={doneStatus()} />);

    const labels = page
      .getByRole('button')
      .elements()
      .map((row) => row.textContent?.replace(/[0-9].*$/, '').trim());
    expect(labels).toEqual([
      'Fetch list',
      'Collect articles',
      'Organize material',
      'Write script',
      'Synthesize speech',
      'Merge audio',
    ]);
  });

  test('replaces the telemetry metric with the skip reason on a verbatim newscast', async () => {
    const verbatimDone: JobStatus = {
      id: 'job-verbatim',
      stage: 'done',
      stageProgress: 1,
      overallProgress: 1,
      status: 'done',
      details: {
        customArticle: { verbatim: true },
        // Recorded for the running title — and precisely what must NOT be shown on a stage that
        // never crawled anything
        crawlList: DETAILS.crawlList,
        tts: DETAILS.tts,
        merge: DETAILS.merge,
      },
    };

    await render(<StageRowList status={verbatimDone} />);

    const crawlRow = page.getByTestId('stage-row-crawl-list');
    await expect.element(crawlRow).toHaveTextContent('Direct input');
    expect(textOf(crawlRow)).not.toContain('1 article');
    await expect.element(page.getByTestId('stage-row-organize')).toHaveTextContent('Read verbatim');
    await expect.element(page.getByTestId('stage-row-script')).toHaveTextContent('Read verbatim');
    await expect.element(page.getByTestId('stage-row-tts')).toHaveTextContent('15 chunks');
  });

  test('leaves every skipped row non-interactive while the ran ones stay pressable', async () => {
    const verbatimRunning: JobStatus = {
      id: 'job-verbatim',
      stage: 'tts',
      stageProgress: 0.4,
      overallProgress: 0.7,
      status: 'running',
      details: { customArticle: { verbatim: true }, crawlList: DETAILS.crawlList },
    };

    await render(<StageRowList status={verbatimRunning} />);

    for (const stage of ['crawl-list', 'crawl-articles', 'organize', 'script'] as const) {
      expect(page.getByTestId(`stage-row-${stage}`).element().tagName).not.toBe('BUTTON');
    }
    expect(page.getByRole('button').elements().map((row) => row.getAttribute('data-testid'))).toEqual([
      'stage-row-tts',
      'stage-row-merge',
    ]);
  });
});

describe('StageRow — skipped rows', () => {
  test('renders a skipped stage as a plain row with no chevron and no dialog', async () => {
    await render(<StageRow stage="script" state="skipped" details={DETAILS} skippedMetric="Read verbatim" />);

    const row = page.getByTestId('stage-row-script');
    expect(row.element().tagName).not.toBe('BUTTON');
    expect(page.getByRole('button').query()).toBeNull();
    // The chevron is the "there is more behind this" affordance; nothing is
    expect(row.element().querySelector('svg')).toBeNull();
    await expect.element(row).toHaveTextContent('Read verbatim');

    await row.click();
    expect(page.getByRole('dialog').query()).toBeNull();
  });
});
