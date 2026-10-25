/**
 * Cross-instance pipeline checkpoints (design 2026-07-27-retry-resume §3).
 *
 * A Cloudflare Workflow's `step.do` output is durable only INSIDE its instance —
 * a resume runs a NEW instance and would therefore redo every crawl / organize /
 * script / TTS call. The pipeline therefore mirrors each stage's output into KV
 * under `chk/{scopeID}/...`, and a resumed run consumes those checkpoints in stage
 * order to skip work that already succeeded. The workflow passes
 * `{userUUID}/{newscastID}` as the scope, so the keys of one user share a prefix.
 *
 * EVERYTHING here is pure: key builders, JSON parsing, and the reuse decisions.
 * The KV reads/writes and the actual step wiring live in `workflow.ts`, so the
 * "what may be reused" rules stay unit-testable without a Workers runtime.
 */

import type {
  Article,
  NewscastPart,
  NewscastPartPlan,
  OrganizedUnit,
  ScriptLine,
} from '@audio-underview/newscast-core';

/** KV key namespace holding a newscast's checkpoints; finalize deletes the whole prefix. */
const CHECKPOINT_NAMESPACE = 'chk';

/** `chk/{scopeID}/` — the prefix covering every checkpoint of one newscast. */
export function checkpointPrefix(scopeID: string): string {
  return `${CHECKPOINT_NAMESPACE}/${scopeID}/`;
}

/** `chk/{scopeID}/articles` — the crawled (or pasted) source articles. */
export function articlesCheckpointKey(scopeID: string): string {
  return `${checkpointPrefix(scopeID)}articles`;
}

/** `chk/{scopeID}/plan` — the organize stage's units + part plan. */
export function planCheckpointKey(scopeID: string): string {
  return `${checkpointPrefix(scopeID)}plan`;
}

/** `chk/{scopeID}/signal` — whether the transition sting was generated. */
export function signalCheckpointKey(scopeID: string): string {
  return `${checkpointPrefix(scopeID)}signal`;
}

/** `chk/{scopeID}/script/p{partIndex}` — one part's generated dialogue. */
export function scriptPartCheckpointKey(scopeID: string, partIndex: number): string {
  return `${checkpointPrefix(scopeID)}script/p${partIndex}`;
}

/** `chk/{scopeID}/tts/p{partIndex}` — one part's per-chunk audio metadata. */
export function ttsPartCheckpointKey(scopeID: string, partIndex: number): string {
  return `${checkpointPrefix(scopeID)}tts/p${partIndex}`;
}

/** `chk/{scopeID}/part/p{partIndex}` — one part's finished merge output. */
export function mergedPartCheckpointKey(scopeID: string, partIndex: number): string {
  return `${checkpointPrefix(scopeID)}part/p${partIndex}`;
}

/** Organize-stage checkpoint payload (`chk/{scopeID}/plan`). */
export interface PlanCheckpoint {
  units: OrganizedUnit[];
  plans: NewscastPartPlan[];
  lengthFactor: number;
  /** True when organize FAILED and the run fell back to a single part (§3b: a miss). */
  degraded?: boolean;
}

/** Signal-sting checkpoint payload (`chk/{scopeID}/signal`). */
export interface SignalCheckpoint {
  generated: boolean;
}

/** Per-part script checkpoint payload — same shape the script step returns. */
export interface ScriptPartCheckpoint {
  lines: ScriptLine[];
  turns: number;
  characters: number;
  promptTokens?: number;
  completionTokens?: number;
}

/** One synthesized chunk's metadata (byte length of its PCM + its sample rate). */
export interface ChunkAudioMeta {
  byteLength: number;
  sampleRate: number;
}

/**
 * Per-part TTS checkpoint payload — written only after EVERY chunk of the part
 * synthesized successfully, so a hit means the whole part's `seg/` audio is there.
 */
export interface TtsPartCheckpoint {
  chunks: ChunkAudioMeta[];
}

/** Per-part merge checkpoint payload — same shape the merge step returns. */
export interface MergedPartCheckpoint {
  part: NewscastPart;
  mp3Bytes: number;
  aligned: boolean;
  words?: number;
}

/**
 * Parse a stored checkpoint value. ANY problem — absent value, empty string,
 * malformed JSON, or a non-object payload — reads as a MISS (`null`), so a
 * corrupted checkpoint degrades into re-running the stage rather than crashing.
 */
export function parseCheckpoint<T>(raw: string | null | undefined): T | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

/** A usable articles checkpoint is a non-empty array of articles. */
export function isArticlesCheckpointUsable(value: unknown): value is Article[] {
  return Array.isArray(value) && value.length > 0;
}

/**
 * A usable plan checkpoint has at least one part AND is NOT degraded: a degraded
 * plan is the single-part fallback recorded when organize FAILED, and §3b treats
 * it as a miss so a resume gets a fresh chance at a real organization.
 */
export function isPlanCheckpointUsable(value: unknown): value is PlanCheckpoint {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PlanCheckpoint>;
  return (
    candidate.degraded !== true &&
    Array.isArray(candidate.units) &&
    Array.isArray(candidate.plans) &&
    candidate.plans.length > 0
  );
}

/** A usable signal checkpoint carries a boolean verdict (`false` is still a hit). */
export function isSignalCheckpointUsable(value: unknown): value is SignalCheckpoint {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Partial<SignalCheckpoint>).generated === 'boolean'
  );
}

