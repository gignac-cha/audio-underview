import { describe, expect, it } from 'vitest';
import type { NewscastResult } from '@audio-underview/newscast-core';
import {
  FALLBACK_SHARE_TITLE,
  parseIncludedMetadata,
  shareTokenPrefix,
  toPublicShareView,
  type PublicShareView,
  type ShareIncludedMetadata,
  type SharedNewscastRow,
} from '../sources/shares.ts';

/**
 * A DONE multi-part newscast whose stored payload carries EVERYTHING a public view
 * must not republish: the parts' R2 keys, the crawled article bodies, the voices,
 * the pasted article and a failure record. Every assertion below is written
 * against this one row so a leak has to survive a realistic newscast, not a
 * hand-trimmed fixture.
 */
const RESULT: NewscastResult = {
  sources: [
    {
      title: '이해가 새로운 병목이다',
      originalUrl: 'https://example.com/article',
      discussionUrl: 'https://news.hada.io/topic?id=1',
      content: 'SECRET-ARTICLE-BODY',
      geeknewsSummary: 'SECRET-GEEKNEWS-SUMMARY',
      hackerNewsComments: 'SECRET-HACKERNEWS-COMMENTS',
    },
  ],
  script: [
    { speaker: 1, text: '안녕하세요.' },
    { speaker: 2, text: '반갑습니다.' },
  ],
  segments: [{ index: 0, startMs: 0, durationMs: 4_200 }],
  audioKey: 'newscast-1/part-1',
  parts: [
    {
      index: 1,
      audioKey: 'newscast-1/part-1',
      script: [{ speaker: 1, text: '첫 번째 파트입니다.' }],
      segments: [
        {
          index: 0,
          startMs: 0,
          durationMs: 4_200,
          words: [{ text: '첫', startMs: 0, endMs: 800 }],
        },
      ],
      durationMs: 180_000,
    },
    {
      index: 2,
      audioKey: 'newscast-1/part-2',
      script: [{ speaker: 2, text: '두 번째 파트입니다.' }],
      segments: [{ index: 0, startMs: 0, durationMs: 5_000 }],
      durationMs: 120_000,
    },
  ],
  signalAudioKey: 'newscast-1/signal',
};

const REQUEST = {
  limit: 1,
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  effort: 'high',
  speaker1Voice: 'Charon',
  speaker2Voice: 'Leda',
  customArticle: { title: '붙여넣은 기사', content: 'SECRET-CUSTOM-ARTICLE-BODY' },
};

const DETAILS = {
  script: { provider: 'anthropic', model: 'claude-sonnet-5', turns: 12, characters: 3_000 },
  errorCode: 'pipeline_failed',
  failure: { stage: 'script', message: 'SECRET-FAILURE-MESSAGE', at: '2026-08-01T00:00:00.000Z' },
};

function buildNewscastRow(overrides: Partial<SharedNewscastRow> = {}): SharedNewscastRow {
  return {
    status: 'done',
    request: REQUEST,
    result: RESULT,
    details: DETAILS,
    title_override: null,
    created_at: '2026-08-01T09:30:00+00:00',
    ...overrides,
  };
}

/** Every metadata toggle on — the widest view a sharer can possibly publish. */
const EVERYTHING_ON: ShareIncludedMetadata = {
  displayName: '차진혁',
  email: 'user@example.com',
  showModel: true,
  showSourceLinks: true,
  showCreatedAt: true,
};

function viewOf(
  row: SharedNewscastRow = buildNewscastRow(),
  included: ShareIncludedMetadata = {},
): PublicShareView {
  const view = toPublicShareView(row, included);
  expect(view).not.toBeNull();
  return view as PublicShareView;
}

describe('parseIncludedMetadata', () => {
  it('keeps only the five known keys, and only when they are actually set', () => {
    expect(
      parseIncludedMetadata({
        displayName: '  차진혁  ',
        email: 'user@example.com',
        showModel: true,
        showSourceLinks: false,
        showCreatedAt: 'yes',
        // A client cannot invent a flag that publishes something new.
        showError: true,
        showKeyIdentity: true,
        userId: 'other-user',
      }),
    ).toEqual({
      displayName: '차진혁',
      email: 'user@example.com',
      showModel: true,
    });
  });

  it('treats blank/non-string profile values as "not shared"', () => {
    expect(parseIncludedMetadata({ displayName: '   ', email: 42 })).toEqual({});
  });

  it('caps the snapshot strings so one PUT cannot store an essay', () => {
    const parsed = parseIncludedMetadata({
      displayName: 'ㄱ'.repeat(500),
      email: `${'a'.repeat(500)}@example.com`,
    });
    expect(parsed.displayName).toHaveLength(100);
    expect(parsed.email).toHaveLength(254);
  });

  it('maps anything that is not an object to "nothing shared"', () => {
    for (const value of [null, undefined, 'metadata', 7, []]) {
      expect(parseIncludedMetadata(value)).toEqual({});
    }
  });
});

