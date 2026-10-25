/**
 * @audio-underview/newscast-core
 *
 * Shared TypeScript contracts for the "GeekNews -> 2-host Korean audio
 * newscast" pipeline. The only runtime dependency is the provider-key masking
 * re-exported from @audio-underview/logger.
 *
 * Every package in the pipeline (crawler, script generator, TTS synthesizer,
 * audio merger, pipeline worker, and web report page) imports these types so
 * the wire contract between them stays locked.
 *
 * NOTE ON FIELD NAMES: the field names here (originalUrl, discussionUrl,
 * startMs, durationMs, audioKey, ...) are the integration contract fixed by the
 * build spec. They are intentionally kept verbatim so every agent serializes
 * and deserializes the exact same JSON shape. Do not rename them.
 */

/**
 * Which of the two hosts speaks a line.
 * 1 = 진행자1 (host one), 2 = 진행자2 (host two).
 */
export type SpeakerId = 1 | 2;

/**
 * Cloud LLM provider used to generate the newscast script.
 * Selected at runtime via the NEWSCAST_LLM_PROVIDER worker variable, or per
 * request by `CreateJobRequest.provider`.
 *
 * 'xai' (Grok) joined the union with the per-user-provider-keys work (design §2).
 * It is OpenAI-compatible, so the script package reuses its OpenAI call site with
 * a different base URL — but there is deliberately NO operator xAI key yet
 * (design §8): a job can only run on xAI once the USER has registered their own
 * Grok key, and the trial pool stays three providers wide.
 */
export type LlmProvider = 'anthropic' | 'openai' | 'google' | 'xai';

/** Every {@link LlmProvider}, in the order the UI and the key API list them. */
export const LLM_PROVIDERS: readonly LlmProvider[] = [
  'anthropic',
  'openai',
  'google',
  'xai',
];

/**
 * Pipeline stages, in execution order. The pipeline advances strictly through
 * this sequence; `done` is terminal.
 *
 * `organize` sits between `crawl-articles` and `script`: it structures the
 * crawled source material into speakable units and decides how many parts the
 * newscast splits into (see {@link OrganizedUnit} / {@link NewscastPartPlan}),
 * before any dialogue is written.
 */
export type NewscastStage =
  | 'crawl-list'
  | 'crawl-articles'
  | 'organize'
  | 'script'
  | 'tts'
  | 'merge'
  | 'done';

/**
 * Ordered list of pipeline stages. Shared so the worker advances stages in a
 * fixed order and the web page can render deterministic progress steps.
 */
export const NEWSCAST_STAGES: readonly NewscastStage[] = [
  'crawl-list',
  'crawl-articles',
  'organize',
  'script',
  'tts',
  'merge',
  'done',
] as const;

/**
 * Overall lifecycle status of a job.
 * 'running' while any stage before `done` is active, 'done' on success,
 * 'error' when the pipeline failed (see JobStatus.error).
 */
export type JobRunStatus = 'running' | 'done' | 'error';

/**
 * One crawled GeekNews article.
 * - title: article headline as shown on GeekNews.
 * - originalUrl: the ORIGINAL external article URL (the outbound link).
 * - discussionUrl: the GeekNews discussion/topic page URL.
 * - content: the readable text extracted from the original article.
 * - geeknewsSummary: optional extra source material — the submitter's Korean
 *   write-up/summary body from the GeekNews topic page (NOT the comments). Used
 *   only to enrich script generation; empty/absent when it could not be fetched.
 * - hackerNewsComments: optional extra source material — the top reader comments
 *   from the article's Hacker News discussion, joined as plain text. Used only to
 *   enrich script generation; empty/absent when no HN thread matched.
 *
 * NOTE: `geeknewsSummary` and `hackerNewsComments` are optional enrichment inputs
 * for the LLM prompt. The generated dialogue must NEVER name or reveal these
 * sources; the script prompt enforces that.
 */
export interface Article {
  title: string;
  originalUrl: string;
  discussionUrl: string;
  content: string;
  geeknewsSummary?: string;
  hackerNewsComments?: string;
}

/**
 * One line of the two-host dialogue script.
 * - speaker: which host says the line.
 * - text: the Korean line text (also used as the TTS input for this line).
 */
export interface ScriptLine {
  speaker: SpeakerId;
  text: string;
}

/**
 * Timing metadata for one word inside a synthesized line.
 * - text: the ORIGINAL (un-normalized) word text, i.e. one whitespace-split
 *   token of the owning line's text.
 * - startMs: playback start offset in milliseconds within the merged audio.
 * - endMs: playback end offset in milliseconds within the merged audio.
 * Emitted only when Whisper alignment succeeds; used by the web page to drive the
 * per-word caption "spotlight" brightness gradient during playback.
 */
