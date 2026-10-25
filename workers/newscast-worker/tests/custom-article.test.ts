import { describe, expect, it } from 'vitest';
import { MAX_PARALLEL_NEWSCASTS } from '@audio-underview/newscast-core';
import { VERBATIM_LINE_CHARACTER_LIMIT } from '@audio-underview/newscast-script/verbatim-script.ts';

import {
  MAXIMUM_ARTICLE_CONTENT_LENGTH,
  isVerbatimCustomArticle,
  parseCustomArticle,
  resolveCreateJobPlan,
  resolveCustomArticleDetails,
  resolveCustomArticleTitle,
  validateCustomArticleSource,
} from '../sources/custom-article.ts';

describe('parseCustomArticle (design §13)', () => {
  it('trims content and keeps a non-empty trimmed title', () => {
    expect(parseCustomArticle({ customArticle: { title: '  제목  ', content: '  본문  ' } })).toEqual({
      title: '제목',
      content: '본문',
    });
  });

  it('drops an empty/whitespace-only title (falls back to a derived one later)', () => {
    expect(parseCustomArticle({ customArticle: { title: '   ', content: '본문' } })).toEqual({
      content: '본문',
    });
  });

  it('carries the verbatim flag ONLY when the request set it to boolean true', () => {
    // The flag decides whether an LLM ever sees the text, so anything other than a
    // real `true` must read as the default (off) — and an ordinary pasted article
    // keeps the field absent entirely, so its stored snapshot is unchanged.
    expect(parseCustomArticle({ customArticle: { content: '화자1: 안녕하세요.', verbatim: true } })).toEqual({
      content: '화자1: 안녕하세요.',
      verbatim: true,
    });
    for (const truthy of ['true', 1, {}]) {
      expect(parseCustomArticle({ customArticle: { content: '본문', verbatim: truthy } })).toEqual({
        content: '본문',
      });
    }
    expect(parseCustomArticle({ customArticle: { content: '본문' } })).toEqual({ content: '본문' });
  });

  it('returns undefined when there is no custom article, or content is not a string', () => {
    expect(parseCustomArticle({ entries: [] })).toBeUndefined();
    expect(parseCustomArticle(null)).toBeUndefined();
    expect(parseCustomArticle({ customArticle: null })).toBeUndefined();
    expect(parseCustomArticle({ customArticle: { title: 'x' } })).toBeUndefined();
    expect(parseCustomArticle({ customArticle: { content: 42 } })).toBeUndefined();
  });
});