describe('toPublicShareView — the allowlist', () => {
  it('answers exactly the documented top-level keys', () => {
    expect(Object.keys(viewOf(buildNewscastRow(), EVERYTHING_ON)).sort()).toEqual([
      'hasSignalAudio',
      'metadata',
      'parts',
      'title',
      'version',
    ]);
  });

  it('answers exactly the documented part / segment / line keys', () => {
    const view = viewOf();
    expect(Object.keys(view.parts[0]).sort()).toEqual([
      'durationMs',
      'index',
      'script',
      'segments',
    ]);
    // `audioKey` is on the stored part and must not survive the projection: it
    // embeds the newscast id, which is the owner routes' path parameter.
    expect(Object.keys(view.parts[0])).not.toContain('audioKey');
    expect(Object.keys(view.parts[0].script[0]).sort()).toEqual(['speaker', 'text']);
    expect(Object.keys(view.parts[0].segments[0]).sort()).toEqual([
      'durationMs',
      'index',
      'startMs',
      'words',
    ]);
    expect(Object.keys(view.parts[0].segments[0].words?.[0] ?? {}).sort()).toEqual([
      'endMs',
      'startMs',
      'text',
    ]);
    // A part with no aligned words simply has no `words` key.
    expect(view.parts[1].segments[0].words).toBeUndefined();
  });

  it('leaks nothing from the newscast row, even with EVERY toggle on', () => {
    const serialized = JSON.stringify(viewOf(buildNewscastRow(), EVERYTHING_ON));
    for (const secret of [
      'SECRET-ARTICLE-BODY',
      'SECRET-GEEKNEWS-SUMMARY',
      'SECRET-HACKERNEWS-COMMENTS',
      'SECRET-CUSTOM-ARTICLE-BODY',
      'SECRET-FAILURE-MESSAGE',
      'speaker1Voice',
      'Charon',
      'audioKey',
      'user_uuid',
      'errorCode',
      'stage',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('publishes the parts, their timings and the signal flag', () => {
    const view = viewOf();
    expect(view.version).toBe(1);
    expect(view.parts.map((part) => part.index)).toEqual([1, 2]);
    expect(view.parts[0].durationMs).toBe(180_000);
    expect(view.parts[0].script).toEqual([{ speaker: 1, text: '첫 번째 파트입니다.' }]);
    expect(view.parts[0].segments[0].words).toEqual([{ text: '첫', startMs: 0, endMs: 800 }]);
    // The KEY itself stays server-side; the viewer only learns that a sting exists.
    expect(view.hasSignalAudio).toBe(true);
    expect(JSON.stringify(view)).not.toContain('newscast-1/signal');
  });

  it('reports hasSignalAudio false when the sting was never generated', () => {
    const withoutSignal = { ...RESULT, signalAudioKey: undefined };
    expect(viewOf(buildNewscastRow({ result: withoutSignal })).hasSignalAudio).toBe(false);
  });
});

describe('toPublicShareView — what is NOT shareable', () => {
  it('answers null for a newscast that is not done (running, error)', () => {
    for (const status of ['running', 'error']) {
      expect(toPublicShareView(buildNewscastRow({ status }), EVERYTHING_ON)).toBeNull();
    }
  });

  it('answers null for a done newscast whose result is missing or not an object', () => {
    expect(toPublicShareView(buildNewscastRow({ result: null }), {})).toBeNull();
    expect(toPublicShareView(buildNewscastRow({ result: '{oops' }), {})).toBeNull();
    expect(toPublicShareView(buildNewscastRow({ result: [] }), {})).toBeNull();
  });
});

describe('toPublicShareView — a result without parts', () => {
  it('turns the top-level legacy-reader fields into a single part 1', () => {
    const singleAudio: NewscastResult = {
      sources: RESULT.sources,
      script: RESULT.script,
      segments: [
        { index: 0, startMs: 0, durationMs: 4_200 },
        { index: 1, startMs: 4_200, durationMs: 5_800 },
      ],
      audioKey: 'newscast-1/part-1',
    };
    const view = viewOf(buildNewscastRow({ result: singleAudio }));

    expect(view.parts).toHaveLength(1);
    expect(view.parts[0].index).toBe(1);
    // No stored `durationMs` — it is derived from the timings.
    expect(view.parts[0].durationMs).toBe(10_000);
    expect(view.parts[0].script).toHaveLength(2);
    expect(view.hasSignalAudio).toBe(false);
  });

  it('renders a malformed result as an empty part rather than throwing', () => {
    const view = viewOf(buildNewscastRow({ result: { sources: null, script: 'nope' } }));
    expect(view.parts).toEqual([{ index: 1, durationMs: 0, script: [], segments: [] }]);
    expect(view.title).toBe(FALLBACK_SHARE_TITLE);
  });
});

describe('toPublicShareView — the title', () => {
  it("prefers the owner's title override", () => {
    expect(viewOf(buildNewscastRow({ title_override: '  손으로 고친 제목  ' })).title).toBe('손으로 고친 제목');
  });

  it('falls back to the first source title, then to a neutral label', () => {
    expect(viewOf().title).toBe('이해가 새로운 병목이다');
    expect(viewOf(buildNewscastRow({ title_override: '   ' })).title).toBe('이해가 새로운 병목이다');
    const titleless = { ...RESULT, sources: [] };
    expect(viewOf(buildNewscastRow({ result: titleless })).title).toBe(FALLBACK_SHARE_TITLE);
  });
});

describe('toPublicShareView — the metadata flags', () => {
  it('publishes {} when the sharer turned everything off', () => {
    expect(viewOf(buildNewscastRow(), {}).metadata).toEqual({});
  });

  it('publishes only the profile fields the sharer opted into', () => {
    expect(viewOf(buildNewscastRow(), { displayName: '차진혁' }).metadata).toEqual({
      sharedBy: { displayName: '차진혁' },
    });
    expect(viewOf(buildNewscastRow(), { email: 'user@example.com' }).metadata).toEqual({
      sharedBy: { email: 'user@example.com' },
    });
  });

  it('publishes the model set only with showModel', () => {
    expect(viewOf(buildNewscastRow(), { showModel: true }).metadata).toEqual({
      model: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' },
    });
    expect(viewOf(buildNewscastRow(), { showSourceLinks: true }).metadata.model).toBeUndefined();
  });

  it('reads the model set from details.request when the request column has none', () => {
    const row = buildNewscastRow({ request: 'not an object', details: { request: { provider: 'google', speaker1Voice: 'Charon' } } });
    expect(viewOf(row, { showModel: true }).metadata).toEqual({ model: { provider: 'google' } });
  });

  it('omits the model block entirely for a newscast with no recorded request', () => {
    expect(viewOf(buildNewscastRow({ request: null, details: {} }), { showModel: true }).metadata).toEqual({});
  });

  it('publishes source titles and links only, never the crawled bodies', () => {
    const metadata = viewOf(buildNewscastRow(), { showSourceLinks: true }).metadata;
    expect(metadata.sources).toEqual([
      {
        title: '이해가 새로운 병목이다',
        originalUrl: 'https://example.com/article',
        discussionUrl: 'https://news.hada.io/topic?id=1',
      },
    ]);
    expect(Object.keys(metadata.sources?.[0] ?? {}).sort()).toEqual([
      'discussionUrl',
      'originalUrl',
      'title',
    ]);
  });

  it('publishes the creation instant only with showCreatedAt', () => {
    expect(viewOf(buildNewscastRow(), { showCreatedAt: true }).metadata.createdAt).toBe('2026-08-01T09:30:00+00:00');
    // A `YYYY-MM-DD HH:MM:SS` UTC value is made an instant
    expect(viewOf(buildNewscastRow({ created_at: '2026-08-01 09:30:00' }), { showCreatedAt: true }).metadata.createdAt).toBe(
      '2026-08-01T09:30:00.000Z',
    );
    expect(viewOf(buildNewscastRow(), { showModel: true }).metadata.createdAt).toBeUndefined();
  });

  it('assembles every opted-in block together', () => {
    expect(viewOf(buildNewscastRow(), EVERYTHING_ON).metadata).toEqual({
      sharedBy: { displayName: '차진혁', email: 'user@example.com' },
      model: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' },
      sources: [
        {
          title: '이해가 새로운 병목이다',
          originalUrl: 'https://example.com/article',
          discussionUrl: 'https://news.hada.io/topic?id=1',
        },
      ],
      createdAt: '2026-08-01T09:30:00+00:00',
    });
  });
});

describe('shareTokenPrefix', () => {
  it('keeps 8 characters, which is never enough to open a link', () => {
    const token = '0189d3f2-4c1b-7c9a-9f2e-6b7c8d9e0f11';
    expect(shareTokenPrefix(token)).toBe('0189d3f2');
    expect(token.startsWith(shareTokenPrefix(token))).toBe(true);
    expect(shareTokenPrefix(token)).toHaveLength(8);
  });
});