export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Timing metadata for one synthesized line inside the merged MP3.
 * - index: zero-based position, matching ScriptLine at the same index.
 * - startMs: playback start offset in milliseconds within the merged audio.
 * - durationMs: duration of this line's audio in milliseconds.
 * - words: optional per-word timings for this line, present only when Whisper
 *   alignment produced them (absent for the proportional-estimate fallback).
 * Used by the web page to highlight the active caption during playback.
 */
export interface AudioSegment {
  index: number;
  startMs: number;
  durationMs: number;
  words?: WordTiming[];
}

/**
 * One structured "speakable unit" produced by the organize stage — a
 * preservation-oriented rearrangement of source material (NOT a summary): every
 * figure, proper noun, and key quote is kept verbatim so the dialogue writer has
 * the raw material to speak from.
 * - kind: what role this unit plays in the broadcast narrative. Anything the
 *   parser cannot map to a known kind degrades to `'context'`.
 * - headline: short label for the unit (≤ 60 chars).
 * - detail: the speakable body (≤ 240 chars), preserving numbers / proper nouns /
 *   quoted phrasing from the source.
 * - quotes: up to 2 verbatim source quotes (each ≤ 100 chars), when present.
 * - weight: speaking value 1..5, used to balance units across parts.
 */
export interface OrganizedUnit {
  kind: 'fact' | 'argument' | 'example' | 'reaction' | 'context';
  headline: string;
  detail: string;
  quotes?: string[];
  weight: number;
}

/**
 * How one newscast part is assigned during planning — computed deterministically
 * by code (never the LLM) from the organized units. See the part-count / turn
 * formula in the dynamic-parts design doc §2.
 * - index: 1-based part number.
 * - unitIndexes: indexes into the shared `units[]` array this part covers, kept
 *   in original (narrative) order.
 * - turnTarget: target number of dialogue turns the part's script should hit.
 */
export interface NewscastPartPlan {
  index: number;
  unitIndexes: number[];
  turnTarget: number;
}

/**
 * One finished part of a multi-part newscast — its own MP3 with part-local
 * timing. Parts play back-to-back on the web player; there is no single merged
 * file (which lifts the 16,384-token / 25 MB-Whisper / merge-CPU ceilings).
 * - index: 1-based part number.
 * - audioKey: R2 key of this part's MP3, `${jobId}/part-${index}`.
 * - script: this part's dialogue only (part-local).
 * - segments: per-line timing for this part; `startMs` is relative to THIS
 *   part's audio, not the whole newscast.
 * - durationMs: total duration of this part's audio.
 */
export interface NewscastPart {
  index: number;
  audioKey: string;
  script: ScriptLine[];
  segments: AudioSegment[];
  durationMs: number;
}

/**
 * Final result of a completed newscast job.
 *
 * The top-level `script` / `segments` / `audioKey` fields are the LEGACY-reader
 * contract: a reader that predates multi-part newscasts still receives a usable
 * single-audio view. `parts` is the authoritative multi-part payload — new jobs
 * always populate it (a one-part newscast is still `[part1]`).
 * - sources: the crawled articles used as source material.
 * - script: the full ordered dialogue, all parts concatenated (aggregate) — kept
 *   for legacy readers that render one continuous script.
 * - segments: part 1's per-line timing. A legacy reader only fetches part 1's
 *   audio via `audioKey`, so aligning these to that audio keeps them consistent.
 * - audioKey: R2 key of part 1's MP3 — the audio a legacy reader plays.
 * - parts: every part with its own audio key / script / segments. Present on all
 *   new jobs; absent only on rows written before multi-part support.
 * - signalAudioKey: R2 key of a per-newscast transition sting (`${jobId}/signal`),
 *   a fresh Lyria clip generated once per multi-part newscast (design §15). Present
 *   ONLY when the sting was generated (partCount ≥ 2 and the generate-signal step
 *   succeeded); absent for single-part newscasts and whenever generation failed
 *   (which is swallowed — the player just advances between parts with no sound).
 */
export interface NewscastResult {
  sources: Article[];
  script: ScriptLine[];
  segments: AudioSegment[];
  audioKey: string;
  parts?: NewscastPart[];
  signalAudioKey?: string;
}

/**
 * Wall-clock timing for one pipeline stage, recorded live as the stage runs.
 * - startedAt: epoch milliseconds when the stage's durable work began.
 * - finishedAt: epoch milliseconds when the stage's durable work completed.
 * - durationMs: `finishedAt - startedAt`, present once the stage finished.
 */