/** A usable script checkpoint carries a non-empty dialogue line array. */
export function isScriptPartCheckpointUsable(
  value: unknown,
): value is ScriptPartCheckpoint {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ScriptPartCheckpoint>;
  return Array.isArray(candidate.lines) && candidate.lines.length > 0;
}

/** A usable TTS checkpoint carries the per-chunk metadata array. */
export function isTtsPartCheckpointUsable(value: unknown): value is TtsPartCheckpoint {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as Partial<TtsPartCheckpoint>).chunks)
  );
}

/** A usable merged-part checkpoint carries a well-formed {@link NewscastPart}. */
export function isMergedPartCheckpointUsable(
  value: unknown,
): value is MergedPartCheckpoint {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const part = (value as Partial<MergedPartCheckpoint>).part;
  if (part === null || typeof part !== 'object') {
    return false;
  }
  const candidate = part as Partial<NewscastPart>;
  return (
    typeof candidate.index === 'number' &&
    typeof candidate.audioKey === 'string' &&
    candidate.audioKey.length > 0 &&
    Array.isArray(candidate.script) &&
    Array.isArray(candidate.segments)
  );
}

/** Which whole-pipeline checkpoints were found AND judged usable. */
export interface PipelineCheckpointHits {
  articles: boolean;
  plan: boolean;
  signal: boolean;
}

/** Which leading stages a run may skip, and whether per-part reuse is on the table. */
export interface PipelineReusePlan {
  articles: boolean;
  plan: boolean;
  signal: boolean;
  /** Per-part checkpoints may be consulted only once the part plan itself is reused. */
  parts: boolean;
}

/**
 * §3b's "reuse the front, re-run the rest" rule for the whole-pipeline stages: a
 * non-resume run reuses NOTHING, and on a resume the FIRST miss makes every later
 * stage live (a stage can only be skipped when all the stages it depends on were
 * skipped too — otherwise its inputs changed).
 */
export function resolvePipelineReuse(
  resume: boolean,
  hits: PipelineCheckpointHits,
): PipelineReusePlan {
  if (!resume) {
    return { articles: false, plan: false, signal: false, parts: false };
  }
  const articles = hits.articles;
  const plan = articles && hits.plan;
  const signal = plan && hits.signal;
  // Per-part reuse is premised on the PART PLAN (§3b-4), not on the sting: the
  // signal is an optional, harmless side artifact and its absence must not force
  // every part to be re-scripted.
  return { articles, plan, signal, parts: plan };
}

/**
 * The same rule for a "그대로 읽기" run (verbatim design §3), whose front half is
 * not a set of stages to reuse but a pure function of the parameters.
 *
 * A verbatim newscast never crawls, never organizes and never scripts: its articles
 * and its part split are re-derived from the pasted text — replayed byte-identically
 * by the resume — in microseconds, with no provider call to save. So `articles` and
 * `plan` are always FALSE (there is nothing checkpointed to hit, and re-deriving is
 * cheaper than the KV read), while `parts` is eligible on any resume: the parts are
 * guaranteed identical, which is exactly the premise §3b-4 normally has to get from
 * a reused plan. Skipping this and letting {@link resolvePipelineReuse} decide would
 * miss on the (never-written) plan checkpoint and re-synthesize every part's audio.
 *
 * `signal` still comes from its checkpoint, because the sting IS a paid call.
 */
export function resolveVerbatimPipelineReuse(
  resume: boolean,
  hits: Pick<PipelineCheckpointHits, 'signal'>,
): PipelineReusePlan {
  return {
    articles: false,
    plan: false,
    signal: resume && hits.signal,
    parts: resume,
  };
}

/** How much of one part may be reused. */
export type PartReuseMode =
  /** The finished merge output is reusable — skip script, TTS and merge entirely. */
  | 'merged'
  /** The dialogue is reusable — skip script; TTS reuses whatever chunks exist. */
  | 'script'
  /** Nothing is reusable — run the whole part live. */
  | 'live';

/** Which of one part's checkpoints were found AND judged usable. */
export interface PartCheckpointHits {
  merged: boolean;
  script: boolean;
  tts: boolean;
}

/** The reuse decision for one part. */
export interface PartReusePlan {
  mode: PartReuseMode;
  /** May the part's already-stored `seg/` chunk audio be reused chunk by chunk? */
  reuseChunkAudio: boolean;
  /** Is the checkpointed per-chunk metadata (sample rate / byte length) reusable? */
  reuseChunkMetas: boolean;
}

/**
 * §3b-4's per-part rule. Parts are INDEPENDENT: part 1 may be fully reused while
 * part 2 runs live. A merged part needs nothing else; a scripted part still runs
 * its TTS/merge steps, but each chunk whose audio is already in KV is skipped.
 */
export function resolvePartReuse(
  partsEligible: boolean,
  hits: PartCheckpointHits,
): PartReusePlan {
  if (!partsEligible) {
    return { mode: 'live', reuseChunkAudio: false, reuseChunkMetas: false };
  }
  if (hits.merged) {
    return { mode: 'merged', reuseChunkAudio: false, reuseChunkMetas: false };
  }
  if (hits.script) {
    return { mode: 'script', reuseChunkAudio: true, reuseChunkMetas: hits.tts };
  }
  return { mode: 'live', reuseChunkAudio: false, reuseChunkMetas: false };
}
