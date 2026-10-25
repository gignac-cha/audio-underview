/**
 * The Open Graph head is the only part of this app a messenger scraper ever
 * sees, and it is assembled from user-authored newscast content — so both the
 * shape and the escaping are pinned here.
 *
 * The description contract (2026-08-13): an information line, not a dialogue
 * quote — and the source domain appears only when the sharer opted in.
 */

import { describe, expect, it } from 'vitest';
import {
  SAMPLE_SHARE_VIEW,
  SAMPLE_SHARE_VIEW_WITHOUT_METADATA,
} from '../fixtures/sample-share-view.ts';
import {
  DESCRIPTION_CHARACTER_LIMIT,
  SITE_NAME,
  buildFallbackOpenGraphMetadata,
  buildShareDescription,
  buildShareOpenGraphMetadata,
  escapeHtml,
  formatDurationForCard,
  renderOpenGraphTags,
  truncateText,
} from './share-metadata.ts';

const REQUEST_URL = 'https://audio-underview-share.pages.dev/share/token-abc';
const AUDIO_URL = 'https://worker.test/share/token-abc/audio?part=1';

describe('truncateText', () => {
  it('leaves short text alone', () => {
    expect(truncateText('짧다', 10)).toBe('짧다');
  });

  it('never exceeds the limit, ellipsis included', () => {
    const result = truncateText('a'.repeat(50), 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not leave a dangling space before the ellipsis', () => {
    expect(truncateText('hello world again', 12)).toBe('hello world…');
  });
});

describe('formatDurationForCard', () => {
  it('reads naturally at every scale', () => {
    expect(formatDurationForCard(21_000)).toBe('21초');
    expect(formatDurationForCard(510_000)).toBe('8분 30초');
    expect(formatDurationForCard(3_720_000)).toBe('1시간 2분');
    expect(formatDurationForCard(0)).toBe('0초');
  });
});

describe('buildShareDescription', () => {
  it('is an information line, with the source domain when sources are public', () => {
    // Fixture: 12s + 9s parts, 3 + 2 lines, one source at example.com.
    expect(buildShareDescription(SAMPLE_SHARE_VIEW)).toBe(
      '🎙 21초 · 2부 · 대사 5줄 · 출처 example.com',
    );
  });

  it('omits the source domain when the sharer opted into nothing', () => {
    expect(buildShareDescription(SAMPLE_SHARE_VIEW_WITHOUT_METADATA)).toBe(
      '🎙 21초 · 2부 · 대사 5줄',
    );
  });

  it('omits the part count for a single-part newscast', () => {
    const description = buildShareDescription({
      title: 'x',
      parts: [{ durationMs: 60_000, script: [{ text: '가' }, { text: '나' }] }],
    });
    expect(description).toBe('🎙 1분 · 대사 2줄');
  });

  it('counts sources beyond the first instead of listing them', () => {
    const description = buildShareDescription({
      title: 'x',
      parts: [{ durationMs: 60_000, script: [{ text: '가' }] }],
      metadata: {
        sources: [
          { originalUrl: 'https://www.example.com/a' },
          { originalUrl: 'https://other.example.org/b' },
        ],
      },
    });
    expect(description).toBe('🎙 1분 · 대사 1줄 · 출처 example.com 외 1곳');
  });

  it('never exceeds the 100 character budget', () => {
    const manyParts = {
      title: 'x',
      parts: Array.from({ length: 40 }, () => ({
        durationMs: 60_000,
        script: [{ text: '가' }],
      })),
      metadata: {
        sources: [{ originalUrl: `https://${'긴'.repeat(80)}.example.com/a` }],
      },
    };
    const description = buildShareDescription(manyParts);
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_CHARACTER_LIMIT);
  });

  it('falls back to generic copy when there is nothing to describe', () => {
    expect(buildShareDescription({ title: 'x', parts: [] })).toBe(
      '링크로 공유된 뉴스캐스트를 들어보세요.',
    );
  });
});