export interface StageTiming {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

/**
 * Per-article byte accounting captured during the crawl-articles stage.
 * All byte counts are UTF-8 byte lengths of the corresponding source text.
 * - title: the article headline.
 * - originalBytes: bytes of the extracted original page content.
 * - geeknewsBytes: bytes of the GeekNews topic summary (0 when absent).
 * - hackerNewsBytes: bytes of the Hacker News comments (0 when absent).
 * - degradations: human-readable reasons for sources that came back EMPTY due to
 *   a non-fatal fetch/crawl failure (e.g. `original: HTTP 403`). Absent when all
 *   sources loaded (or were legitimately absent). Surfaced in the web debug panel
 *   so "원문 없음" is diagnosable instead of silent.
 */
export interface CrawledArticleInfo {
  title: string;
  originalBytes: number;
  geeknewsBytes: number;
  hackerNewsBytes: number;
  degradations?: string[];
}

/**
 * Persisted diagnosis of a stage failure, written into {@link JobDetails.failure}
 * by the pipeline the moment a stage attempt throws — so failures stay queryable
 * (D1) long after console logs expire.
 * - stage: the stage that threw.
 * - message: the error message, credential-masked and length-capped at the sink
 *   ({@link redactSecrets} + {@link truncateText} in `buildFailureDetails`) — a
 *   provider body reaching here may quote the user's own key back at us.
 * - stopReason: provider stop reason parsed out of the error message when present
 *   (e.g. `max_tokens` — the decisive truncation signal).
 * - failedChunk: zero-based TTS chunk index, present only for TTS chunk failures.
 * - at: ISO timestamp of the failing attempt.
 */
export interface JobFailureDetails {
  stage: NewscastStage;
  message: string;
  stopReason?: string;
  failedChunk?: number;
  at: string;
}

/**
 * Rich, per-stage telemetry accumulated incrementally by the pipeline Workflow
 * and surfaced on {@link JobStatus} so the web page can show what each stage did.
 * Every field is optional and appears only once its stage has produced it.
 * - timings: wall-clock timing per stage.
 * - crawlList: what the crawl-list stage selected.
 * - crawlArticles: per-article byte accounting from crawl-articles.
 * - organize: what the organize stage produced (unit count, the code-decided part
 *   plan) and whether it degraded to a single-part fallback.
 * - script: LLM provider/model, dialogue size, and token usage. In a multi-part
 *   newscast these are the SUM across all parts, so web telemetry stays a single
 *   whole-newscast figure.
 * - tts: number of synthesized chunks and total audio duration — summed across
 *   all parts.
 * - merge: encoded MP3 size and whether real (aligned) caption timings were used
 *   — summed / OR-ed across all parts.
 * - partsSummary: per-part rollup (turns / characters / audio duration), present
 *   once the job completes. Absent on legacy single-audio jobs.
 * - signal: outcome of the per-newscast transition-sting generation (design §15).
 *   Present only for multi-part newscasts (the step is skipped when partCount < 2).
 *   `generated` is true when the Lyria clip was produced and stored in R2 (`bytes`
 *   is then its size); false when generation failed — the job still completed, just
 *   without a between-parts sound.
 * - failure: persisted diagnosis of the most recent failing stage attempt. Only
 *   meaningful while `status === 'error'` — a retry that later succeeds may leave
 *   a stale record behind, which consumers must ignore on non-error jobs.
 */
/**
 * The COMPLETE resolved workflow parameters of one job (the per-job fan-out
 * result, NOT the multi-select request), persisted into `JobDetails.request` at
 * creation so a failed job can be re-run:
 * - resume re-creates the workflow instance with these EXACT params — including
 *   the voice pair, so TTS chunks reused from the failed run and freshly
 *   synthesized ones share the same voices;
 * - the web's "retry as a new job" maps them back into a CreateJobRequest,
 *   deliberately dropping the voices (a new job draws a fresh random pair).
 */
export interface JobRequestSnapshot {
  limit: number;
  entries?: GeekNewsEntry[];
  /**
   * `verbatim` rides INSIDE the snapshot because a resume replays these params
   * byte-for-byte: without it a resumed "그대로 읽기" job would fall back into the
   * organize/script stages it was created to skip.
   */
  customArticle?: { title?: string; content: string; verbatim?: boolean };
  provider?: LlmProvider;
  model?: string;
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  lengthPreference?: NewscastLengthPreference;
  /**
   * Gemini TTS model id (one of {@link TTS_MODELS}). Rides in the snapshot so a
   * resume re-synthesizes the missing chunks with the SAME model as the chunks
   * it reuses — two TTS models in one newscast would audibly change voice
   * quality mid-part. Absent on jobs created before the choice existed, which
   * ran on {@link DEFAULT_TTS_MODEL}.
   */
  ttsModel?: string;
  speaker1Voice: string;
  speaker2Voice: string;
  /**
   * WHICH KEY this job's SCRIPT calls started on — never the key itself (design
   * §5.3). A projection of {@link keyIdentities} kept in its own field because
   * that is the identity the web shows next to a failure, and because jobs
   * recorded before `keyIdentities` existed have only this one.
   */
  keyIdentity?: ProviderKeyIdentity;
  /**
   * WHOSE KEY PAYS FOR THE WHOLE JOB: one identity per credential this newscast
   * spends — the script provider AND the Google credential its audio (multi-speaker
   * TTS + the Lyria sting) always needs.
   *
   * `keyIdentity` alone could not answer the question a resume actually asks. The
   * create gate admits a job free (`selfFunded`: no trial run charged, no part cap)
   * only when EVERY one of these is the caller's own key, so a job whose script key
   * is still theirs but whose Google key is gone has become an operator-funded job —
   * invisible to a comparison that looks at the script provider alone, and worth the
   * largest single cost in a newscast. Recording the whole verdict is what lets the
   * resume refuse that (design §5.3).
   *
   * Identities only, exactly like {@link keyIdentity}: the snapshot becomes the
   * Workflow's durable params, which no D1/KV audit of ours can see into.
   */
  keyIdentities?: ProviderKeyIdentity[];
}

/**
 * The IDENTITY of the credential a job runs on, as recorded at creation time
 * (per-user-provider-keys design §5.3).
 *
 * This is deliberately everything EXCEPT the key: a plaintext credential must
 * never cross a Workflow `step.do` boundary, and `JobRequestSnapshot` is passed
 * verbatim as the workflow's `params`, which Cloudflare persists durably in the
 * Workflows engine — a store no D1 or KV audit of ours can see into.
 *
 * Its only job is to answer "is this still the same key situation?" on a resume:
 * a job that ran on the user's own key must not silently continue on the operator
 * trial pool (or the other way round) after the user added or removed a key, so a
 * changed `keySource` refuses the resume rather than re-billing the wrong party.
 * - provider: the resolved script provider the identity was read for.
 * - keySource: 'user' = the caller's registered key in the vault, 'operator' =
 *   this deployment's own key (the design §6 trial pool).
 * - keyVersion: the vault's KEK generation for a user key (rotation telemetry).
 * - last4: the last four characters of a user key — the only fragment of a
 *   credential that is ever allowed to leave the vault.
 */
export interface ProviderKeyIdentity {
  provider: LlmProvider;
  keySource: 'user' | 'operator';
  keyVersion?: number;
  last4?: string;
}

export interface JobDetails {
  timings?: Partial<Record<NewscastStage, StageTiming>>;
  failure?: JobFailureDetails;
  /**
   * WHERE {@link JobStatus.errorCode} is stored. The `newscast_jobs` table has no
   * `error_code` column, so the classification rides in this JSON blob and
   * `rowToOwnerJobStatus` lifts it onto the wire shape.
   *
   * `details` is written read-modify-write with no transaction (`mergeJobDetails`),
   * so a concurrent patch can drop a key. That is fatal for OWNERSHIP (design §1.2
   * put `user_id` in a real column for exactly this reason) but acceptable here:
   * this field is written once, by the terminal `record-error` step, after which
   * the workflow makes no further writes — and losing it degrades the job to the
   * generic `pipeline_failed`, which is the safe direction (the web shows the
   * ordinary failure panel instead of a wrong "register your key" prompt).
   */
  errorCode?: JobErrorCode;
  /**
   * The script-generation REQUEST parameters, recorded BEFORE the LLM call so
   * they survive a failure (details.script only lands on success). Answers
   * "which provider/model/effort was this failed run using?" from D1 alone.
   */
  scriptRequest?: { provider: LlmProvider; model?: string; effort?: string };
  /**
   * Full workflow-params snapshot for retry/resume (design
   * 2026-07-27-retry-resume). Absent on jobs created before the feature shipped —
   * those cannot be resumed (the worker answers 422).
   */
  request?: JobRequestSnapshot;
  /** Resume telemetry: how many times this job was resumed, and when last. */
  resume?: { count: number; lastAt: string };
  /**
   * User-edited display title (`POST /newscast/jobs/:id/title`). The job list's
   * derived title (result sources / crawl telemetry) is a best-effort guess —
   * notably "first line of the pasted body" for custom articles — so this
   * override, when present, wins over every derived source. Display-only: it
   * never feeds back into prompts, checkpoints, or the stored result.
   */
  titleOverride?: string;
  /**
   * Present on EVERY job created from a pasted article ("직접 입력"), and only on
   * those. `verbatim` is the "그대로 읽기" verdict recorded at creation: true when
   * the pasted text IS the script and no LLM ever sees it (organize and script are
   * skipped entirely).
   *
   * It is written explicitly rather than inferred because inference was wrong: the
   * pasted path still records `crawlList` telemetry so a RUNNING job has a title to
   * show, which made a pasted job look like it had crawled. Readers must trust this
   * flag alone and fall back to the old heuristics only for legacy jobs that
   * predate it.
   *
   * `partCount` is present for VERBATIM jobs only, and only on jobs created after
   * it shipped: a verbatim script is parsed and split at the gate, so how many
   * parts the job will produce is known before it runs — unlike every other job,
   * whose part count first appears in `organize`. It exists so a RUNNING verbatim
   * job's pipeline graph shows its real lanes instead of one; readers must treat
   * its absence as "not known yet" and keep their existing fallbacks.
   */
  customArticle?: { verbatim: boolean; partCount?: number };
  crawlList?: { count: number; titles: string[]; bytes: number };
  crawlArticles?: { articles: CrawledArticleInfo[]; totalBytes: number };
  /**
   * What the organize stage produced. `degraded` is true when organization
   * failed after its step retries and the pipeline fell back to a single part
   * (units: [], partCount 1, turnTarget from the §2 formula) instead of killing
   * the job — the same graceful-degrade posture as the OAuth Supabase fallback.
   */
  organize?: {
    provider: LlmProvider;
    model: string;
    unitCount: number;
    estimatedScriptCharacters: number;
    partCount: number;
    turnTargets: number[];
    promptTokens?: number;
    completionTokens?: number;
    degraded?: boolean;
    /**
     * The length-preference factor applied to the sizing budget (design §14):
     * 0.6 (short) / 1.0 (standard) / 1.4 (long). Present on jobs created after the
     * length preset shipped; a value of 1.0 (or absence) means the default,
     * unscaled sizing. Web telemetry surfaces it only when it is not 1.0.
     */
    lengthFactor?: number;
  };
  script?: {
    provider: LlmProvider;
    model: string;
    turns: number;
    characters: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  tts?: { chunks: number; audioDurationMs: number };
  merge?: { mp3Bytes: number; aligned: boolean; words?: number };
  partsSummary?: Array<{
    index: number;
    turns: number;
    characters: number;
    audioDurationMs: number;
  }>;
  signal?: { generated: boolean; bytes?: number };
}

/**
 * A coarse, SAFE classification of why a job failed — a CODE rather than the
 * provider's own words (per-user-provider-keys design §1.3), because the raw
 * message can echo an API key ('sk-proj-…'), an organization id, or a request
 * body. It is a closed vocabulary on purpose, and the reason it exists while
 * {@link JobStatus.error} is still the only failure text a caller sees: the BYOK
 * step adds `blocked_no_key` (§5-4), a terminal "your key was rejected, re-register
 * it" state the web must be able to branch on WITHOUT parsing an error string.
 * - pipeline_failed: the generic bucket (a stage threw for any other reason).
 * - blocked_no_key: the provider REFUSED THE CREDENTIAL (401/403), or there was
 *   no credential to use at all — the caller has no key registered for this
 *   provider and the deployment has no operator key for it either (xAI today,
 *   design §8). Terminal and NOT retried: re-attempting a rejected key hammers
 *   the user's own provider account, which is how a real account gets locked for
 *   credential stuffing (§5.4). The web branches on this code to send the user to
 *   the key-registration screen instead of showing a provider error string.
 */
export type JobErrorCode = 'pipeline_failed' | 'blocked_no_key';

/** Every {@link JobErrorCode}; the closed vocabulary {@link parseJobErrorCode} accepts. */
export const JOB_ERROR_CODES: readonly JobErrorCode[] = [
  'pipeline_failed',
  'blocked_no_key',
];

/**
 * Narrow an arbitrary value (a code read back out of a stored JSON blob) to a
 * {@link JobErrorCode}, or `undefined`. Consumers on both sides of the wire use
 * this rather than a cast, so a value written by an older/newer deployment
 * degrades to "unclassified" instead of reaching the web as an unknown branch.
 */
export function parseJobErrorCode(value: unknown): JobErrorCode | undefined {
  return typeof value === 'string' && JOB_ERROR_CODES.includes(value as JobErrorCode)
    ? (value as JobErrorCode)
    : undefined;
}

/**
 * Live job status returned by the polling endpoint TO THE JOB'S OWNER (every
 * newscast route is authenticated and ownership-scoped since design §1.1/§1.2 —
 * a non-owner gets 404, never this shape, so there is no second "public"
 * projection of a job: the ownership check is the boundary).
 * - id: job id.
 * - stage: the currently active (or last completed, when done) stage.
 * - stageProgress: 0..1 progress within the current stage.
 * - overallProgress: 0..1 progress across the whole pipeline.
 * - status: overall lifecycle status.
 * - errorCode: safe failure classification, present only when status === 'error'.
 * - error: human-readable error message, present only when status === 'error'.
 *   It may quote provider response text, so it is credential-masked and capped at
 *   the sink that writes it (`markJobError`).
 * - result: the final result, present only when status === 'done'.
 * - details: incremental per-stage telemetry (timings + stage metadata), present
 *   as soon as any stage has recorded something.
 */
export interface JobStatus {
  id: string;
  stage: NewscastStage;
  stageProgress: number;
  overallProgress: number;
  status: JobRunStatus;
  errorCode?: JobErrorCode;
  result?: NewscastResult;
  error?: string;
  details?: JobDetails;
}

/**
 * One entry in the recent-jobs list (`GET /newscast/jobs`) — the wire contract
 * shared by the worker (producer) and the web app (consumer). A lightweight
 * summary: no result payload, no details.
 * - createdAt: D1 UTC timestamp, `YYYY-MM-DD HH:MM:SS`.
 * - title: the first source article's title — resolved from the stored result
 *   when done, else from crawl telemetry as soon as crawl-list lands — or `null`
 *   while unknown.
 */
export interface NewscastJobSummary {
  id: string;
  status: JobRunStatus;
  stage: NewscastStage;
  overallProgress: number;
  createdAt: string;
  title: string | null;
}

/**
 * One GeekNews front-page list entry (an {@link Article} without its fetched
 * `content`). This is the shape returned by `GET /newscast/geeknews` and the
 * shape the web page submits back as the user-selected `entries` on
 * {@link CreateJobRequest}. Structurally identical to the crawler package's
 * `GeekNewsListEntry`, so the two are interchangeable across the wire.
 * - title: article headline as shown on GeekNews.
 * - originalUrl: the ORIGINAL external article URL (the outbound link).
 * - discussionUrl: the GeekNews discussion/topic page URL.
 */
export interface GeekNewsEntry extends Omit<Article, 'content'> {}

/**
 * How long a newscast should aim to be, as a user-facing preset applied ON TOP of
 * the dynamic source-driven sizing (design §14). The preset scales the estimated
 * script-character budget by a factor before the part/turn clamps, so it can never
 * push the newscast past the ranges the source actually supports (no forced
 * padding): 'short' ≈ 0.6×, 'standard' = 1.0× (behavior-identical to no preset),
 * 'long' ≈ 1.4×. The factor mapping itself lives in the script package.
 */
export type NewscastLengthPreference = 'short' | 'standard' | 'long';

/**
 * Request body for POST /newscast/jobs.
 * - limit: number of top GeekNews articles to process (default 1). Used as the
 *   backward-compatible fallback when `entries` is absent/empty.
 * - entries: optional user-selected GeekNews articles. When provided (non-empty),
 *   the pipeline uses exactly these entries instead of crawling the live top-N,
 *   and `limit` is ignored.
 * - customArticle: optional user-pasted article, MUTUALLY EXCLUSIVE with `entries`
 *   (design §13). When present the pipeline skips crawling entirely and builds the
 *   newscast from this single article; sending both `customArticle` and `entries`
 *   is rejected. `content` is the pasted body (server-capped); `title` is an
 *   optional headline that defaults to the first line of `content` when absent.
 *   `verbatim` ("그대로 읽기", default false) makes the pasted text the script
 *   itself: the pipeline runs NO script LLM at all and reads the lines exactly as
 *   sent, so a request whose text parses to zero utterances is rejected.
 * - provider: optional LLM provider override for script generation. When
 *   omitted (or invalid), the worker falls back to its NEWSCAST_LLM_PROVIDER
 *   environment variable.
 * - model: optional model id override for the chosen provider. When omitted,
 *   the provider's default (flagship) model is used.
 * - lengthPreference: optional length preset (design §14); defaults to 'standard'
 *   (unscaled, behavior-identical to today) when omitted.
 */
export interface CreateJobRequest {
  limit: number;
  entries?: GeekNewsEntry[];
  customArticle?: { title?: string; content: string; verbatim?: boolean };
  provider?: LlmProvider;
  model?: string;
  /** Optional reasoning effort for the script LLM ('none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' — 'none' is OpenAI-only and folds to the floor elsewhere). */
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  lengthPreference?: NewscastLengthPreference;
  /** Optional Gemini TTS model id (one of {@link TTS_MODELS}); omitted → {@link DEFAULT_TTS_MODEL}. */
  ttsModel?: string;
}

/** One selectable Gemini TTS model for the newscast generation UI. */
export interface TtsModelOption {
  id: string;
  /** Shown verbatim: the model name plus `$input/$output` per million tokens. */
  label: string;
  /** The default pick (data only; the label does not say so). */
  recommended?: boolean;
  /** Rendered in the separate legacy group; still callable. */
  legacy?: boolean;
}

/**
 * The Gemini TTS models a newscast may be voiced with — the worker rejects any
 * other `ttsModel`, because an operator-funded (trial) job spends the operator's
 * key on whatever id it names. Every entry supports two-speaker dialogue and
 * Korean. Swept 2026-09-29 against the Gemini API pricing and speech pages, and
 * each id answered a live two-speaker Korean request.
 *
 * The 3.8 models (2026-09-22) read their input strictly as a transcript and
 * take per-turn speaker/style in `speech_metadata`; the TTS package builds that
 * request shape for them and the legacy `Speaker1: …` transcript for the rest.
 * The 3.8 prices are introductory through 2026-12-31 and double on 2027-01-01
 * ($1/$18 Flash, $1/$12 Flash-Lite).
 *
 * The default stays on 2.5 Flash, the model every newscast so far was voiced
 * with, so nothing changes for a listener until someone picks a newer one.
 */
export const TTS_MODELS: readonly TtsModelOption[] = [
  { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS · $0.50/$9' },
  { id: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash-Lite TTS · $0.50/$6' },
  { id: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS · $0.50/$10', recommended: true, legacy: true },
  { id: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS · $1/$20', legacy: true },
  { id: 'gemini-2.5-pro-preview-tts', label: 'Gemini 2.5 Pro TTS · $1/$20', legacy: true },
];

/** The TTS model a job uses when it names none (see {@link TTS_MODELS}). */
export const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';

/** Whether `value` is one of the {@link TTS_MODELS} ids. */
export function isTtsModel(value: unknown): value is string {
  return typeof value === 'string' && TTS_MODELS.some((model) => model.id === value);
}

/**
 * Fan-out pool cap: the maximum number of newscasts one multi-select request
 * generates. Each selected article becomes its OWN single-article newscast
 * (unrelated topics are never bundled into one broadcast), and they generate in
 * parallel. A selection larger than this only spawns the first N. Shared by the
 * worker (enforces it) and the web picker (prevents over-selecting).
 */
export const MAX_PARALLEL_NEWSCASTS = 10;

/**
 * Response body for POST /newscast/jobs. A multi-article selection fans out into
 * one job per article; `jobIds` lists all of them in the order the articles were
 * submitted, and `jobId` mirrors the first for backward compatibility.
 */
export interface CreateJobResponse {
  jobIds: string[];
  /** First created job id. Retained for backward compatibility. */
  jobId: string;
}

/**
 * Cloudflare AI Gateway routing for provider calls (design
 * 2026-07-29-ai-gateway-egress). Worker egress is intermittently rejected by all
 * three providers as a geo-blocked region — Anthropic 403 "Request not allowed",
 * Google 400 "User location is not supported", OpenAI 403
 * `unsupported_country_region_territory` — while the same keys succeed locally.
 * Routing through the gateway pins egress to Cloudflare's own path.
 *
 * The worker builds this from its environment and passes it down; the packages
 * never read the environment themselves. When it is absent every call site keeps
 * its direct provider URL, so an unset variable is exactly today's behavior.
 */
export interface AiGatewayConfiguration {
  /** `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}` — a trailing slash is tolerated. */
  baseUrl: string;
  /** `cf-aig-authorization` token of an authenticated gateway; omitted for an open one. */
  token?: string;
}

/**
 * Join the gateway base with a provider-native suffix (`anthropic/v1/messages`,
 * `openai/chat/completions`, ...), normalizing the slashes between them.
 *
 * The suffixes are NOT symmetric across providers: Anthropic keeps its own `/v1`
 * while OpenAI drops it (the gateway base already ends in `/v1`). Callers pass
 * the exact suffix rather than composing one, so that asymmetry stays visible at
 * the call site instead of hiding in here.
 */
export function aiGatewayUrl(
  gateway: AiGatewayConfiguration,
  providerPath: string,
): string {
  const base = gateway.baseUrl.replace(/\/+$/, '');
  const path = providerPath.replace(/^\/+/, '');
  return `${base}/${path}`;
}

/**
 * The `cf-aig-authorization` header for an authenticated gateway — empty both
 * when no gateway is configured and when the configured one needs no token, so
 * call sites can spread the result unconditionally.
 */
export function aiGatewayHeaders(
  gateway?: AiGatewayConfiguration,
): Record<string, string> {
  if (gateway?.token === undefined) {
    return {};
  }
  return { 'cf-aig-authorization': `Bearer ${gateway.token}` };
}

// ---------------------------------------------------------------------------
// Provider calls without a credential (per-user-provider-keys design §5.1)
// ---------------------------------------------------------------------------

/**
 * One provider request, described WITHOUT a credential — everything a caller
 * knows about the call, and nothing about who pays for it.
 * - path: PROVIDER-RELATIVE, no leading slash (`v1/messages`,
 *   `v1/chat/completions`, `v1beta/models/{model}:generateContent`). It is never a
 *   URL: whoever fulfils the request owns the origin, which is what keeps a
 *   transport from being an SSRF pivot that also attaches a real key.
 * - body: a TEXT body (JSON, in every call site today).
 * - bodyBase64: a BINARY body, base64-encoded — mutually exclusive with `body`.
 *   It exists for exactly one call: Whisper alignment posts `multipart/form-data`
 *   carrying MP3 bytes, and a proxy contract that only spoke strings was the sole
 *   reason that call could not run on the user's own key (design §5.2). The
 *   fulfiller decodes it and sends the bytes verbatim, so the caller must send its
 *   own `content-type` (multipart boundary included) in {@link headers}.
 * - headers: non-credential headers only (`content-type`, `anthropic-version`).
 *
 * THIS TYPE LIVES IN CORE, not in the script package that first grew it: the TTS
 * and audio packages need the same seam to spend a user's key (design §5.2), and
 * they depend on core alone. The script package re-exports it, so its existing
 * consumers are unaffected.
 */
export interface ProviderRequestSpecification {
  path: string;
  method: 'GET' | 'POST';
  body?: string;
  bodyBase64?: string;
  headers?: Record<string, string>;
}

/** What a {@link ProviderTransport} returns: the provider's raw status and body. */
export interface ProviderTransportResponse {
  status: number;
  body: string;
}

/**
 * An indirection for "make this provider call for me".
 *
 * When one is supplied, the calling package builds the request SPEC and never
 * touches a credential — the transport (the pipeline worker's binding to the key
 * vault) decrypts the user's key inside its own worker, injects the auth header
 * there, and returns the response. That is what makes design §5.1's invariant
 * structural rather than a rule to remember: there is no key on this side to
 * accidentally put in a `step.do` parameter, a checkpoint, or a log line.
 *
 * With no transport, each call site fetches the provider directly with `apiKey` —
 * the operator/trial path, byte-identical to its pre-BYOK behavior, including AI
 * Gateway routing (a transport's own fulfiller owns that instead).
 */
export type ProviderTransport = (
  request: ProviderRequestSpecification,
) => Promise<ProviderTransportResponse>;

/**
 * A provider answered with a non-2xx status. Carries the STATUS as data so a
 * caller can branch on it without parsing the message — specifically design
 * §5.4's rule that 401/403 is terminal (`blocked_no_key`) and must never be
 * retried, because retrying a rejected credential is how a user's own provider
 * account gets locked for credential stuffing.
 */
export class ProviderRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderRequestError';
    this.status = status;
  }
}

/**
 * True when a failure is the provider REFUSING THE CREDENTIAL (401 unauthorized /
 * 403 forbidden) rather than anything a retry could fix. Shared so every package
 * that throws {@link ProviderRequestError} and every worker that classifies one
 * agree on the same predicate.
 */
export function isProviderCredentialRejection(error: unknown): boolean {
  return (
    error instanceof ProviderRequestError && (error.status === 401 || error.status === 403)
  );
}

export { PROVIDER_TEXT_MAXIMUM_LENGTH, redactSecrets, truncateText, redactAndTruncate } from '@audio-underview/logger';
