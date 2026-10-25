/**
 * Pure helpers for the paste-text ("직접 입력") newscast source (design §13).
 *
 * Kept in its own module — free of the `cloudflare:workers` runtime graph, like
 * {@link ./audio-lookup.ts} — so the input parsing, validation, and title rules
 * are unit-testable without any I/O. Both the task group input
 * (`task-group-input.ts`, which validates the input and plans one newscast per
 * source) and the Workflow (`workflow.ts`, which builds the inline article +
 * crawl-list telemetry) share these definitions so the two never drift.
 */

import type { GeekNewsEntry } from '@audio-underview/newscast-core';
import {
  parseVerbatimScript,
  splitVerbatimParts,
} from '@audio-underview/newscast-script/verbatim-script.ts';

/**
 * Cap on pasted article content, MIRRORING the script package's
 * `MAXIMUM_ARTICLE_CONTENT_LENGTH` (design §6/§13). An input over this is
 * REJECTED (`content_too_long`) rather than silently truncated — the script
 * package would truncate it anyway, and quietly dropping the tail of what a user
 * deliberately pasted would be surprising.
 */
export const MAXIMUM_ARTICLE_CONTENT_LENGTH = 24_000;

/** Chars kept from the first content line when deriving a fallback title (§13). */
const MAXIMUM_DERIVED_TITLE_LENGTH = 80;

/** A pasted custom article after shaping: trimmed content + optional trimmed title. */
export interface CustomArticleInput {
  title?: string;
  content: string;
  /**
   * "그대로 읽기" (verbatim design §3): the pasted text IS the script. Set only when
   * it was asked for — an ordinary pasted article keeps the field absent, so its
   * stored request stays byte-identical to what it was before the feature.
   */
  verbatim?: boolean;
}

/**
 * The distinct reasons a custom-article source is rejected (§13, plus verbatim
 * design §3). Each maps to a stable error code.
 */
export type CustomArticleError =
  | 'conflicting_source'
  | 'empty_content'
  | 'content_too_long'
  | 'empty_verbatim_script'
  | 'verbatim_line_too_long';

/**
 * Extract an optional `customArticle` from a body: `content` trimmed, `title`
 * trimmed and dropped when it is empty. Returns `undefined` when the field is
 * absent or is not an object carrying a string `content` — the source is then
 * not a pasted article. Emptiness/length are NOT judged here (see
 * {@link validateCustomArticleSource}); this only shapes the value.
 */
export function parseCustomArticle(body: unknown): CustomArticleInput | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const candidate = (body as { customArticle?: unknown }).customArticle;
  if (candidate === null || typeof candidate !== 'object') {
    return undefined;
  }
  const { title, content, verbatim } = candidate as Record<string, unknown>;
  if (typeof content !== 'string') {
    return undefined;
  }
  const shaped: CustomArticleInput = { content: content.trim() };
  if (typeof title === 'string' && title.trim().length > 0) {
    shaped.title = title.trim();
  }
  // Strictly `true`, never truthiness: this one boolean decides whether an LLM
  // ever sees the user's text, so a stray non-boolean must read as the default
  // (off) rather than silently switching the pipeline.
  if (verbatim === true) {
    shaped.verbatim = true;
  }
  return shaped;
}

/**
 * Is this pasted article a "그대로 읽기" newscast? One place answers it, because
 * the question is asked at the input gate, at row creation (`details.customArticle`)
 * and again inside the workflow, and those three must never disagree.
 */
export function isVerbatimCustomArticle(customArticle: CustomArticleInput): boolean {
  return customArticle.verbatim === true;
}

/**
 * Validate a parsed custom article against the §13 source rules, returning the
 * rejection reason or `null` when it is acceptable:
 * - `conflicting_source` — `entries` were ALSO provided; the two sources are
 *   mutually exclusive (a newscast is GeekNews OR pasted text, never both).
 *   Checked FIRST so a conflicting source fails on the conflict, not on content shape.
 * - `empty_content` — the content trimmed to nothing.
 * - `content_too_long` — content exceeds {@link MAXIMUM_ARTICLE_CONTENT_LENGTH}.
 * - `empty_verbatim_script` — verbatim design §3: "그대로 읽기" was asked for but
 *   the text parses to ZERO utterances (only blank or prefix-only lines). The
 *   parser runs HERE, at the gate, because a verbatim newscast has no LLM stage to
 *   discover the problem later — it would go straight to TTS with nothing to say.
 * - `verbatim_line_too_long` — one utterance exceeds
 *   `VERBATIM_LINE_CHARACTER_LIMIT`. A turn is indivisible all the way down to the
 *   TTS request (the chunker only ever flushes BETWEEN turns), so a single pasted
 *   line that long would become one oversized synthesis call. Rejected here rather
 *   than truncated, for the same reason `content_too_long` is.
 * These two are the blocking warnings; `unprefixed-lines` and `url-in-line` are
 * advisory and the web shows them in its preview.
 * `customArticle.content` is assumed already trimmed (parseCustomArticle does it).
 */