describe('validateCustomArticleSource (design §13)', () => {
  it('rejects a request that also carries GeekNews entries (conflicting_source, checked first)', () => {
    // The conflict wins even when the content itself would also be invalid.
    expect(validateCustomArticleSource({ content: '' }, true)).toBe('conflicting_source');
    expect(validateCustomArticleSource({ content: '본문' }, true)).toBe('conflicting_source');
  });

  it('rejects empty content (empty_content)', () => {
    expect(validateCustomArticleSource({ content: '' }, false)).toBe('empty_content');
  });

  it('rejects content over the 24,000-char cap (content_too_long, never truncated)', () => {
    const tooLong = 'a'.repeat(MAXIMUM_ARTICLE_CONTENT_LENGTH + 1);
    expect(validateCustomArticleSource({ content: tooLong }, false)).toBe('content_too_long');
    // Exactly at the cap is still acceptable.
    const atCap = 'a'.repeat(MAXIMUM_ARTICLE_CONTENT_LENGTH);
    expect(validateCustomArticleSource({ content: atCap }, false)).toBeNull();
  });

  it('accepts a normal pasted article', () => {
    expect(validateCustomArticleSource({ content: '본문', title: '제목' }, false)).toBeNull();
  });

  it('rejects a verbatim request whose text parses to no utterances (empty_verbatim_script)', () => {
    // Blank lines and bare prefixes carry nothing to read. A verbatim job has no
    // LLM stage that would notice later — it would walk straight into TTS with an
    // empty script — so the gate is the only place this can be caught.
    for (const content of ['화자1:', '화자1:\n화자2：\n  ', ' ']) {
      expect(validateCustomArticleSource({ content, verbatim: true }, false)).toBe(
        'empty_verbatim_script',
      );
    }
  });

  it('accepts the same unreadable text when verbatim is off (it is article material, not a script)', () => {
    expect(validateCustomArticleSource({ content: '화자1:' }, false)).toBeNull();
  });

  it('rejects a verbatim line over the per-line limit (verbatim_line_too_long)', () => {
    // A turn is never split — not into parts, and not by the TTS chunker either —
    // so one overlong pasted line would become one oversized synthesis request.
    const overlong = `화자1: ${'가'.repeat(VERBATIM_LINE_CHARACTER_LIMIT + 1)}`;
    expect(validateCustomArticleSource({ content: overlong, verbatim: true }, false)).toBe(
      'verbatim_line_too_long',
    );
    // A later line counts exactly as much as the first one.
    expect(
      validateCustomArticleSource(
        { content: `화자1: 짧은 줄.\n${overlong}`, verbatim: true },
        false,
      ),
    ).toBe('verbatim_line_too_long');
  });

  it('accepts a verbatim line of exactly the per-line limit', () => {
    expect(
      validateCustomArticleSource(
        { content: `화자1: ${'가'.repeat(VERBATIM_LINE_CHARACTER_LIMIT)}`, verbatim: true },
        false,
      ),
    ).toBeNull();
  });

  it('leaves an overlong line alone when verbatim is off — nothing reads it as one turn', () => {
    expect(
      validateCustomArticleSource(
        { content: '가'.repeat(VERBATIM_LINE_CHARACTER_LIMIT + 1) },
        false,
      ),
    ).toBeNull();
  });

  it('accepts a verbatim script that has at least one utterance, prefixed or not', () => {
    expect(
      validateCustomArticleSource({ content: '화자1: 첫 문장입니다.', verbatim: true }, false),
    ).toBeNull();
    // Unprefixed lines are a warning, never a rejection: an all-unprefixed script
    // is a valid single-narrator reading.
    expect(validateCustomArticleSource({ content: '접두 없는 문장.', verbatim: true }, false)).toBeNull();
  });
});

describe('isVerbatimCustomArticle (verbatim design §3)', () => {
  it('answers the "그대로 읽기" question in one place for the gate, creation and the workflow', () => {
    expect(isVerbatimCustomArticle({ content: '본문', verbatim: true })).toBe(true);
    expect(isVerbatimCustomArticle({ content: '본문', verbatim: false })).toBe(false);
    expect(isVerbatimCustomArticle({ content: '본문' })).toBe(false);
  });
});

describe('resolveCustomArticleDetails (L1 — the graph needs a part count while the job runs)', () => {
  it('records the part count for a verbatim job, because it is knowable at creation', () => {
    const oneLine = `화자1: ${'가'.repeat(900)}`;
    expect(
      resolveCustomArticleDetails({ content: oneLine, verbatim: true }),
    ).toEqual({ verbatim: true, partCount: 1 });
    // Four 900-character lines pass the 3,000-character part boundary, so eight of
    // them are two parts — the two lanes a running job must draw.
    expect(
      resolveCustomArticleDetails({
        content: Array.from({ length: 8 }, () => oneLine).join('\n'),
        verbatim: true,
      }),
    ).toEqual({ verbatim: true, partCount: 2 });
  });

  it('keeps the pre-existing one-key shape for an ordinary pasted job', () => {
    // Its parts are the organizer's to decide, so there is nothing honest to write
    // here — and consumers that read `.verbatim` alone stay unaffected either way.
    expect(resolveCustomArticleDetails({ content: '평범한 본문.' })).toEqual({ verbatim: false });
    expect(resolveCustomArticleDetails({ content: '평범한 본문.', verbatim: false })).toEqual({
      verbatim: false,
    });
  });
});

