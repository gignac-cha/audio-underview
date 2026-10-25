/**
 * WHICH pipeline stages a newscast legitimately never ran, and what to say about it.
 *
 * Two things skip stages:
 * - a direct-input newscast (pasted text) skips the two crawl stages, and
 * - a "read verbatim" newscast additionally skips organize and script — it calls
 *   no script LLM at all, which is the entire point of the feature.
 *
 * The verdict comes from `details.customArticle`, the explicit flag the worker
 * records at creation. Nothing else is consulted when it is present: the old
 * inference is a HEURISTIC and it was wrong in a way users saw — a running
 * direct-input newscast still records `crawlList` telemetry (the list title comes
 * from it), so "has crawl telemetry ⇒ crawled" lit up Fetch list / Collect
 * articles on a newscast that never fetched anything. That inference survives only
 * as the fallback for newscasts created before the flag existed.
 */

import {
  NEWSCAST_STAGES,
  type JobStatus,
  type NewscastStage,
} from '@audio-underview/newscast-core';

/** Metric shown on the crawl stages a direct-input newscast skipped. */
export const DIRECT_INPUT_SKIP_METRIC = 'Direct input';

/** Metric shown on the organize/script stages a verbatim newscast skipped. */
export const VERBATIM_SKIP_METRIC = 'Read verbatim';

export interface JobSourceMode {
  /** The newscast was created from pasted text — the crawl stages never ran. */
  isDirectInput: boolean;
  /** The pasted text WAS the script — organize and script never ran either. */
  isVerbatim: boolean;
}

/**
 * The pre-flag heuristic, kept ONLY for newscasts without `details.customArticle`.
 *
 * A completed pasted newscast is unambiguous: no crawl-articles telemetry, and its
 * single source carries empty URLs. While such a newscast is still running there
 * is no result yet, so it falls back to the absence of ANY crawl telemetry on a
 * newscast that has already advanced past the crawl stages.
 */
function inferDirectInputJob(status: JobStatus): boolean {
  const details = status.details;
  if (details?.crawlArticles !== undefined) {
    return false;
  }
  const sources = status.result?.sources;
  if (sources !== undefined && sources.length > 0) {
    const first = sources[0];
    return first.originalUrl.length === 0 && first.discussionUrl.length === 0;
  }
  if (details?.crawlList !== undefined) {
    return false;
  }
  return NEWSCAST_STAGES.indexOf(status.stage) > NEWSCAST_STAGES.indexOf('crawl-articles');
}

/** How this newscast was sourced, flag first and inference only as the legacy fallback. */
export function jobSourceModeFor(status: JobStatus): JobSourceMode {
  const declared = status.details?.customArticle;
  if (declared !== undefined) {
    return { isDirectInput: true, isVerbatim: declared.verbatim };
  }
  // Nothing created before the flag can be verbatim — the feature did not exist.
  return { isDirectInput: inferDirectInputJob(status), isVerbatim: false };
}

/**
 * The label for a stage this newscast skipped, or undefined when the stage really
 * ran. Both the graph node's metric line and the stage row's metric use it, so
 * the two surfaces can never disagree about what was skipped.
 */
export function skippedStageMetric(
  stage: NewscastStage,
  mode: JobSourceMode,
): string | undefined {
  if (mode.isDirectInput && (stage === 'crawl-list' || stage === 'crawl-articles')) {
    return DIRECT_INPUT_SKIP_METRIC;
  }
  if (mode.isVerbatim && (stage === 'organize' || stage === 'script')) {
    return VERBATIM_SKIP_METRIC;
  }
  return undefined;
}