export function validateCustomArticleSource(
  customArticle: CustomArticleInput,
  hasEntries: boolean,
): CustomArticleError | null {
  if (hasEntries) {
    return 'conflicting_source';
  }
  if (customArticle.content.length === 0) {
    return 'empty_content';
  }
  if (customArticle.content.length > MAXIMUM_ARTICLE_CONTENT_LENGTH) {
    return 'content_too_long';
  }
  if (isVerbatimCustomArticle(customArticle)) {
    const { warnings } = parseVerbatimScript(customArticle.content);
    if (warnings.some((warning) => warning.kind === 'empty-script')) {
      return 'empty_verbatim_script';
    }
    if (warnings.some((warning) => warning.kind === 'overlong-line')) {
      return 'verbatim_line_too_long';
    }
  }
  return null;
}

/**
 * The `details.customArticle` record written at row creation (verbatim design §5).
 *
 * `verbatim` is the flag the stage display trusts. `partCount` rides along for a
 * verbatim newscast ONLY, because a verbatim newscast is the one case where the
 * part count is known before anything runs — the gate has already parsed and
 * split the script — and the pipeline graph would otherwise show a single lane
 * for a running multi-part newscast: every other source of a part count
 * (`details.organize`, `partsSummary`, the result) is written by stages a
 * verbatim newscast skips.
 *
 * A non-verbatim pasted newscast keeps the one-key shape, so consumers that read
 * `.verbatim` alone are unaffected either way.
 */
export function resolveCustomArticleDetails(
  customArticle: CustomArticleInput,
): { verbatim: boolean; partCount?: number } {
  if (!isVerbatimCustomArticle(customArticle)) {
    return { verbatim: false };
  }
  const parts = splitVerbatimParts(parseVerbatimScript(customArticle.content).lines);
  return { verbatim: true, partCount: parts.length };
}

/**
 * The broadcast title for a pasted article (design §13): the provided title when
 * present, else the first SPOKEN line of content truncated to
 * {@link MAXIMUM_DERIVED_TITLE_LENGTH} — so the newscast list shows something
 * meaningful while it is still running, before any result exists. Content is
 * assumed trimmed; parseCustomArticle has already dropped an empty title.
 *
 * "First spoken line" is the parser's own notion (verbatim design §3), so a
 * `화자1:` / `Speaker2:` prefix — a format marker that is never read aloud — is
 * stripped instead of becoming the first six characters of every verbatim
 * newscast's title. The stripping is unconditional: the prefix is not part of a
 * headline in either mode, and text that carries none parses back to itself.
 */
export function resolveCustomArticleTitle(customArticle: CustomArticleInput): string {
  if (customArticle.title !== undefined && customArticle.title.length > 0) {
    return customArticle.title;
  }
  const firstSpokenLine = parseVerbatimScript(customArticle.content).lines[0]?.text;
  // A body that parses to nothing (a lone prefix, say) still deserves a title, so
  // fall back to the raw first line rather than an empty one.
  const firstLine = firstSpokenLine ?? customArticle.content.split('\n')[0]?.trim() ?? '';
  return firstLine.slice(0, MAXIMUM_DERIVED_TITLE_LENGTH);
}

/** One newscast to create: exactly one of the source shapes, plus its crawl `limit`. */
export interface CreateJobPlanItem {
  limit: number;
  entries?: GeekNewsEntry[];
  customArticle?: CustomArticleInput;
}

/** The planning outcome: a rejection reason, or the list of newscasts to create. */
export type CreateJobPlan =
  | { ok: false; error: CustomArticleError }
  | { ok: true; jobs: CreateJobPlanItem[] };

/**
 * Decide which — and how many — newscasts a source list makes, and reject an
 * invalid pasted article, in ONE pure place (design §13). Precedence:
 * - `customArticle` present → validate it (see {@link validateCustomArticleSource});
 *   on success make exactly ONE newscast (no fan-out — a single pasted article is
 *   one broadcast, and the workflow builds it inline without crawling).
 * - else `entries` present → fan out ONE single-article newscast per entry
 *   (unrelated topics are never bundled), capped at `maxParallel`.
 * - else → a single plan with the `limit` alone, which the task group refuses:
 *   it has no list to crawl itself (`crawl-list` belongs to the previous stage).
 */
export function resolveCreateJobPlan(input: {
  limit: number;
  entries?: GeekNewsEntry[];
  customArticle?: CustomArticleInput;
  maxParallel: number;
}): CreateJobPlan {
  const { limit, entries, customArticle, maxParallel } = input;
  if (customArticle !== undefined) {
    const error = validateCustomArticleSource(customArticle, entries !== undefined);
    if (error !== null) {
      return { ok: false, error };
    }
    return { ok: true, jobs: [{ limit: 1, customArticle }] };
  }
  if (entries !== undefined) {
    return {
      ok: true,
      jobs: entries.slice(0, maxParallel).map((entry) => ({ entries: [entry], limit: 1 })),
    };
  }
  return { ok: true, jobs: [{ limit }] };
}