describe('buildShareOpenGraphMetadata', () => {
  it('suffixes the document title but leaves og:title bare', () => {
    const metadata = buildShareOpenGraphMetadata(SAMPLE_SHARE_VIEW, REQUEST_URL);
    expect(metadata.documentTitle).toBe(`이해가 새로운 병목이다 — ${SITE_NAME}`);
    expect(metadata.ogTitle).toBe('이해가 새로운 병목이다');
  });

  it('declares a playable music.song with duration, audio, and see_also', () => {
    const metadata = buildShareOpenGraphMetadata(SAMPLE_SHARE_VIEW, REQUEST_URL, {
      audioUrl: AUDIO_URL,
    });
    expect(metadata.ogType).toBe('music.song');
    expect(metadata.durationSeconds).toBe(21);
    expect(metadata.audioUrl).toBe(AUDIO_URL);
    expect(metadata.seeAlsoUrl).toBe('https://example.com/understanding');
  });

  it('carries no see_also when the sharer opted into nothing', () => {
    const metadata = buildShareOpenGraphMetadata(
      SAMPLE_SHARE_VIEW_WITHOUT_METADATA,
      REQUEST_URL,
    );
    expect(metadata.seeAlsoUrl).toBeUndefined();
  });

  it('makes the preview image absolute', () => {
    const metadata = buildShareOpenGraphMetadata(SAMPLE_SHARE_VIEW, REQUEST_URL);
    expect(metadata.imageUrl).toBe(
      'https://audio-underview-share.pages.dev/icon-512.png',
    );
  });

  it('strips query and fragment so nothing caller-controlled reaches og:url', () => {
    const metadata = buildShareOpenGraphMetadata(
      SAMPLE_SHARE_VIEW,
      `${REQUEST_URL}?utm_source=evil#anchor`,
    );
    expect(metadata.pageUrl).toBe(REQUEST_URL);
  });

  it('keeps og:url the share page even though a source article is known', () => {
    // og:url is a routing field: crawlers follow it and messengers send card
    // taps there — it must never point at the source article.
    const metadata = buildShareOpenGraphMetadata(SAMPLE_SHARE_VIEW, REQUEST_URL);
    expect(metadata.pageUrl).toBe(REQUEST_URL);
    expect(metadata.pageUrl).not.toContain('example.com');
  });

  it('falls back to the wordmark for an empty title', () => {
    const metadata = buildShareOpenGraphMetadata({ title: '   ', parts: [] }, REQUEST_URL);
    expect(metadata.ogTitle).toBe(SITE_NAME);
  });
});

describe('buildFallbackOpenGraphMetadata', () => {
  it('says nothing about whether the token ever existed', () => {
    const metadata = buildFallbackOpenGraphMetadata(REQUEST_URL);
    expect(metadata.documentTitle).toBe(SITE_NAME);
    expect(metadata.description).toBe('이 링크는 더 이상 유효하지 않습니다.');
  });

  it('carries no playable fields', () => {
    const metadata = buildFallbackOpenGraphMetadata(REQUEST_URL);
    expect(metadata.ogType).toBe('website');
    expect(metadata.audioUrl).toBeUndefined();
    expect(metadata.durationSeconds).toBeUndefined();
    expect(metadata.seeAlsoUrl).toBeUndefined();
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could break out of text or an attribute', () => {
    expect(escapeHtml(`<img src="x" onerror='y'>&`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;',
    );
  });
});

describe('renderOpenGraphTags', () => {
  const metadata = buildShareOpenGraphMetadata(
    {
      title: '"위험한" <제목> & 친구들',
      parts: [{ durationMs: 21_000, script: [{ text: '따옴표 "테스트"' }] }],
      metadata: { sources: [{ originalUrl: 'https://example.com/understanding' }] },
    },
    REQUEST_URL,
    { audioUrl: AUDIO_URL },
  );
  const html = renderOpenGraphTags(metadata);

  it('emits the tags scrapers actually read', () => {
    expect(html).toContain('<meta property="og:type" content="music.song" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain(`<meta property="og:url" content="${REQUEST_URL}" />`);
    expect(html).toContain(
      '<meta property="og:image" content="https://audio-underview-share.pages.dev/icon-512.png" />',
    );
  });

  it('emits the maximal-stance extras', () => {
    expect(html).toContain('<meta property="og:locale" content="ko_KR" />');
    expect(html).toContain('<meta property="og:image:width" content="512" />');
    expect(html).toContain('<meta property="og:image:height" content="512" />');
    expect(html).toContain(`<meta property="og:audio" content="${AUDIO_URL}" />`);
    expect(html).toContain('<meta property="og:audio:type" content="audio/mpeg" />');
    expect(html).toContain('<meta property="music:duration" content="21" />');
    expect(html).toContain(
      '<meta property="og:see_also" content="https://example.com/understanding" />',
    );
  });

  it('omits conditional tags when their fields are absent', () => {
    const fallbackHtml = renderOpenGraphTags(buildFallbackOpenGraphMetadata(REQUEST_URL));
    expect(fallbackHtml).toContain('<meta property="og:type" content="website" />');
    expect(fallbackHtml).not.toContain('og:audio');
    expect(fallbackHtml).not.toContain('music:duration');
    expect(fallbackHtml).not.toContain('og:see_also');
  });

  it('escapes newscast content so a title cannot inject markup', () => {
    expect(html).toContain(
      '<meta property="og:title" content="&quot;위험한&quot; &lt;제목&gt; &amp; 친구들" />',
    );
    expect(html).not.toContain('<제목>');
  });
});
