/**
 * Assembles the Open Graph / Twitter head for a shared newscast.
 *
 * KakaoTalk, Slack, and Discord scrapers do not run JavaScript, so a
 * client-rendered `<meta>` is invisible to them — these strings are injected by
 * the Pages Function at response time (functions/share/[token].ts). Everything
 * here is deliberately pure and DOM-free: it runs inside the Workers runtime and
 * is unit-tested in Node.
 *
 * Two decisions from 2026-08-13:
 * - The description is an INFORMATION line (length, part count, dialogue count,
 *   source domain), not a dialogue quote. The source domain appears only when
 *   the sharer opted into publishing sources.
 * - Maximal-tag stance: every renderable-anywhere field ships (music.song with
 *   music:duration, og:audio, structured og:image, og:locale, og:see_also) —
 *   messengers that ignore them lose nothing. The ONE exception is og:url: it
 *   is a routing field, so it must always be the share page itself — pointing
 *   it at the source article would make crawlers rebuild the card from the
 *   article and messengers send card taps there.
 */

/** Wordmark appended to the document title and used as `og:site_name`. */
export const SITE_NAME = 'Audio Underview';

/**
 * Longest description a card gets. The information line stays well under this;
 * the truncation is a safety net for absurdly many sources or parts.
 */
export const DESCRIPTION_CHARACTER_LIMIT = 100;

/**
 * The preview image. A purpose-built 1200x630 card is backlog; the app icon
 * already reads correctly in the square-ish crop `twitter:card=summary` uses.
 */
export const PREVIEW_IMAGE_PATH = '/icon-512.png';

/** icon-512.png is a square — declared so scrapers can lay out before fetching. */
export const PREVIEW_IMAGE_SIZE = 512;

const FALLBACK_DESCRIPTION = '링크로 공유된 뉴스캐스트를 들어보세요.';

/**
 * The minimum a payload has to provide — `PublicShareView` satisfies it, and so
 * does a two-line test fixture. `metadata.sources` is present only when the
 * sharer opted in, exactly as the worker sends it.
 */
export interface ShareOpenGraphSource {
  title: string;
  parts: { durationMs?: number; script: { text: string }[] }[];
  metadata?: { sources?: { originalUrl: string }[] };
}

export interface OpenGraphMetadata {
  /** Full `<title>` text, wordmark included. */
  documentTitle: string;
  /** `og:title` — the newscast title alone, no wordmark. */
  ogTitle: string;
  description: string;
  /** Absolute URL; relative `og:image` values are rejected by most scrapers. */
  imageUrl: string;
  /** Canonical page URL, query string and fragment stripped. */
  pageUrl: string;
  /** `music.song` for a playable share, `website` for the fallback page. */
  ogType: 'music.song' | 'website';
  /** Absolute MP3 URL of the first part, when the share is playable. */
  audioUrl?: string;
  /** Whole-newscast length in whole seconds, for `music:duration`. */
  durationSeconds?: number;
  /** First opted-in source article, for `og:see_also`. */
  seeAlsoUrl?: string;
}

/** Escapes the five characters that could break out of text or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Cuts `text` to `limit` characters INCLUDING the ellipsis, so a caller that
 * promises "at most 100 characters" is telling the truth.
 */
