import { describe, test, expect } from 'vitest';
import type { JobDetails, JobStatus } from '@audio-underview/newscast-core';
import { jobSourceModeFor, skippedStageMetric } from './job-source-mode.ts';

const CRAWL_TELEMETRY: JobDetails = {
  crawlList: { count: 1, titles: ['List title'], bytes: 1_200 },
};

/** A running newscast carrying exactly the `details` under test. */
function statusWith(details: JobDetails, overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    id: 'job',
    stage: 'tts',
    stageProgress: 0.5,
    overallProgress: 0.6,
    status: 'running',
    details,
    ...overrides,
  };
}

describe('jobSourceModeFor — the explicit flag wins', () => {
  test('trusts details.customArticle even when crawl telemetry exists', () => {
    // A direct-input newscast still records `crawlList` for its running title, and
    // reading that as "a crawl ran" made the crawl rows look busy
    const mode = jobSourceModeFor(statusWith({ ...CRAWL_TELEMETRY, customArticle: { verbatim: true } }));

    expect(mode).toEqual({ isDirectInput: true, isVerbatim: true });
  });

  test('reads a declared non-verbatim direct-input newscast as scripted', () => {
    const mode = jobSourceModeFor(statusWith({ ...CRAWL_TELEMETRY, customArticle: { verbatim: false } }));

    expect(mode).toEqual({ isDirectInput: true, isVerbatim: false });
  });

  test('falls back to the legacy inference when no flag was recorded', () => {
    const legacyPasted = statusWith(
      {},
      {
        stage: 'done',
        status: 'done',
        result: {
          sources: [{ title: 'Pasted text', originalUrl: '', discussionUrl: '', content: 'Body' }],
          script: [],
          segments: [],
          audioKey: 'job/part-1',
        },
      },
    );

    expect(jobSourceModeFor(legacyPasted)).toEqual({ isDirectInput: true, isVerbatim: false });
  });

  test('leaves a crawled newscast alone under the legacy inference', () => {
    const crawled = statusWith({
      ...CRAWL_TELEMETRY,
      crawlArticles: {
        articles: [{ title: 'Article', originalBytes: 100, geeknewsBytes: 10, hackerNewsBytes: 0 }],
        totalBytes: 110,
      },
    });

    expect(jobSourceModeFor(crawled)).toEqual({ isDirectInput: false, isVerbatim: false });
  });
});

describe('skippedStageMetric', () => {
  test('labels the crawl stages of any direct-input newscast', () => {
    const mode = { isDirectInput: true, isVerbatim: false };
    expect(skippedStageMetric('crawl-list', mode)).toBe('Direct input');
    expect(skippedStageMetric('crawl-articles', mode)).toBe('Direct input');
    expect(skippedStageMetric('organize', mode)).toBeUndefined();
    expect(skippedStageMetric('script', mode)).toBeUndefined();
  });

  test('additionally labels organize and script on a verbatim newscast', () => {
    const mode = { isDirectInput: true, isVerbatim: true };
    expect(skippedStageMetric('organize', mode)).toBe('Read verbatim');
    expect(skippedStageMetric('script', mode)).toBe('Read verbatim');
    expect(skippedStageMetric('tts', mode)).toBeUndefined();
    expect(skippedStageMetric('merge', mode)).toBeUndefined();
  });

  test('labels nothing on a crawled newscast', () => {
    const mode = { isDirectInput: false, isVerbatim: false };
    for (const stage of ['crawl-list', 'crawl-articles', 'organize', 'script'] as const) {
      expect(skippedStageMetric(stage, mode)).toBeUndefined();
    }
  });
});