describe('resolveCustomArticleTitle (design §13)', () => {
  it('uses the provided title verbatim when present', () => {
    expect(resolveCustomArticleTitle({ title: '내가 정한 제목', content: '본문' })).toBe('내가 정한 제목');
  });

  it('derives the title from the first content line, truncated to 80 chars', () => {
    const first = 'b'.repeat(120);
    const title = resolveCustomArticleTitle({ content: `${first}\n둘째 줄` });
    expect(title).toBe('b'.repeat(80));
  });

  it('uses only the first line for the derived title', () => {
    expect(resolveCustomArticleTitle({ content: '첫 줄\n둘째 줄' })).toBe('첫 줄');
  });

  it('strips a leading speaker prefix — it is a format marker, never a headline', () => {
    // Every recognized spelling, since the derived title is what the job list shows
    // while a verbatim job is still running.
    expect(resolveCustomArticleTitle({ content: '화자1: 첫 문장입니다.\n화자2: 둘째.' })).toBe(
      '첫 문장입니다.',
    );
    expect(resolveCustomArticleTitle({ content: 'Speaker2：  전각 콜론도.' })).toBe('전각 콜론도.');
    expect(resolveCustomArticleTitle({ content: ' speaker 1 : 공백도 허용.' })).toBe('공백도 허용.');
  });

  it('truncates to 80 chars AFTER the prefix is stripped', () => {
    const spoken = 'b'.repeat(120);
    expect(resolveCustomArticleTitle({ content: `화자1: ${spoken}` })).toBe('b'.repeat(80));
  });

  it('keeps a leading 화자3 line as-is — only speakers 1 and 2 are prefixes', () => {
    expect(resolveCustomArticleTitle({ content: '화자3: 안녕하세요.' })).toBe('화자3: 안녕하세요.');
  });

  it('falls back to the raw first line when nothing parses as an utterance', () => {
    expect(resolveCustomArticleTitle({ content: '화자1:' })).toBe('화자1:');
  });
});

describe('resolveCreateJobPlan (design §13)', () => {
  const customArticle = { content: '붙여넣은 본문' } as const;

  it('creates exactly ONE job for a valid pasted article (no fan-out)', () => {
    const plan = resolveCreateJobPlan({
      limit: 5,
      customArticle,
      maxParallel: MAX_PARALLEL_NEWSCASTS,
    });
    expect(plan).toEqual({
      ok: true,
      jobs: [{ limit: 1, customArticle }],
    });
  });

  it('rejects a pasted article that also carries entries (conflicting_source)', () => {
    const plan = resolveCreateJobPlan({
      limit: 1,
      entries: [{ title: 't', originalUrl: 'https://a', discussionUrl: 'https://b' }],
      customArticle,
      maxParallel: MAX_PARALLEL_NEWSCASTS,
    });
    expect(plan).toEqual({ ok: false, error: 'conflicting_source' });
  });

  it('rejects empty and over-cap pasted content', () => {
    // resolveCreateJobPlan receives ALREADY-parsed input, so empty content is the
    // empty string (parseCustomArticle has trimmed it upstream).
    expect(
      resolveCreateJobPlan({ limit: 1, customArticle: { content: '' }, maxParallel: 10 }),
    ).toEqual({ ok: false, error: 'empty_content' });
    expect(
      resolveCreateJobPlan({
        limit: 1,
        customArticle: { content: 'a'.repeat(MAXIMUM_ARTICLE_CONTENT_LENGTH + 1) },
        maxParallel: 10,
      }),
    ).toEqual({ ok: false, error: 'content_too_long' });
  });

  it('fans out one job per entry (capped at maxParallel) when entries are given', () => {
    const entries = Array.from({ length: 12 }, (_value, index) => ({
      title: `T${index}`,
      originalUrl: `https://a/${index}`,
      discussionUrl: `https://b/${index}`,
    }));
    const plan = resolveCreateJobPlan({ limit: 1, entries, maxParallel: MAX_PARALLEL_NEWSCASTS });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.jobs).toHaveLength(MAX_PARALLEL_NEWSCASTS);
      expect(plan.jobs.every((job) => job.entries?.length === 1 && job.limit === 1)).toBe(true);
    }
  });

  it('keeps the legacy single-job top-N path when neither source is given', () => {
    const plan = resolveCreateJobPlan({ limit: 3, maxParallel: MAX_PARALLEL_NEWSCASTS });
    expect(plan).toEqual({ ok: true, jobs: [{ limit: 3 }] });
  });
});