export function truncateText(text: string, limit: number): string {
  if (limit <= 0) {
    return '';
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** "8분 30초" — the human-readable length for the card's information line. */
export function formatDurationForCard(totalMilliseconds: number): string {
  const totalSeconds = Math.round(totalMilliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pieces: string[] = [];
  if (hours > 0) {
    pieces.push(`${hours}시간`);
  }
  if (minutes > 0) {
    pieces.push(`${minutes}분`);
  }
  // Seconds disappear once an hour is on the line — "1시간 2분 3초" is noise.
  if (seconds > 0 && hours === 0) {
    pieces.push(`${seconds}초`);
  }
  return pieces.length === 0 ? '0초' : pieces.join(' ');
}

function totalDurationMilliseconds(source: ShareOpenGraphSource): number {
  return source.parts.reduce((sum, part) => sum + (part.durationMs ?? 0), 0);
}

function totalLineCount(source: ShareOpenGraphSource): number {
  return source.parts.reduce((sum, part) => sum + part.script.length, 0);
}

/** Hostname with the bare `www.` prefix dropped; undefined when unparseable. */
function sourceDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * The information line: "🎙 8분 30초 · 2부 · 대사 42줄 · 출처 news.hada.io".
 * Length and dialogue count are content-inherent; the part count appears only
 * when there is more than one; the source domain appears ONLY when the sharer
 * opted into publishing sources.
 */
export function buildShareDescription(
  source: ShareOpenGraphSource,
  limit: number = DESCRIPTION_CHARACTER_LIMIT,
): string {
  const pieces: string[] = [];

  const durationMilliseconds = totalDurationMilliseconds(source);
  if (durationMilliseconds > 0) {
    pieces.push(formatDurationForCard(durationMilliseconds));
  }
  if (source.parts.length > 1) {
    pieces.push(`${source.parts.length}부`);
  }
  const lineCount = totalLineCount(source);
  if (lineCount > 0) {
    pieces.push(`대사 ${lineCount}줄`);
  }

  const sources = source.metadata?.sources ?? [];
  const firstDomain = sources.length > 0 ? sourceDomain(sources[0].originalUrl) : undefined;
  if (firstDomain !== undefined) {
    pieces.push(
      sources.length > 1 ? `출처 ${firstDomain} 외 ${sources.length - 1}곳` : `출처 ${firstDomain}`,
    );
  }

  if (pieces.length === 0) {
    return FALLBACK_DESCRIPTION;
  }
  return truncateText(`🎙 ${pieces.join(' · ')}`, limit);
}

/**
 * Strips query and fragment: the token lives in the path, so anything after it
 * is caller-controlled noise that must not be reflected into `og:url`.
 */
function canonicalPageUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.origin}${url.pathname}`;
}

export interface BuildShareOpenGraphOptions {
  /** Absolute MP3 URL of the first part on the worker origin, for `og:audio`. */
  audioUrl?: string;
}

export function buildShareOpenGraphMetadata(
  source: ShareOpenGraphSource,
  requestUrl: string,
  options: BuildShareOpenGraphOptions = {},
): OpenGraphMetadata {
  const title = source.title.trim() === '' ? SITE_NAME : source.title.trim();
  const durationMilliseconds = totalDurationMilliseconds(source);
  const sources = source.metadata?.sources ?? [];

  return {
    documentTitle: `${title} — ${SITE_NAME}`,
    ogTitle: title,
    description: buildShareDescription(source),
    imageUrl: new URL(PREVIEW_IMAGE_PATH, requestUrl).toString(),
    pageUrl: canonicalPageUrl(requestUrl),
    ogType: 'music.song',
    audioUrl: options.audioUrl,
    durationSeconds:
      durationMilliseconds > 0 ? Math.round(durationMilliseconds / 1000) : undefined,
    seeAlsoUrl: sources[0]?.originalUrl,
  };
}

/**
 * Head for a link that resolved to nothing — revoked, regenerated, or never
 * real. It says nothing about whether the token ever existed, and it carries no
 * playable fields (plain `website`, no audio, no duration, no see_also).
 */
export function buildFallbackOpenGraphMetadata(requestUrl: string): OpenGraphMetadata {
  return {
    documentTitle: SITE_NAME,
    ogTitle: SITE_NAME,
    description: '이 링크는 더 이상 유효하지 않습니다.',
    imageUrl: new URL(PREVIEW_IMAGE_PATH, requestUrl).toString(),
    pageUrl: canonicalPageUrl(requestUrl),
    ogType: 'website',
  };
}

/**
 * The `<meta>` block appended to `<head>`. Every value is escaped here rather
 * than at the call site, so there is exactly one place to audit.
 */
export function renderOpenGraphTags(metadata: OpenGraphMetadata): string {
  const tags: [string, string, string][] = [
    ['property', 'og:site_name', SITE_NAME],
    ['property', 'og:type', metadata.ogType],
    ['property', 'og:locale', 'ko_KR'],
    ['property', 'og:title', metadata.ogTitle],
    ['property', 'og:description', metadata.description],
    ['property', 'og:image', metadata.imageUrl],
    ['property', 'og:image:type', 'image/png'],
    ['property', 'og:image:width', String(PREVIEW_IMAGE_SIZE)],
    ['property', 'og:image:height', String(PREVIEW_IMAGE_SIZE)],
    ['property', 'og:image:alt', `${SITE_NAME} 로고`],
    ['property', 'og:url', metadata.pageUrl],
  ];

  if (metadata.audioUrl !== undefined) {
    tags.push(
      ['property', 'og:audio', metadata.audioUrl],
      ['property', 'og:audio:secure_url', metadata.audioUrl],
      ['property', 'og:audio:type', 'audio/mpeg'],
    );
  }
  if (metadata.durationSeconds !== undefined) {
    tags.push(['property', 'music:duration', String(metadata.durationSeconds)]);
  }
  if (metadata.seeAlsoUrl !== undefined) {
    tags.push(['property', 'og:see_also', metadata.seeAlsoUrl]);
  }

  tags.push(
    ['name', 'twitter:card', 'summary'],
    ['name', 'twitter:title', metadata.ogTitle],
    ['name', 'twitter:description', metadata.description],
    ['name', 'twitter:image', metadata.imageUrl],
    ['name', 'description', metadata.description],
  );

  return tags
    .map(
      ([attribute, key, value]) =>
        `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`,
    )
    .join('');
}
