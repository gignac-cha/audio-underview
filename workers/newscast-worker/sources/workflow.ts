/**
 * Durable, resumable newscast pipeline as a Cloudflare Workflow: one instance makes
 * one newscast of the task group "newscast".
 *
 * The pipeline runs as a sequence of DURABLE steps: each `step.do` persists its
 * output and automatically retries, and a restart resumes from the last completed
 * step rather than redoing finished work.
 *
 * Step-output rule (Cloudflare Workflows): a non-stream `step.do` return value
 * must be JSON/structured-cloneable and no larger than 1 MiB. Audio bytes are
 * therefore NEVER returned from a step — each TTS step renders one dialogue CHUNK
 * (a group of ~8 mixed-speaker turns) via the Gemini Developer API native
 * multi-speaker TTS, stores that chunk's raw PCM into KV, and returns only tiny
 * metadata (including the sample rate); the merge step reads the chunk PCM back
 * from KV, concatenates it, encodes the whole ONCE into a single MP3, and stores
 * it in R2.
 *
 * Every provider call is made with the USER's key, through the vault
 * (`user-vault-transport.ts`). When the newscast has ended, done or failed, the
 * last step reports the stage run to the scheduler (`reportStageRun`).
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers';

import {
  LENGTH_PREFERENCE_FACTORS,
  defaultModelForProvider,
  generateNewscastOrganization,
  generateNewscastPartScript,
  planNewscastParts,
} from '@audio-underview/newscast-script';
import {
  VERBATIM_READING_STYLE_PROMPT,
  VERBATIM_SPEECH_STYLE,
  chunkScriptIntoTurnGroups,
  synthesizeDialogueChunk,
} from '@audio-underview/newscast-tts';
import {
  countVerbatimCharacters,
  parseVerbatimScript,
  splitVerbatimParts,
  type VerbatimScriptLine,
} from '@audio-underview/newscast-script/verbatim-script.ts';
import {
  alignScriptToTranscript,
  encodePcmToMp3,
  mergePcmChunks,
  pcmDurationMs,
  transcribeWords,
} from '@audio-underview/newscast-audio';
import type {
  Article,
  AudioSegment,
  GeekNewsEntry,
  LlmProvider,
  NewscastPart,
  NewscastPartPlan,
  NewscastResult,
  NewscastStage,
  OrganizedUnit,
  ProviderRequestSpecification,
  ProviderTransport,
  ScriptLine,
} from '@audio-underview/newscast-core';
import {
  ProviderRequestError,
  isProviderCredentialRejection,
} from '@audio-underview/newscast-core';
import { createWorkerLogger } from '@audio-underview/logger';
import type { SupabaseClient } from '@audio-underview/supabase-connector';
import {
  NEWSCAST_STATE_TIME_TO_LIVE_SECONDS,
  type Environment,
  type NewscastWorkflowParameters,
} from './environment.ts';
import {
  UserProviderKeyUnavailableError,
  createUserKeyTransport,
  isUserProviderKeyConfigured,
} from './user-vault-transport.ts';
import { crawlHackerNewsViaManager, crawlTextViaManager } from './crawler-client.ts';
import { isVerbatimCustomArticle, resolveCustomArticleTitle } from './custom-article.ts';
import {
  articlesCheckpointKey,
  checkpointPrefix,
  isArticlesCheckpointUsable,
  isMergedPartCheckpointUsable,
  isPlanCheckpointUsable,
  isScriptPartCheckpointUsable,
  isSignalCheckpointUsable,
  isTtsPartCheckpointUsable,
  mergedPartCheckpointKey,
  parseCheckpoint,
  planCheckpointKey,
  resolvePartReuse,
  resolvePipelineReuse,
  resolveVerbatimPipelineReuse,
  scriptPartCheckpointKey,
  signalCheckpointKey,
  ttsPartCheckpointKey,
  type ChunkAudioMeta,
  type MergedPartCheckpoint,
  type PartReusePlan,
  type PlanCheckpoint,
  type ScriptPartCheckpoint,
  type SignalCheckpoint,
  type TtsPartCheckpoint,
} from './checkpoints.ts';
import {
  ProviderKeyBlockedError,
  StageFailureError,
  buildFailureDetails,
  classifyJobErrorCode,
} from './failure-details.ts';
import {
  buildSignalStingRequest,
  decodeSignalAudioBytes,
  extractSignalAudio,
  readSignalStingResponse,
} from './signal-sting.ts';
import {
  createNewscastSupabaseClient,
  markNewscastDone,
  markNewscastError,
  mergeNewscastDetails,
  updateNewscastStage,
} from './storage.ts';
import { reportStageRun } from './task-group.ts';

const logger = createWorkerLogger({
  defaultContext: { module: 'newscast-workflow' },
});

/**
 * KV key holding one part's dialogue chunk raw PCM bytes between that part's TTS
 * and merge steps. Namespaced per part (`p${partIndex}`) so a multi-part newscast's
 * chunks never collide — a part's merge step reads back exactly its own chunks
 * (design §7-3/§7-4).
 */
function partChunkAudioKey(
  newscastID: string,
  partIndex: number,
  chunkIndex: number,
): string {
  return `seg/${newscastID}/p${partIndex}/${chunkIndex}`;
}

/**
 * One newscast's checkpoint keys under ONE namespace. The builders in
 * `checkpoints.ts` lay a key out as `chk/{scopeID}/...`, so the whole set is
 * derived by choosing what `{scopeID}` is.
 */
export interface CheckpointKeySet {
  prefix: string;
  articles: string;
  plan: string;
  signal: string;
  scriptPart: (partIndex: number) => string;
  ttsPart: (partIndex: number) => string;
  mergedPart: (partIndex: number) => string;
}

/**
 * Where one run's checkpoints live: `chk/{userUUID}/{newscastID}/...`, which gives
 * KV prefix operations (the `list` + `delete` sweep in
 * {@link deleteNewscastCheckpoints}) a real tenant boundary instead of a flat
 * per-newscast namespace shared by everyone.
 */
export function resolveCheckpointScope(
  userUUID: string,
  newscastID: string,
): CheckpointKeySet {
  const scopeID = `${userUUID}/${newscastID}`;
  return {
    prefix: checkpointPrefix(scopeID),
    articles: articlesCheckpointKey(scopeID),
    plan: planCheckpointKey(scopeID),
    signal: signalCheckpointKey(scopeID),
    scriptPart: (partIndex) => scriptPartCheckpointKey(scopeID, partIndex),
    ttsPart: (partIndex) => ttsPartCheckpointKey(scopeID, partIndex),
    mergedPart: (partIndex) => mergedPartCheckpointKey(scopeID, partIndex),
  };
}

/**
 * Read one `chk/...` checkpoint. Best effort in BOTH directions: a KV error and a
 * malformed payload both read as a MISS, so a resume degrades into re-running that
 * stage instead of failing the newscast (design §3a).
 */
export async function readCheckpoint<T>(
  newscastState: KVNamespace,
  key: string,
): Promise<T | null> {
  try {
    return parseCheckpoint<T>(await newscastState.get(key, 'text'));
  } catch (error) {
    logger.warn('Checkpoint read failed; treating it as a miss', {
      key,
      error: error instanceof Error ? error.message : String(error),
    }, { function: 'readCheckpoint' });
    return null;
  }
}

/**
 * Persist one `chk/...` checkpoint, with the 7-day TTL. Best effort (design §3a):
 * a failure only costs a future resume the ability to skip that stage, so it is
 * warned and swallowed rather than allowed to fail a stage that already succeeded.
 */
async function writeCheckpoint(
  newscastState: KVNamespace,
  key: string,
  value: unknown,
): Promise<void> {
  try {
    await newscastState.put(key, JSON.stringify(value), {
      expirationTtl: NEWSCAST_STATE_TIME_TO_LIVE_SECONDS,
    });
  } catch (error) {
    logger.warn('Checkpoint write failed; this stage will re-run on a resume', {
      key,
      error: error instanceof Error ? error.message : String(error),
    }, { function: 'writeCheckpoint' });
  }
}

/**
 * Delete every checkpoint of one newscast (design §3a: finalize cleans them up
 * along with the `seg/` chunk audio, since a completed newscast can never be
 * resumed). Best effort: a cleanup failure must never fail an otherwise finished
 * newscast — the TTL removes whatever is left.
 */
async function deleteNewscastCheckpoints(
  newscastState: KVNamespace,
  newscastID: string,
  checkpoints: CheckpointKeySet,
): Promise<void> {
  const prefix = checkpoints.prefix;
  try {
    let cursor: string | undefined;
    do {
      const listing = await newscastState.list({
        prefix,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const key of listing.keys) {
        await newscastState.delete(key.name);
      }
      cursor = listing.list_complete ? undefined : listing.cursor;
    } while (cursor !== undefined);
  } catch (error) {
    logger.warn('Checkpoint cleanup failed; stale checkpoints will expire unused', {
      newscastID,
      prefix,
      error: error instanceof Error ? error.message : String(error),
    }, { function: 'deleteNewscastCheckpoints' });
  }
}

/**
 * Telemetry for a stage a RESUME skipped by reusing a checkpoint: stamp a
 * zero-duration timing so the web's stage graph shows it as finished (rather than
 * never-started), then move the stage/progress immediately — design §3b requires a
 * skipped stage to update progress right away instead of waiting for the next live
 * stage to do it.
 *
 * (`StageTiming` has no `reused` marker today; design §3b explicitly permits
 * recording `durationMs: 0` instead until core grows the optional field.)
 */
async function recordReusedStage(
  client: SupabaseClient,
  newscastID: string,
  stage: NewscastStage,
  stageProgress: number,
): Promise<void> {
  const now = Date.now();
  await mergeNewscastDetails(client, newscastID, {
    timings: { [stage]: { startedAt: now, finishedAt: now, durationMs: 0 } },
  });
  await updateNewscastStage(client, newscastID, stage, stageProgress);
}

/** Sample rate used when a chunk's metadata is somehow unavailable (Gemini TTS default). */
const FALLBACK_SAMPLE_RATE = 24_000;

/** §2 per-part turn-target clamp band, mirrored for the degraded single-part fallback. */
const MINIMUM_PART_TURN_TARGET = 24;
const MAXIMUM_PART_TURN_TARGET = 56;

/**
 * §2's SCRIPT_CHARACTERS_PER_TURN. planNewscastParts computes the estimated
 * script-character budget internally but returns only the plan, so the organize
 * telemetry reconstructs it from the plan's turn targets (design §2:
 * est ≈ Σ(turnTarget) × 78 — exact in the checksum regime; at the clamp
 * boundaries it reads as the effective targeted budget). Telemetry only — it never
 * drives pipeline sizing, which is owned entirely by planNewscastParts.
 */
const SCRIPT_CHARACTERS_PER_TURN = 78;

/** Reconstruct the estimated script-character budget from a part plan (telemetry only). */
function estimatedScriptCharactersFromPlans(plans: NewscastPartPlan[]): number {
  const totalTurnTarget = plans.reduce((sum, plan) => sum + plan.turnTarget, 0);
  return totalTurnTarget * SCRIPT_CHARACTERS_PER_TURN;
}

/**
 * The single-part plan used when the organize stage degrades (design §4): no
 * units, one part, with the §2 single-part turn target. planNewscastParts already
 * applies the §2 formula over the raw articles; a single part's turn target equals
 * the sum of the multi-part targets it would otherwise produce, re-clamped into the
 * §2 [24, 56] band — so we collapse whatever it returns into one part without
 * re-deriving the (unexported) character budget here. `lengthFactor` (design §14)
 * scales the sizing the same way the healthy organize path does, so a degraded run
 * still honors the length preset.
 */
function singlePartFallbackPlan(
  articles: Article[],
  lengthFactor: number,
): NewscastPartPlan[] {
  const plans = planNewscastParts(articles, [], { lengthFactor });
  const summedTurnTarget = plans.reduce((sum, plan) => sum + plan.turnTarget, 0);
  const turnTarget = Math.min(
    MAXIMUM_PART_TURN_TARGET,
    Math.max(MINIMUM_PART_TURN_TARGET, summedTurnTarget),
  );
  return [{ index: 1, unitIndexes: [], turnTarget }];
}

/** Headlines of the units a plan covers, in order (empty in fallback mode). */
function headlinesForPlan(units: OrganizedUnit[], plan: NewscastPartPlan): string[] {
  return plan.unitIndexes
    .map((unitIndex) => units[unitIndex]?.headline)
    .filter((headline): headline is string => typeof headline === 'string');
}

/**
 * Sum optional per-part token/word counts into one whole-newscast aggregate,
 * returning `undefined` when NO part reported the value (so a missing figure stays
 * missing rather than reading as a real 0).
 */
function sumOptionalCounts(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
}

/**
 * Distribute one chunk's estimated audio duration across its turns to derive
 * per-turn caption timing.
 *
 * A chunk's PCM contains several turns rendered in a single Gemini TTS call,
 * so there is no exact per-turn boundary. We approximate: each turn's share of the
 * chunk's exact duration is proportional to its spoken length, estimated as the
 * turn's non-whitespace character count (Korean text is roughly constant duration
 * per glyph). Timings are cumulative from the chunk's `startMs`, and the final
 * turn absorbs any rounding remainder so the turns exactly tile the chunk. This
 * keeps `NewscastResult.segments` one-per-`ScriptLine` (index/startMs/durationMs)
 * so the web player's synced captions still work; the offsets are approximate.
 */
function distributeChunkTimings(
  turns: ScriptLine[],
  chunkStartMs: number,
  chunkDurationMs: number,
  firstTurnIndex: number,
): AudioSegment[] {
  const weights = turns.map((turn) => Math.max(1, spokenWeight(turn.text)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  const segments: AudioSegment[] = [];
  let offsetMs = 0;
  for (let position = 0; position < turns.length; position += 1) {
    const isLast = position === turns.length - 1;
    const durationMs = isLast
      ? Math.max(0, chunkDurationMs - offsetMs)
      : Math.round((chunkDurationMs * weights[position]) / totalWeight);
    segments.push({
      index: firstTurnIndex + position,
      startMs: chunkStartMs + offsetMs,
      durationMs,
    });
    offsetMs += durationMs;
  }
  return segments;
}

/** Non-whitespace character count — a proxy for a turn's spoken length. */
function spokenWeight(text: string): number {
  return [...text.replace(/\s+/g, '')].length;
}

/** UTF-8 byte length of a string (for the crawl-articles byte accounting). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Record a stage's wall-clock timing into the newscast's `details` telemetry: stamp
 * `startedAt` before running `body`, then `finishedAt` + `durationMs` after.
 *
 * This runs in the Cloudflare Workers runtime, so `Date.now()` advances across the
 * step's I/O and gives real durations. The whole helper is invoked INSIDE the
 * durable `step.do` body so a step retry re-times the stage cleanly, while a
 * resumed (already-completed) step never re-runs it and its recorded timing stays
 * stable.
 */
async function withStageTiming<T>(
  client: SupabaseClient,
  newscastID: string,
  stage: NewscastStage,
  body: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logger.info('Stage started', undefined, {
    function: 'withStageTiming',
    metadata: { newscastID, stage },
  });
  await mergeNewscastDetails(client, newscastID, { timings: { [stage]: { startedAt } } });
  try {
    const outcome = await body();
    const finishedAt = Date.now();
    logger.info('Stage finished', undefined, {
      function: 'withStageTiming',
      metadata: { newscastID, stage, durationMs: finishedAt - startedAt },
    });
    await mergeNewscastDetails(client, newscastID, {
      timings: {
        [stage]: { startedAt, finishedAt, durationMs: finishedAt - startedAt },
      },
    });
    return outcome;
  } catch (error) {
    // Persist WHAT failed (stage, message, stop reason, chunk) before the error
    // propagates into step-retry land, so the failure is queryable in the row
    // even after console logs expire. Stamp the failing attempt's end time too.
    const finishedAt = Date.now();
    await persistStageFailure(client, newscastID, stage, error, {
      startedAt,
      finishedAt,
    });
    throw error;
  }
}

/**
 * Best-effort write of a failing stage attempt's diagnosis into `details`
 * (failure record + attempt timing). NEVER throws: this runs on the failure
 * path, where a telemetry error must not mask the original one. Retried
 * attempts overwrite the record — the final attempt's diagnosis wins.
 */
async function persistStageFailure(
  client: SupabaseClient,
  newscastID: string,
  stage: NewscastStage,
  error: unknown,
  timing?: { startedAt: number; finishedAt: number },
): Promise<void> {
  const failure = buildFailureDetails(
    stage,
    error,
    new Date(timing?.finishedAt ?? Date.now()).toISOString(),
  );
  logger.error('Stage failed', error, {
    function: 'persistStageFailure',
    metadata: { newscastID, stage, stopReason: failure.stopReason, failedChunk: failure.failedChunk },
  });
  try {
    await mergeNewscastDetails(client, newscastID, {
      failure,
      ...(timing !== undefined
        ? {
            timings: {
              [stage]: {
                finishedAt: timing.finishedAt,
                durationMs: timing.finishedAt - timing.startedAt,
              },
            },
          }
        : {}),
    });
  } catch (telemetryError) {
    logger.warn('Failed to persist stage failure telemetry', {
      newscastID,
      stage,
      error:
        telemetryError instanceof Error ? telemetryError.message : String(telemetryError),
    }, { function: 'persistStageFailure' });
  }
}

// ---------------------------------------------------------------------------
// Which key pays for a provider call: the user's, through the vault (design §4)
// ---------------------------------------------------------------------------

/**
 * How one provider call is authenticated: through the vault with the USER's key.
 * It is spread straight into the packages' options, which then hold no key at all.
 */
interface ResolvedCredential {
  transport: ProviderTransport;
}

/**
 * Run one provider call on the user's key.
 *
 * MUST be called from INSIDE the `step.do` that makes the call: the transport
 * makes one vault round trip per call, so a key registered, replaced, or revoked
 * mid-run takes effect on the steps that have not run yet.
 *
 * ONLY {@link UserProviderKeyUnavailableError} (the vault has no key for this
 * provider) ends the newscast here, as `blocked_no_key`; the vault raises it
 * before it ever contacts the provider, so nothing has been spent. Two other
 * failures explicitly do NOT:
 * - a provider's own 401/403, which {@link guardCredential} turns into the same
 *   verdict without a retry;
 * - a vault OUTAGE (`ProviderKeyVaultUnavailableError`), which says nothing about
 *   whether the user has a key and may arrive AFTER the provider was already
 *   called. It propagates so the durable step retries.
 */
export async function withResolvedProviderKey<T>(parameters: {
  environment: Environment;
  userUUID: string;
  provider: LlmProvider;
  newscastID: string;
  /** What the call is for, for the log line only ('organize', 'script', …). */
  purpose: string;
  run: (credential: ResolvedCredential) => Promise<T>;
}): Promise<T> {
  const { environment, userUUID, provider, newscastID, purpose, run } = parameters;
  try {
    return await run({ transport: createUserKeyTransport(environment, userUUID, provider) });
  } catch (error) {
    if (!(error instanceof UserProviderKeyUnavailableError)) {
      throw error;
    }
    logger.warn('The user has no key for this provider; ending the newscast', {
      newscastID,
      purpose,
      provider,
    }, { function: 'withResolvedProviderKey' });
    throw new ProviderKeyBlockedError(
      provider,
      'no key is registered for this provider. Register a key and run the stage again.',
    );
  }
}

/** Why a newscast was blocked, in words that never quote a provider body. */
interface BlockedCredential {
  provider: LlmProvider;
  detail: string;
}

/** A step outcome that either carries its payload or reports a blocked credential. */
type CredentialGuarded<T> =
  | ({ outcome: 'ok' } & T)
  | { outcome: 'blocked'; blocked: BlockedCredential };

/**
 * Run a provider-calling step body so that a CREDENTIAL REJECTION comes back as
 * DATA instead of an exception (design §5.4).
 *
 * This is what makes "401/403 is not retried" structural rather than a policy the
 * retry machinery has to be told about: a step that RETURNS has succeeded as far
 * as Cloudflare Workflows is concerned, so its three configured attempts never
 * fire, and the provider is hit exactly once. The caller then ends the newscast
 * from outside the step. (`NonRetryableError` would express the same intent, but
 * it would still permit a second provider call from a later stage, which
 * returning early does not.)
 */
export async function guardCredential<T extends object>(
  provider: LlmProvider,
  body: () => Promise<T>,
): Promise<CredentialGuarded<T>> {
  try {
    return { outcome: 'ok', ...(await body()) };
  } catch (error) {
    if (error instanceof ProviderKeyBlockedError) {
      return { outcome: 'blocked', blocked: { provider, detail: error.detail } };
    }
    if (isProviderCredentialRejection(error)) {
      // The status only — the provider's own words are the one thing that must
      // not travel here, since a 401 body routinely echoes the key it rejected.
      const status = error instanceof ProviderRequestError ? error.status : 401;
      return {
        outcome: 'blocked',
        blocked: {
          provider,
          detail: `the provider rejected the API key (HTTP ${status}). Register a valid key and try again.`,
        },
      };
    }
    throw error;
  }
}

/**
 * Turn a blocked verdict into the error that ends the newscast, recording it as
 * the stage's failure first so the owner's debug panel shows WHERE it stopped.
 * Returned (not thrown) so the call site's `throw` keeps control-flow visible.
 */
async function endNewscastBlocked(
  client: SupabaseClient,
  newscastID: string,
  stage: NewscastStage,
  blocked: BlockedCredential,
): Promise<ProviderKeyBlockedError> {
  const error = new ProviderKeyBlockedError(blocked.provider, blocked.detail);
  logger.warn('Newscast blocked: the provider credential was refused', {
    newscastID,
    stage,
    provider: blocked.provider,
  }, { function: 'endNewscastBlocked' });
  await persistStageFailure(client, newscastID, stage, error);
  return error;
}

/**
 * Retry/timeout config per step. All steps get 3 attempts with exponential
 * backoff; the `timeout` (per attempt) is widened for the network-bound stages.
 * Because Workflows resume from the last completed step, a restart never redoes
 * a finished crawl / script / TTS batch.
 */
const CRAWL_ARTICLES_STEP_OPTIONS: WorkflowStepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};
const SCRIPT_STEP_OPTIONS: WorkflowStepConfig = {
  // 45s exponential (45s → 90s → 180s ≈ 5min span): Anthropic intermittently
  // rejects some request paths with 403 "Request not allowed" and the bad path
  // is sticky for a while — closely-spaced retries all fail together, while a
  // retry minutes later usually lands on a good path. Wider gaps ride that out.
  retries: { limit: 3, delay: '45 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};
const TTS_STEP_OPTIONS: WorkflowStepConfig = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};
const MERGE_STEP_OPTIONS: WorkflowStepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  // Widened from 2 minutes: the merge step also transcribes the MP3
  // (OpenAI whisper-1) to derive REAL caption timings before falling back.
  timeout: '5 minutes',
};
/**
 * The check-alignment-key step: one small vault read. When it cannot be answered
 * the alignment is simply attempted, so it gets few, short retries.
 */
const ALIGNMENT_KEY_STEP_OPTIONS: WorkflowStepConfig = {
  retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
  timeout: '30 seconds',
};
/**
 * The record-error step, and the report-stage-run step that follows it: both are
 * one small write, retried a little longer because they are the last word on the
 * newscast and on the stage run.
 */
const RECORD_ERROR_STEP_OPTIONS: WorkflowStepConfig = {
  retries: { limit: 5, delay: '3 seconds', backoff: 'exponential' },
  timeout: '30 seconds',
};
/**
 * Transition-sting generation (design §15): fewer retries than the
 * pipeline-critical stages because a failed sting is HARMLESS — the newscast still
 * completes, just without a between-parts sound — so we do not want it lingering.
 *
 * THE TIMEOUT MUST OUTLAST THE VAULT'S OWN. The step's provider call runs inside
 * the vault, bounded by ITS timeout (240s), and a step killed first does not
 * cancel that request: the retry would start a second Lyria generation while the
 * first is still being paid for. So this stays a round trip's margin above the
 * vault budget — 5 minutes against 240s, the same headroom the script step keeps.
 */
const SIGNAL_STEP_OPTIONS: WorkflowStepConfig = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};

/**
 * The Lyria sting request as a credential-free SPEC, for the vault to fulfil.
 *
 * It asks {@link buildSignalStingRequest} for the request SHAPE and keeps only
 * the parts a proxy may see — the provider-relative path and the JSON body —
 * dropping the credential header, which the vault injects itself. Deriving the
 * spec from the shared builder (rather than re-writing the prompt body here)
 * keeps ONE definition of what the sting request is; the empty key argument is
 * simply never used.
 */
function signalStingProxySpecification(): ProviderRequestSpecification {
  const { url, init } = buildSignalStingRequest('');
  return {
    path: new URL(url).pathname.replace(/^\/+/, ''),
    method: 'POST',
    body: typeof init.body === 'string' ? init.body : '',
    headers: { 'content-type': 'application/json' },
  };
}

/**
 * The durable newscast pipeline. `run` is re-entered on every resume; completed
 * `step.do` calls return their persisted output without re-executing, so only
 * the progress writes outside a step are (re)issued. The task group
 * (`task-group.ts`) creates the instances through `env.NEWSCAST_WORKFLOW`.
 */
export class NewscastWorkflow extends WorkflowEntrypoint<
  Environment,
  NewscastWorkflowParameters
> {
  async run(
    event: WorkflowEvent<NewscastWorkflowParameters>,
    step: WorkflowStep,
  ): Promise<void> {
    const {
      newscastID,
      userUUID,
      stageRunID,
      request,
      resume: resumeRequested,
    } = event.payload;
    const {
      entries: selectedEntries,
      url,
      customArticle,
      model: requestModel,
      effort: requestEffort,
      lengthPreference,
      ttsModel,
      speaker1Voice,
      speaker2Voice,
      signal: signalRequested,
    } = request;
    const environment = this.env;
    const client = createNewscastSupabaseClient(environment);
    const newscastState = environment.NEWSCAST_STATE;
    // Resolve the §14 sizing factor once; 'standard'/omitted both map to 1.0, so
    // the default path stays behavior-identical to before length presets.
    const lengthFactor = LENGTH_PREFERENCE_FACTORS[lengthPreference ?? 'standard'];
    // A resume runs as a BRAND NEW workflow instance, so no `step.do` output
    // survives from the failed run — only the `chk/...` KV checkpoints do. A normal
    // run WRITES checkpoints but never reads them.
    const resume = resumeRequested === true;
    // "그대로 읽기" (verbatim design §3): the pasted text IS the script. Organize and
    // script — the pipeline's only two LLM stages — are skipped outright, so this
    // run makes ZERO script-provider calls and the user's sentences reach TTS
    // exactly as they were typed. The flag is read from the parameters (and
    // therefore from the stored request on a resume) rather than inferred from the
    // text, so a resumed verbatim newscast can never fall back into the stages it
    // skipped.
    const verbatim = customArticle !== undefined && isVerbatimCustomArticle(customArticle);
    // Where this run's checkpoints live: `chk/{userUUID}/{newscastID}/...`.
    const checkpoints = resolveCheckpointScope(userUUID, newscastID);

    let failure: unknown;
    try {
      logger.info('Newscast workflow started', { newscastID, stageRunID, resume }, { function: 'run' });

      // Load the whole-pipeline checkpoints up front (a resume only) and let the
      // pure §3b rules decide which leading stages may be skipped. The first miss
      // makes every later stage live; per-part reuse is gated on the part plan.
      // A verbatim run writes neither of the first two checkpoints (it has no crawl
      // and no organization), so it does not read them either — its articles and
      // part split are re-derived below from the same parameters in microseconds.
      const articlesCheckpoint =
        resume && !verbatim
          ? await readCheckpoint<Article[]>(newscastState, checkpoints.articles)
          : null;
      const planCheckpoint =
        resume && !verbatim
          ? await readCheckpoint<PlanCheckpoint>(newscastState, checkpoints.plan)
          : null;
      const signalCheckpoint = resume
        ? await readCheckpoint<SignalCheckpoint>(newscastState, checkpoints.signal)
        : null;
      const reuse = verbatim
        ? resolveVerbatimPipelineReuse(resume, {
            signal: isSignalCheckpointUsable(signalCheckpoint),
          })
        : resolvePipelineReuse(resume, {
            articles: isArticlesCheckpointUsable(articlesCheckpoint),
            plan: isPlanCheckpointUsable(planCheckpoint),
            signal: isSignalCheckpointUsable(signalCheckpoint),
          });
      if (resume) {
        logger.info('Resume checkpoint reuse resolved', {
          newscastID,
          articles: reuse.articles,
          plan: reuse.plan,
          signal: reuse.signal,
          parts: reuse.parts,
        }, { function: 'run' });
      }

      // The pasted-article path (design §13) skips the crawl — there is nothing
      // to fetch. It builds the single inline article, records crawl-list
      // telemetry directly (no durable step: the running newscast shows a title
      // from details.crawlList before any result exists), and jumps the stage to
      // 'organize' (the web StageTracker auto-marks the earlier stages complete).
      // Otherwise the crawl-articles step reads the article. There is no
      // crawl-list step: the list is the previous stage's output (design §4).
      let articles: Article[];
      if (reuse.articles && articlesCheckpoint !== null) {
        // §3b-1: the crawl already succeeded in the failed run — reuse its output
        // verbatim and skip the crawl step. The crawl telemetry from that run is
        // still on the newscast row, so only the timings/stage need refreshing.
        articles = articlesCheckpoint;
        logger.info('Reusing crawled articles from a checkpoint', {
          newscastID,
          count: articles.length,
        }, { function: 'run' });
        await recordReusedStage(client, newscastID, 'crawl-list', 1);
        await recordReusedStage(client, newscastID, 'crawl-articles', 1);
        await updateNewscastStage(client, newscastID, 'organize', 0);
      } else if (customArticle !== undefined) {
        const title = resolveCustomArticleTitle(customArticle);
        articles = [
          {
            title,
            content: customArticle.content,
            // No source URLs for pasted text; the web renders a "직접 입력" badge
            // instead of the original/discussion links when both are empty.
            originalUrl: '',
            discussionUrl: '',
          },
        ];
        await mergeNewscastDetails(client, newscastID, {
          crawlList: {
            count: 1,
            titles: [title],
            bytes: byteLength(customArticle.content),
          },
        });
        // THE STAGE JUMP (verbatim design §3): a verbatim newscast's next real work
        // is synthesis, so it lands on 'tts' and the web marks organize/script as
        // skipped; an ordinary pasted newscast still starts at 'organize'.
        await updateNewscastStage(client, newscastID, verbatim ? 'tts' : 'organize', 0);
      } else {
        // The one article of this newscast: a list entry, or the `{ url }` input
        // read as an article whose only source is the page itself.
        const entries: GeekNewsEntry[] =
          url !== undefined
            ? [{ title: url, originalUrl: url, discussionUrl: '' }]
            : (selectedEntries ?? []);
        if (entries.length === 0) {
          throw new Error('The newscast request has no source to read.');
        }
        // What the crawl-list step recorded when it fetched the list itself; the
        // list now comes from the previous stage, so the entry is recorded inline.
        await mergeNewscastDetails(client, newscastID, {
          crawlList: {
            count: entries.length,
            titles: entries.map((entry) => entry.title),
            bytes: JSON.stringify(entries).length,
          },
        });
        // A `{ url }` source is the page alone: no GeekNews topic, and no Hacker
        // News lookup for a URL nobody listed (design §4).
        const readsDiscussions = url === undefined;

        // Step — crawl-articles: for each entry gather THREE kinds of source
        // material concurrently — the original page content, the GeekNews topic
        // summary (submitter's write-up, never comments), and the article's Hacker
        // News top comments. Each fetch is independently failure-tolerant (degrades
        // to '' rather than throwing), so a single missing source never fails the
        // step.
        articles = await step.do(
          'crawl-articles',
          CRAWL_ARTICLES_STEP_OPTIONS,
          () =>
            withStageTiming(client, newscastID, 'crawl-articles', async () => {
              await updateNewscastStage(client, newscastID, 'crawl-articles', 0);
              const collected: Article[] = [];
              // Per-article record of WHY a source degraded to empty (crawler
              // threw), keyed by list position. Persisted into the telemetry so an
              // empty source is diagnosable from the debug panel.
              const degradationsByIndex: string[][] = [];
              for (let index = 0; index < entries.length; index += 1) {
                const entry = entries[index];
                const degradations: string[] = [];
                const tag = (source: string) => (reason: string) =>
                  degradations.push(`${source}: ${reason}`);
                const [content, geeknewsSummary, hackerNewsComments] = await Promise.all([
                  crawlTextViaManager(environment, 'article-content', entry.originalUrl, tag('original')),
                  readsDiscussions
                    ? crawlTextViaManager(environment, 'geeknews-summary', entry.discussionUrl, tag('geeknews'))
                    : Promise.resolve(''),
                  readsDiscussions
                    ? crawlHackerNewsViaManager(environment, entry.originalUrl, tag('hackernews'))
                    : Promise.resolve(''),
                ]);
                collected.push({ ...entry, content, geeknewsSummary, hackerNewsComments });
                degradationsByIndex.push(degradations);
                await updateNewscastStage(
                  client,
                  newscastID,
                  'crawl-articles',
                  (index + 1) / entries.length,
                );
              }
              const articleInfos = collected.map((article, index) => ({
                title: article.title,
                originalBytes: byteLength(article.content),
                geeknewsBytes: byteLength(article.geeknewsSummary ?? ''),
                hackerNewsBytes: byteLength(article.hackerNewsComments ?? ''),
                ...(degradationsByIndex[index].length > 0
                  ? { degradations: degradationsByIndex[index] }
                  : {}),
              }));
              const totalBytes = articleInfos.reduce(
                (sum, info) =>
                  sum + info.originalBytes + info.geeknewsBytes + info.hackerNewsBytes,
                0,
              );
              await mergeNewscastDetails(client, newscastID, {
                crawlArticles: { articles: articleInfos, totalBytes },
              });
              if (url !== undefined && collected.every((article) => article.content.length === 0)) {
                // The page is the only material of a `{ url }` newscast: without it
                // the script would be written from the URL alone. Thrown after the
                // telemetry, so the degradation reason is on the row, and inside
                // the step, so a transient crawl failure is retried.
                throw new Error(`The article at ${url} could not be read.`);
              }
              return collected;
            }),
        );
      }
      if (!verbatim && !reuse.articles) {
        // Mirror the crawl output into KV so a LATER resume (a different workflow
        // instance, where no step output survives) can skip the crawl entirely.
        // A verbatim newscast rebuilds its single article from the parameters
        // instead, so checkpointing it would only be a KV write nobody reads.
        await writeCheckpoint(newscastState, checkpoints.articles, articles);
      }

      // Step 3 — organize: structure the crawled material into speakable units and
      // let the code (NOT the LLM) decide the part count + per-part turn targets
      // (design §4/§2). On failure — after the step's own retries — the pipeline
      // does NOT die: the outer try/catch degrades to a single-part plan with no
      // units (details.organize.degraded = true), and the per-part script
      // generator then runs in its no-coverage fallback mode. organize reuses
      // SCRIPT_STEP_OPTIONS (3 retries · 45s · 5min): it is one more LLM call to the same
      // provider, so the same 403-path ride-out applies.
      // The provider is a plain routing decision and stays out here; the KEY is
      // resolved inside each step below, so a key registered, replaced, or revoked
      // mid-run takes effect on the next step instead of being pinned by a closure
      // for the life of the newscast.
      const provider: LlmProvider = request.provider ?? 'google';
      let units: OrganizedUnit[];
      let plans: NewscastPartPlan[];
      /** A verbatim newscast's per-part utterances; empty for every other newscast. */
      let verbatimParts: VerbatimScriptLine[][] = [];
      if (verbatim && customArticle !== undefined) {
        // The whole point of the feature (design §3): parse the pasted text into
        // utterances and split it into parts, INLINE — no durable step. Both halves
        // are pure functions of `customArticle.content`, which a resume replays
        // byte-for-byte, so a step would add a KV round trip and a retry policy to
        // code that cannot fail and produces the same answer every time.
        verbatimParts = splitVerbatimParts(parseVerbatimScript(customArticle.content).lines);
        if (verbatimParts.length === 0) {
          // The task group input rejects this (`empty_verbatim_script`), so
          // reaching it means the parameters were built some other way. Fail
          // loudly rather than "complete" a newscast with no audio in it.
          throw new Error('The verbatim script parsed to no lines to read.');
        }
        units = [];
        // One plan per part, purely so the loops below (the sting gate, per-part
        // reuse, TTS, merge) keep fanning out over a single shape. `turnTarget` is
        // the part's ACTUAL line count rather than a target — nothing is generated
        // against it here. Bounded only by the 24,000-character input cap, which
        // holds this at 8 parts.
        plans = verbatimParts.map((part, position) => ({
          index: position + 1,
          unitIndexes: [],
          turnTarget: part.length,
        }));
        logger.info('Verbatim newscast: organize and script skipped entirely', {
          newscastID,
          parts: plans.length,
          lines: verbatimParts.reduce((sum, part) => sum + part.length, 0),
          characters: countVerbatimCharacters(verbatimParts.flat()),
        }, { function: 'run' });
      } else if (reuse.plan && planCheckpoint !== null) {
        // §3b-2: a HEALTHY organization from the failed run is reused as-is. A
        // DEGRADED plan is deliberately NOT reusable (isPlanCheckpointUsable rejects
        // it) — a resume is exactly the chance to get a real organization back.
        units = planCheckpoint.units;
        plans = planCheckpoint.plans;
        logger.info('Reusing the organized part plan from a checkpoint', {
          newscastID,
          unitCount: units.length,
          partCount: plans.length,
        }, { function: 'run' });
        await recordReusedStage(client, newscastID, 'organize', 1);
      } else {
        let organizeDegraded = false;
        let organizeBlocked: BlockedCredential | undefined;
        try {
          const organized = await step.do('organize', SCRIPT_STEP_OPTIONS, () =>
            withStageTiming(client, newscastID, 'organize', async () =>
              // A refused credential comes back as data (design §5.4): it must not
              // reach the step's retries, and — because organize otherwise DEGRADES
              // on failure — it must not be mistaken for "the model wrote nothing
              // useful" either, which would let the script stage hit the same bad
              // key a second time.
              guardCredential(provider, async () => {
                await updateNewscastStage(client, newscastID, 'organize', 0);
                const organization = await withResolvedProviderKey({
                  environment,
                  userUUID,
                  provider,
                  newscastID,
                  purpose: 'organize',
                  run: (credential) =>
                    generateNewscastOrganization({
                      provider,
                      ...credential,
                      articles,
                      model: requestModel,
                      effort: requestEffort,
                    }),
                });
                const organizedPlans = planNewscastParts(articles, organization.units, { lengthFactor });
                await mergeNewscastDetails(client, newscastID, {
                  organize: {
                    provider,
                    model: organization.model,
                    unitCount: organization.units.length,
                    estimatedScriptCharacters:
                      estimatedScriptCharactersFromPlans(organizedPlans),
                    partCount: organizedPlans.length,
                    turnTargets: organizedPlans.map((plan) => plan.turnTarget),
                    promptTokens: organization.promptTokens,
                    completionTokens: organization.completionTokens,
                    lengthFactor,
                  },
                });
                await updateNewscastStage(client, newscastID, 'organize', 1);
                return { units: organization.units, plans: organizedPlans };
              }),
            ),
          );
          if (organized.outcome === 'blocked') {
            // Settled below, OUTSIDE the step, so the step neither retries nor
            // degrades — the newscast is over.
            organizeBlocked = organized.blocked;
            units = [];
            plans = [];
          } else {
            units = organized.units;
            plans = organized.plans;
          }
        } catch (error) {
          // Graceful degrade (design §4): organization failed after its retries, so
          // fall back to a single part with no units instead of failing the
          // newscast. The per-part generator runs in its no-coverage fallback mode
          // from here.
          logger.warn('Organize stage degraded to a single-part newscast', {
            newscastID,
            error: error instanceof Error ? error.message : String(error),
          }, { function: 'run' });
          units = [];
          plans = singlePartFallbackPlan(articles, lengthFactor);
          organizeDegraded = true;
          await mergeNewscastDetails(client, newscastID, {
            organize: {
              provider,
              model: requestModel ?? defaultModelForProvider(provider),
              unitCount: 0,
              estimatedScriptCharacters: estimatedScriptCharactersFromPlans(plans),
              partCount: plans.length,
              turnTargets: plans.map((plan) => plan.turnTarget),
              degraded: true,
              lengthFactor,
            },
          });
          await updateNewscastStage(client, newscastID, 'organize', 1);
        }
        if (organizeBlocked !== undefined) {
          // No checkpoint: there is no plan, and the next run must start from a
          // key decision rather than from a half-organized newscast.
          throw await endNewscastBlocked(client, newscastID, 'organize', organizeBlocked);
        }
        // Checkpoint the settled plan INCLUDING the degraded verdict (§3a: recorded
        // "organize 확정 직후(폴백 포함)"), which is what lets a resume tell a real
        // organization apart from the fallback and re-attempt only the latter.
        await writeCheckpoint(newscastState, checkpoints.plan, {
          units,
          plans,
          lengthFactor,
          ...(organizeDegraded ? { degraded: true } : {}),
        } satisfies PlanCheckpoint);
      }
      const partCount = plans.length;

      // Step — generate-signal (design §15): a FRESH per-newscast transition sting
      // via Lyria, generated ONLY when the stage's `signal` setting is on and the
      // newscast has two or more parts — a one-part newscast has no part boundary
      // to bridge, and with the setting off the sting is neither made nor shown.
      // It is independent of script/TTS, so it slots in right after the part plan
      // is known. The step writes the MP3 STRAIGHT to R2 (key `${newscastID}/signal`)
      // and returns only tiny metadata — the audio never rides through the step
      // output (1 MiB limit); a later consumer re-reads it from R2 by key. ANY
      // failure (HTTP error, no audio in the response, or an R2 error after the
      // step's own retries) is swallowed: the newscast continues WITHOUT a signal
      // (the player's transition slot stays empty → parts advance immediately),
      // mirroring the organize stage's degraded posture. `signalGenerated` gates
      // whether the final result advertises the key; on a Workflow resume the
      // completed step returns its cached `{ generated }` so the flag is restored
      // deterministically.
      const signalWanted = signalRequested === true && partCount >= 2;
      let signalGenerated = false;
      if (signalWanted && reuse.signal && signalCheckpoint !== null) {
        // §3b-3: the sting verdict from the failed run is trusted (including a
        // `false` one — the checkpoint is written after the DECISION, success or
        // not), so the R2 object is left exactly as it is.
        signalGenerated = signalCheckpoint.generated;
        logger.info('Reusing the signal-sting verdict from a checkpoint', {
          newscastID,
          generated: signalGenerated,
        }, { function: 'run' });
      } else if (signalWanted) {
        try {
          const signal = await step.do('generate-signal', SIGNAL_STEP_OPTIONS, () =>
            // A REFUSED credential must not be retried here either (design §5.4):
            // the sting's two extra attempts would present the user's rejected
            // Google key to Google twice more, which is the credential-stuffing
            // pattern that gets a real account locked. `guardCredential` turns it
            // into data, and the sting keeps its harmless posture — the verdict is
            // read below as "no sting", never as a reason to end the newscast.
            guardCredential('google', async () => {
              // Lyria rides on the Google credential (design §15), so it follows the
              // same user-key rule as script generation — with the sting's
              // harmless-failure posture kept intact: a key the provider REFUSES
              // fails this step and the newscast simply plays without a transition
              // sound.
              const payload = await withResolvedProviderKey({
                environment,
                userUUID,
                provider: 'google',
                newscastID,
                purpose: 'signal-sting',
                run: async (credential): Promise<unknown> => {
                  // The answer goes through the shared reader, so the
                  // status-carrying, masked, §5.4-shaped error has one definition.
                  const proxied = await credential.transport(signalStingProxySpecification());
                  return readSignalStingResponse(proxied.status, proxied.body);
                },
              });
              const base64 = extractSignalAudio(payload);
              if (base64 === null) {
                throw new Error('Lyria signal response did not contain inline audio data.');
              }
              const bytes = decodeSignalAudioBytes(base64);
              // Lyria returns 44.1kHz stereo MP3; it plays client-side (never merged
              // into the 24kHz mono pipeline PCM), so store it verbatim as audio/mpeg.
              await environment.NEWSCAST_AUDIO.put(`${newscastID}/signal`, bytes, {
                httpMetadata: { contentType: 'audio/mpeg' },
              });
              await mergeNewscastDetails(client, newscastID, {
                signal: { generated: true, bytes: bytes.byteLength },
              });
              return { generated: true };
            }),
          );
          if (signal.outcome === 'blocked') {
            // The key was refused, or the user has none. The newscast still ships —
            // it just advances between parts in silence — so this is recorded like
            // any other failed sting rather than ending the newscast the way
            // organize/script/TTS do.
            logger.warn('Signal sting skipped: the Google credential was refused', {
              newscastID,
              provider: signal.blocked.provider,
            }, { function: 'run' });
            signalGenerated = false;
            await mergeNewscastDetails(client, newscastID, { signal: { generated: false } });
          } else {
            signalGenerated = signal.generated;
          }
        } catch (error) {
          logger.warn(
            'Signal sting generation failed; continuing without a transition signal',
            {
              newscastID,
              error: error instanceof Error ? error.message : String(error),
            },
            { function: 'run' },
          );
          signalGenerated = false;
          await mergeNewscastDetails(client, newscastID, { signal: { generated: false } });
        }
        await writeCheckpoint(newscastState, checkpoints.signal, {
          generated: signalGenerated,
        } satisfies SignalCheckpoint);
      }

      // Step 4 — per-part script: generate each part's dialogue on its own durable
      // step, sequentially. Each part is told its dynamic turn target, which units
      // to cover, and which headlines earlier/later parts own (no-repeat /
      // no-poach). The whole-newscast details.script stays an aggregate (turns /
      // characters / tokens summed across parts) so the web telemetry remains one
      // figure, and the 'script' stage timing spans every part step — first part
      // stamps startedAt, last stamps finishedAt — mirroring the cross-step tts
      // timing below.
      // §3b-4: per-part reuse, decided ONCE up front so the script / TTS / merge
      // loops below all agree on what each part is doing. Parts are INDEPENDENT —
      // part 1 may come straight from its merge checkpoint while part 2 runs live.
      const mergedCheckpoints: Array<MergedPartCheckpoint | null> = [];
      const scriptCheckpoints: Array<ScriptPartCheckpoint | null> = [];
      const ttsCheckpoints: Array<TtsPartCheckpoint | null> = [];
      const partReusePlans: PartReusePlan[] = [];
      for (let partPosition = 0; partPosition < plans.length; partPosition += 1) {
        const partIndex = partPosition + 1;
        const merged = reuse.parts
          ? await readCheckpoint<MergedPartCheckpoint>(newscastState, checkpoints.mergedPart(partIndex))
          : null;
        const scripted = reuse.parts
          ? await readCheckpoint<ScriptPartCheckpoint>(newscastState, checkpoints.scriptPart(partIndex))
          : null;
        const synthesized = reuse.parts
          ? await readCheckpoint<TtsPartCheckpoint>(newscastState, checkpoints.ttsPart(partIndex))
          : null;
        mergedCheckpoints.push(merged);
        scriptCheckpoints.push(scripted);
        ttsCheckpoints.push(synthesized);
        partReusePlans.push(
          resolvePartReuse(reuse.parts, {
            merged: isMergedPartCheckpointUsable(merged),
            // A verbatim part's lines ARE the pasted text, re-derived identically
            // above, so its dialogue is always reusable — there is no script
            // checkpoint to prove it because no script step ever ran. Without
            // this, a resumed verbatim newscast would count as "nothing reusable"
            // and re-synthesize audio it had already paid for.
            script: verbatim || isScriptPartCheckpointUsable(scripted),
            tts: isTtsPartCheckpointUsable(synthesized),
          }),
        );
      }
      if (resume) {
        logger.info('Resume per-part reuse resolved', {
          newscastID,
          modes: partReusePlans.map((partReuse) => partReuse.mode),
        }, { function: 'run' });
      }

      const partScripts: ScriptLine[][] = [];
      const scriptMetas: Array<{
        turns: number;
        characters: number;
        promptTokens?: number;
        completionTokens?: number;
      }> = [];
      let scriptStartedAt: number | undefined;
      // A verbatim newscast's dialogue was settled above, so it seeds the same
      // in-memory arrays the generation loop would have filled — with no timing, no
      // token counts, no `details.script` and no checkpoint, because nothing was
      // called. The stage itself is skipped: the run is already sitting on 'tts'.
      for (const part of verbatimParts) {
        partScripts.push([...part]);
        scriptMetas.push({
          turns: part.length,
          characters: countVerbatimCharacters(part),
        });
      }
      // Which parts still need dialogue WRITTEN — none at all for a verbatim
      // newscast, which is how the pipeline's second (and last) LLM stage is skipped.
      const scriptPlans = verbatim ? [] : plans;
      for (let partPosition = 0; partPosition < scriptPlans.length; partPosition += 1) {
        const plan = plans[partPosition];
        const partIndex = partPosition + 1;
        const partReuse = partReusePlans[partPosition];
        const mergedCheckpoint = mergedCheckpoints[partPosition];
        const scriptCheckpoint = scriptCheckpoints[partPosition];
        if (partReuse.mode === 'merged' && mergedCheckpoint !== null) {
          // The whole part is already finished — its dialogue only has to re-enter
          // the in-memory arrays so the aggregates and finalize still see it.
          const reusedLines = mergedCheckpoint.part.script;
          partScripts.push(reusedLines);
          scriptMetas.push({
            turns: reusedLines.length,
            characters: reusedLines.reduce((sum, line) => sum + line.text.length, 0),
          });
          await updateNewscastStage(
            client,
            newscastID,
            'script',
            (partPosition + 1) / plans.length,
          );
          continue;
        }
        if (partReuse.mode === 'script' && scriptCheckpoint !== null) {
          partScripts.push(scriptCheckpoint.lines);
          scriptMetas.push({
            turns: scriptCheckpoint.turns,
            characters: scriptCheckpoint.characters,
            promptTokens: scriptCheckpoint.promptTokens,
            completionTokens: scriptCheckpoint.completionTokens,
          });
          await updateNewscastStage(
            client,
            newscastID,
            'script',
            (partPosition + 1) / plans.length,
          );
          continue;
        }
        const isFirstPart = partPosition === 0;
        const isLastPart = partPosition === plans.length - 1;
        const priorMetas = [...scriptMetas];
        const stageStartedAt = scriptStartedAt;
        const previousHeadlines = plans
          .slice(0, partPosition)
          .flatMap((earlier) => headlinesForPlan(units, earlier));
        const nextHeadlines = plans
          .slice(partPosition + 1)
          .flatMap((later) => headlinesForPlan(units, later));
        const generatedPart = await step.do(
          `script-part-${plan.index}`,
          SCRIPT_STEP_OPTIONS,
          () =>
            guardCredential(provider, async () => {
              const startedAt = Date.now();
              if (isFirstPart) {
                await updateNewscastStage(client, newscastID, 'script', 0);
                // Record the request parameters BEFORE the first LLM call so a failed
                // run still shows which provider/model/effort it was using.
                await mergeNewscastDetails(client, newscastID, {
                  scriptRequest: {
                    provider,
                    model: requestModel,
                    effort: requestEffort,
                  },
                  timings: { script: { startedAt } },
                });
              }
              const generated = await withResolvedProviderKey({
                environment,
                userUUID,
                provider,
                newscastID,
                purpose: 'script',
                run: (credential) =>
                  generateNewscastPartScript({
                    provider,
                    ...credential,
                    articles,
                    units,
                    plan,
                    partCount,
                    previousHeadlines,
                    nextHeadlines,
                    model: requestModel,
                    effort: requestEffort,
                    lengthPreference,
                  }),
              });
              const characters = generated.lines.reduce(
                (sum, line) => sum + line.text.length,
                0,
              );
              await updateNewscastStage(
                client,
                newscastID,
                'script',
                (partPosition + 1) / plans.length,
              );
              if (isLastPart) {
                // Aggregate details.script across all parts (this part + the cached
                // outputs of the earlier ones) and close the stage timing.
                const turns =
                  priorMetas.reduce((sum, meta) => sum + meta.turns, 0) +
                  generated.lines.length;
                const totalCharacters =
                  priorMetas.reduce((sum, meta) => sum + meta.characters, 0) +
                  characters;
                const promptTokens = sumOptionalCounts([
                  ...priorMetas.map((meta) => meta.promptTokens),
                  generated.promptTokens,
                ]);
                const completionTokens = sumOptionalCounts([
                  ...priorMetas.map((meta) => meta.completionTokens),
                  generated.completionTokens,
                ]);
                const startedAtForStage = isFirstPart ? startedAt : stageStartedAt;
                const finishedAt = Date.now();
                await mergeNewscastDetails(client, newscastID, {
                  script: {
                    provider,
                    model: generated.model,
                    turns,
                    characters: totalCharacters,
                    promptTokens,
                    completionTokens,
                  },
                  timings: {
                    script: {
                      finishedAt,
                      durationMs:
                        startedAtForStage === undefined
                          ? undefined
                          : finishedAt - startedAtForStage,
                    },
                  },
                });
              }
              return {
                lines: generated.lines,
                turns: generated.lines.length,
                characters,
                promptTokens: generated.promptTokens,
                completionTokens: generated.completionTokens,
                stageStartedAt: isFirstPart ? startedAt : undefined,
              };
            }),
        );
        if (generatedPart.outcome === 'blocked') {
          // Same rule as organize: end the newscast from OUTSIDE the step, so this
          // part's three retries never re-present the rejected key and no later
          // part starts a fresh attempt against it either.
          throw await endNewscastBlocked(client, newscastID, 'script', generatedPart.blocked);
        }
        if (isFirstPart) {
          scriptStartedAt = generatedPart.stageStartedAt;
        }
        scriptMetas.push({
          turns: generatedPart.turns,
          characters: generatedPart.characters,
          promptTokens: generatedPart.promptTokens,
          completionTokens: generatedPart.completionTokens,
        });
        partScripts.push(generatedPart.lines);
        await writeCheckpoint(newscastState, checkpoints.scriptPart(partIndex), {
          lines: generatedPart.lines,
          turns: generatedPart.turns,
          characters: generatedPart.characters,
          promptTokens: generatedPart.promptTokens,
          completionTokens: generatedPart.completionTokens,
        } satisfies ScriptPartCheckpoint);
      }
      // The whole-newscast details.script aggregate normally rides in the LAST
      // part's step. When that part was reused the step never ran, so close the
      // aggregate here instead — but only if some OTHER part ran live, since an
      // all-reused script leaves the failed run's already-correct aggregate in place.
      const lastScriptMode = partReusePlans[plans.length - 1]?.mode ?? 'live';
      if (lastScriptMode !== 'live' && partReusePlans.some((one) => one.mode === 'live')) {
        await mergeNewscastDetails(client, newscastID, {
          script: {
            provider,
            model: requestModel ?? defaultModelForProvider(provider),
            turns: scriptMetas.reduce((sum, meta) => sum + meta.turns, 0),
            characters: scriptMetas.reduce((sum, meta) => sum + meta.characters, 0),
            promptTokens: sumOptionalCounts(scriptMetas.map((meta) => meta.promptTokens)),
            completionTokens: sumOptionalCounts(
              scriptMetas.map((meta) => meta.completionTokens),
            ),
          },
        });
      }

      // Step 5 — tts: with every part's dialogue fixed, chunk each part into turn
      // groups and synthesize each chunk on its own durable step (design §7-3). Each
      // chunk's raw PCM lands in KV under seg/${newscastID}/p${p}/${c} so a part's
      // merge step reads back exactly its own chunks. Progress advances by completed
      // chunks across ALL parts, and the 'tts' stage timing spans the whole set of
      // chunk steps: the first chunk overall stamps startedAt, the last stamps
      // finishedAt + the aggregate details.tts (both kept inside durable steps so a
      // completed step never re-times on resume).
      // A part reused straight from its merge checkpoint has NO chunk work left, so
      // it contributes zero chunks — it is skipped by both the TTS and merge loops.
      const partChunks = partScripts.map((partScript, partPosition) =>
        partReusePlans[partPosition].mode === 'merged'
          ? []
          : chunkScriptIntoTurnGroups(partScript),
      );
      const chunkOffsets: number[] = [];
      let chunksBefore = 0;
      for (const chunks of partChunks) {
        chunkOffsets.push(chunksBefore);
        chunksBefore += chunks.length;
      }
      const totalChunks = chunksBefore;
      const chunkAudioMetas: Array<{ byteLength: number; sampleRate: number }> = [];
      let ttsStartedAt: number | undefined;
      for (let partPosition = 0; partPosition < partChunks.length; partPosition += 1) {
        const partIndex = partPosition + 1;
        const chunks = partChunks[partPosition];
        const partReuse = partReusePlans[partPosition];
        const ttsCheckpoint = ttsCheckpoints[partPosition];
        const partChunkMetas: ChunkAudioMeta[] = [];
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          const globalOrdinal = chunkOffsets[partPosition] + chunkIndex;
          const isFirstChunk = globalOrdinal === 0;
          const isLastChunk = globalOrdinal === totalChunks - 1;
          const priorMetas = [...chunkAudioMetas];
          const stageStartedAt = ttsStartedAt;
          const chunk = chunks[chunkIndex];
          // §3b-4: on a resume of a part whose dialogue is unchanged, a chunk whose
          // PCM is ALREADY in KV is skipped chunk by chunk — that is how a part that
          // died mid-TTS keeps the chunks it did synthesize. Its sample rate comes
          // from the part's TTS checkpoint when the whole part finished before;
          // otherwise every chunk shares the one Gemini TTS rate anyway.
          const reuseChunkAudio = partReuse.reuseChunkAudio;
          const checkpointMeta = partReuse.reuseChunkMetas
            ? ttsCheckpoint?.chunks[chunkIndex]
            : undefined;
          const meta = await step.do(
            `tts-part-${partIndex}-chunk-${chunkIndex}`,
            TTS_STEP_OPTIONS,
            // Same §5.4 posture as organize/script: a refused Google key comes back
            // as DATA, so the step completes once instead of re-presenting a
            // rejected credential on all three of its attempts — and no LATER chunk
            // starts a fresh attempt against it either, since the newscast ends below.
            () =>
              guardCredential('google', async () => {
                const startedAt = Date.now();
                if (isFirstChunk) {
                  await mergeNewscastDetails(client, newscastID, {
                    timings: { tts: { startedAt } },
                  });
                }
                const chunkKey = partChunkAudioKey(newscastID, partIndex, chunkIndex);
                let chunkByteLength = 0;
                let sampleRate = FALLBACK_SAMPLE_RATE;
                let reusedChunk = false;
                if (reuseChunkAudio) {
                  const stored = await newscastState.get(chunkKey, 'arrayBuffer');
                  if (stored !== null) {
                    chunkByteLength = stored.byteLength;
                    sampleRate = checkpointMeta?.sampleRate ?? FALLBACK_SAMPLE_RATE;
                    reusedChunk = true;
                  }
                }
                if (!reusedChunk) {
                  let pcm: Uint8Array;
                  try {
                    // The newscast's SPEECH — its largest single cost — on the user's
                    // Google key. Google is fixed here whatever the script provider
                    // is: the two-host audio is the Gemini Developer API's
                    // multi-speaker TTS.
                    ({ pcm, sampleRate } = await withResolvedProviderKey({
                      environment,
                      userUUID,
                      provider: 'google',
                      newscastID,
                      purpose: 'tts',
                      run: (credential) =>
                        synthesizeDialogueChunk({
                          ...credential,
                          turns: chunk,
                          speaker1Voice,
                          speaker2Voice,
                          // The newscast's TTS model (checked when the stage started,
                          // and kept in the request, so reused and fresh chunks share it).
                          ...(ttsModel !== undefined ? { model: ttsModel } : {}),
                          // A verbatim chunk is read, not performed (design §3):
                          // the default directive asserts a two-host CHAT, which
                          // makes the model improvise around sentences the user
                          // chose. Every other newscast keeps that default. The 3.8
                          // models take the same intent as `speechStyle`.
                          ...(verbatim
                            ? {
                                stylePrompt: VERBATIM_READING_STYLE_PROMPT,
                                speechStyle: VERBATIM_SPEECH_STYLE,
                              }
                            : {}),
                        }),
                    }));
                  } catch (error) {
                    if (
                      error instanceof ProviderKeyBlockedError ||
                      isProviderCredentialRejection(error)
                    ) {
                      // Out to the `guardCredential` wrapper UNWRAPPED: it matches on
                      // the error itself, and a StageFailureError around it would
                      // hide a refused key — turning "end the newscast" into three
                      // more attempts against the user's own Google account.
                      throw error;
                    }
                    // Chunk steps run OUTSIDE withStageTiming (each chunk is its own
                    // durable step), so persist the failure diagnosis here — including
                    // WHICH chunk (part + its overall ordinal) failed — before the
                    // step-retry machinery takes over.
                    const message = error instanceof Error ? error.message : String(error);
                    const chunkError = new StageFailureError(
                      `TTS part ${partIndex} chunk ${chunkIndex + 1}/${chunks.length} ` +
                        `(overall ${globalOrdinal + 1}/${totalChunks}): ${message}`,
                      { failedChunk: globalOrdinal, cause: error },
                    );
                    await persistStageFailure(client, newscastID, 'tts', chunkError);
                    throw chunkError;
                  }
                  await newscastState.put(chunkKey, pcm, {
                    expirationTtl: NEWSCAST_STATE_TIME_TO_LIVE_SECONDS,
                  });
                  chunkByteLength = pcm.length;
                }
                // Progress advances by completed chunks across all parts.
                await updateNewscastStage(
                  client,
                  newscastID,
                  'tts',
                  totalChunks === 0 ? 1 : (globalOrdinal + 1) / totalChunks,
                );
                if (isLastChunk) {
                  // Total audio duration across ALL parts' chunks, computed the SAME
                  // way the merge steps do (per-chunk rounded PCM duration, summed, at
                  // one uniform sample rate) so the figures agree. Prior chunks come
                  // from cached step outputs.
                  const uniformSampleRate = priorMetas[0]?.sampleRate ?? sampleRate;
                  let audioDurationMs = 0;
                  for (const priorMeta of priorMetas) {
                    audioDurationMs += Math.round(
                      pcmDurationMs(priorMeta.byteLength, uniformSampleRate),
                    );
                  }
                  audioDurationMs += Math.round(
                    pcmDurationMs(chunkByteLength, uniformSampleRate),
                  );
                  const startedAtForStage = isFirstChunk ? startedAt : stageStartedAt;
                  const finishedAt = Date.now();
                  await mergeNewscastDetails(client, newscastID, {
                    tts: { chunks: totalChunks, audioDurationMs },
                    timings: {
                      tts: {
                        finishedAt,
                        durationMs:
                          startedAtForStage === undefined
                            ? undefined
                            : finishedAt - startedAtForStage,
                      },
                    },
                  });
                }
                return {
                  byteLength: chunkByteLength,
                  sampleRate,
                  stageStartedAt: isFirstChunk ? startedAt : undefined,
                };
              }),
          );
          if (meta.outcome === 'blocked') {
            // Settled OUTSIDE the step, like organize and script: the newscast is
            // over, and the remaining chunks never run.
            throw await endNewscastBlocked(client, newscastID, 'tts', meta.blocked);
          }
          if (isFirstChunk) {
            ttsStartedAt = meta.stageStartedAt;
          }
          chunkAudioMetas.push({
            byteLength: meta.byteLength,
            sampleRate: meta.sampleRate,
          });
          partChunkMetas.push({
            byteLength: meta.byteLength,
            sampleRate: meta.sampleRate,
          });
        }
        if (chunks.length > 0) {
          // §3a: written only once EVERY chunk of the part is in KV, so a hit on
          // this key means the whole part's audio (and its sample rate) is reusable.
          await writeCheckpoint(newscastState, checkpoints.ttsPart(partIndex), {
            chunks: partChunkMetas,
          } satisfies TtsPartCheckpoint);
        }
      }

      // Step — check-alignment-key (design §4: the Whisper alignment uses the OpenAI
      // key when the user has one, and the estimate otherwise). Asked ONCE per
      // newscast, as a durable step so a replay reads the verdict back instead of
      // asking again, and BEFORE the merge steps, so a user without the key never
      // has a whole part MP3 base64-encoded and posted to the vault only to be
      // answered `no_key`. Only parts that still merge need it. When the vault
      // cannot say, after the step's retries, the alignment is attempted as before:
      // a failed attempt keeps the estimate.
      let attemptsAlignment = true;
      if (partReusePlans.some((partReuse) => partReuse.mode !== 'merged')) {
        try {
          const alignmentKey = await step.do(
            'check-alignment-key',
            ALIGNMENT_KEY_STEP_OPTIONS,
            async () => ({
              configured: await isUserProviderKeyConfigured(environment, userUUID, 'openai'),
            }),
          );
          attemptsAlignment = alignmentKey.configured;
        } catch (error) {
          logger.warn('The OpenAI key status could not be read; the alignment will be attempted', {
            newscastID,
            error: error instanceof Error ? error.message : String(error),
          }, { function: 'run' });
        }
      }

      // Step 6 — merge: one durable step per part (design §7-4). Each reads its
      // part's chunk PCM back from KV, concatenates + encodes it ONCE into a part
      // MP3 stored in R2 under ${newscastID}/part-${p}, derives part-LOCAL caption
      // timing (whisper alignment when available, proportional estimate otherwise —
      // an alignment failure NEVER fails the newscast), and returns the finished
      // NewscastPart whose durationMs is the merged PCM's cumulative end.
      // The whole-newscast details.merge stays an aggregate (mp3 bytes summed,
      // aligned OR-ed, words summed) and the 'merge' stage timing spans every part step.
      const uniformSampleRate =
        chunkAudioMetas[0]?.sampleRate ?? FALLBACK_SAMPLE_RATE;
      const parts: NewscastPart[] = [];
      const mergeMetas: Array<{ mp3Bytes: number; aligned: boolean; words?: number }> = [];
      let mergeStartedAt: number | undefined;
      for (let partPosition = 0; partPosition < partChunks.length; partPosition += 1) {
        const partIndex = partPosition + 1;
        const chunks = partChunks[partPosition];
        const partScript = partScripts[partPosition];
        const mergedCheckpoint = mergedCheckpoints[partPosition];
        if (partReusePlans[partPosition].mode === 'merged' && mergedCheckpoint !== null) {
          // §3b-4: this part's MP3 is already in R2 and its caption timings are in
          // the checkpoint — nothing to merge, so it goes straight into `parts`.
          parts.push(mergedCheckpoint.part);
          mergeMetas.push({
            mp3Bytes: mergedCheckpoint.mp3Bytes,
            aligned: mergedCheckpoint.aligned,
            words: mergedCheckpoint.words,
          });
          await updateNewscastStage(
            client,
            newscastID,
            'merge',
            (partPosition + 1) / partChunks.length,
          );
          continue;
        }
        const isFirstPart = partPosition === 0;
        const isLastPart = partPosition === partChunks.length - 1;
        const priorMergeMetas = [...mergeMetas];
        const stageStartedAt = mergeStartedAt;
        const mergedPart = await step.do(
          `merge-part-${partIndex}`,
          MERGE_STEP_OPTIONS,
          async () => {
            const startedAt = Date.now();
            if (isFirstPart) {
              await updateNewscastStage(client, newscastID, 'merge', 0);
              await mergeNewscastDetails(client, newscastID, {
                timings: { merge: { startedAt } },
              });
            }
            const chunkBuffers: Uint8Array[] = [];
            for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
              const stored = await newscastState.get(
                partChunkAudioKey(newscastID, partIndex, chunkIndex),
                'arrayBuffer',
              );
              if (stored === null) {
                throw new Error(
                  `Missing synthesized chunk ${chunkIndex} of part ${partIndex} for newscast ${newscastID}.`,
                );
              }
              chunkBuffers.push(new Uint8Array(stored));
            }

            // Concatenate this part's chunk PCM (EXACT per-chunk timing from byte
            // length) and encode it ONCE into a 128 kbps MP3 stored in R2 under the
            // part key. All chunks share one model, so one sample rate applies.
            const partMerged = mergePcmChunks(chunkBuffers, uniformSampleRate);
            const mp3Bytes = encodePcmToMp3(partMerged.pcm, uniformSampleRate, 1);
            await environment.NEWSCAST_AUDIO.put(`${newscastID}/part-${partIndex}`, mp3Bytes, {
              httpMetadata: { contentType: 'audio/mpeg' },
            });

            // Proportional per-line caption estimate (part-local fallback timings):
            // split each chunk's exact duration across its turns.
            const estimatedSegments: AudioSegment[] = [];
            for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
              const chunkSegment = partMerged.chunkSegments[chunkIndex];
              estimatedSegments.push(
                ...distributeChunkTimings(
                  chunks[chunkIndex],
                  chunkSegment.startMs,
                  chunkSegment.durationMs,
                  estimatedSegments.length,
                ),
              );
            }
            // Exact part duration = last chunk's cumulative end; bounds the aligned
            // timings and becomes NewscastPart.durationMs.
            const lastChunkSegment =
              partMerged.chunkSegments[partMerged.chunkSegments.length - 1];
            const durationMs =
              lastChunkSegment === undefined
                ? 0
                : lastChunkSegment.startMs + lastChunkSegment.durationMs;

            // Prefer REAL caption timings, part-locally: transcribe THIS part's MP3
            // with whisper-1 on the user's OpenAI key and fuzzy-align it to THIS
            // part's script. Starts are relative to the part audio, which is
            // exactly how the web player seeks within a part. Alignment is the one
            // provider call allowed to simply not happen: it is skipped outright
            // when check-alignment-key found no OpenAI key, and an attempt that
            // fails (a key removed since answers `no_key`, and transcribeWords then
            // answers no words) keeps the estimate — it must NEVER fail the newscast.
            let segments = estimatedSegments;
            let didAlign = false;
            if (!attemptsAlignment) {
              logger.info(
                'No OpenAI key for the alignment; using estimated timings',
                { newscastID, part: partIndex },
                { function: 'run' },
              );
            } else {
              try {
                const words = await transcribeWords(mp3Bytes, {
                  transport: createUserKeyTransport(environment, userUUID, 'openai'),
                  language: 'ko',
                });
                const aligned = alignScriptToTranscript(partScript, words, durationMs);
                if (aligned !== null) {
                  segments = aligned;
                  didAlign = true;
                  logger.info(
                    'Part caption timings aligned from transcript',
                    { newscastID, part: partIndex, words: words.length, segments: aligned.length },
                    { function: 'run' },
                  );
                } else {
                  logger.warn(
                    'Part alignment unavailable or low-confidence; using estimated timings',
                    { newscastID, part: partIndex, words: words.length },
                    { function: 'run' },
                  );
                }
              } catch (error) {
                logger.warn(
                  'Part caption alignment failed; using estimated timings',
                  {
                    newscastID,
                    part: partIndex,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  { function: 'run' },
                );
              }
            }

            await updateNewscastStage(
              client,
              newscastID,
              'merge',
              (partPosition + 1) / partChunks.length,
            );

            const alignedWordCount = didAlign
              ? segments.reduce((sum, segment) => sum + (segment.words?.length ?? 0), 0)
              : undefined;

            if (isLastPart) {
              // Aggregate details.merge across all parts (this part + the cached
              // outputs of the earlier ones) and close the stage timing.
              const mp3BytesTotal =
                priorMergeMetas.reduce((sum, meta) => sum + meta.mp3Bytes, 0) +
                mp3Bytes.byteLength;
              const aligned =
                priorMergeMetas.some((meta) => meta.aligned) || didAlign;
              const words = sumOptionalCounts([
                ...priorMergeMetas.map((meta) => meta.words),
                alignedWordCount,
              ]);
              const startedAtForStage = isFirstPart ? startedAt : stageStartedAt;
              const finishedAt = Date.now();
              await mergeNewscastDetails(client, newscastID, {
                merge: { mp3Bytes: mp3BytesTotal, aligned, words },
                timings: {
                  merge: {
                    finishedAt,
                    durationMs:
                      startedAtForStage === undefined
                        ? undefined
                        : finishedAt - startedAtForStage,
                  },
                },
              });
            }

            const part: NewscastPart = {
              index: partIndex,
              audioKey: `${newscastID}/part-${partIndex}`,
              script: partScript,
              segments,
              durationMs,
            };
            return {
              part,
              mp3Bytes: mp3Bytes.byteLength,
              aligned: didAlign,
              words: alignedWordCount,
              stageStartedAt: isFirstPart ? startedAt : undefined,
            };
          },
        );
        if (isFirstPart) {
          mergeStartedAt = mergedPart.stageStartedAt;
        }
        mergeMetas.push({
          mp3Bytes: mergedPart.mp3Bytes,
          aligned: mergedPart.aligned,
          words: mergedPart.words,
        });
        parts.push(mergedPart.part);
        await writeCheckpoint(newscastState, checkpoints.mergedPart(partIndex), {
          part: mergedPart.part,
          mp3Bytes: mergedPart.mp3Bytes,
          aligned: mergedPart.aligned,
          words: mergedPart.words,
        } satisfies MergedPartCheckpoint);
      }
      // Same posture as the script aggregate: close details.merge out here when the
      // LAST part was reused (its step never ran) and some other part ran live.
      const lastMergeMode = partReusePlans[partChunks.length - 1]?.mode ?? 'live';
      if (lastMergeMode === 'merged' && partReusePlans.some((one) => one.mode !== 'merged')) {
        await mergeNewscastDetails(client, newscastID, {
          merge: {
            mp3Bytes: mergeMetas.reduce((sum, meta) => sum + meta.mp3Bytes, 0),
            aligned: mergeMetas.some((meta) => meta.aligned),
            words: sumOptionalCounts(mergeMetas.map((meta) => meta.words)),
          },
        });
      }

      // Step 7 — finalize: assemble the NewscastResult and complete the newscast
      // (design §3/§7-5). parts[] is authoritative and always present; the
      // top-level script/segments/audioKey stay populated for legacy readers (the
      // aggregate script, part 1's segments, and part 1's audio key). partsSummary
      // is the per-part rollup. Every part chunk KV key is cleaned up last — the
      // encoded MP3s are already durable in R2.
      await step.do('finalize', MERGE_STEP_OPTIONS, async () => {
        const firstPart = parts[0];
        const result: NewscastResult = {
          sources: articles,
          script: parts.flatMap((part) => part.script),
          segments: firstPart?.segments ?? [],
          audioKey: firstPart?.audioKey ?? `${newscastID}/part-1`,
          parts,
          // Advertise the sting key ONLY when it was actually generated (design
          // §15); the web reads its presence to decide whether to wire the
          // player's between-parts transition slot.
          ...(signalGenerated ? { signalAudioKey: `${newscastID}/signal` } : {}),
        };
        const partsSummary = parts.map((part) => ({
          index: part.index,
          turns: part.script.length,
          characters: part.script.reduce((sum, line) => sum + line.text.length, 0),
          audioDurationMs: part.durationMs,
        }));
        await mergeNewscastDetails(client, newscastID, { partsSummary });
        await markNewscastDone(client, newscastID, result);

        for (
          let partPosition = 0;
          partPosition < partChunks.length;
          partPosition += 1
        ) {
          const partIndex = partPosition + 1;
          // A part reused straight from its merge checkpoint has no in-memory chunk
          // list, so its (still-present) chunk count comes from the TTS checkpoint —
          // otherwise a resumed newscast would leak the earlier run's chunk PCM.
          const chunkTotal =
            partChunks[partPosition].length > 0
              ? partChunks[partPosition].length
              : (ttsCheckpoints[partPosition]?.chunks.length ?? 0);
          for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex += 1) {
            await newscastState.delete(
              partChunkAudioKey(newscastID, partIndex, chunkIndex),
            );
          }
        }
        // A finished newscast can never be resumed, so its checkpoints are dead
        // weight (design §3a) — drop the whole `chk/` prefix.
        await deleteNewscastCheckpoints(newscastState, newscastID, checkpoints);
        return { parts: parts.length };
      });

      logger.info('Newscast workflow done', { newscastID }, { function: 'run' });
    } catch (error) {
      failure = error;
      const message = error instanceof Error ? error.message : String(error);
      // Put the actual cause IN the log message (not just the generic label), so
      // the root cause is directly visible/queryable in observability instead of
      // requiring a second lookup of the newscast's stored error.
      logger.error(`Newscast workflow failed: ${message}`, error, {
        function: 'run',
        metadata: { newscastID, cause: message },
      });
      // Record the failure durably so `GET /newscasts/:id` surfaces it. The CODE is
      // classified from the error object (never the message text), so the web can
      // branch on `blocked_no_key` → "register your key" without parsing a
      // provider error string (design §1.3/§5.4).
      const errorCode = classifyJobErrorCode(error);
      try {
        await step.do('record-error', RECORD_ERROR_STEP_OPTIONS, async () => {
          await markNewscastError(client, newscastID, message, errorCode);
          return { recorded: true };
        });
      } catch (recordError) {
        logger.error('The newscast failure could not be recorded', recordError, {
          function: 'run',
          metadata: { newscastID },
        });
      }
    }

    // Step — report-stage-run (design §1): done or failed, this newscast is
    // finished, so read every newscast of the stage run and tell the scheduler
    // where the stage run stands. A report that cannot be sent after the step's
    // retries changes nothing about this newscast: the stage run is then settled
    // by the next newscast's report, or by the scheduler's own timeout.
    try {
      await step.do('report-stage-run', RECORD_ERROR_STEP_OPTIONS, async () => {
        const report = await reportStageRun(environment, client, stageRunID);
        return { report: report.kind };
      });
    } catch (error) {
      logger.error('The stage run could not be reported', error, {
        function: 'run',
        metadata: { newscastID, stageRunID },
      });
    }

    if (failure !== undefined) {
      // Re-throw so the Workflow instance itself terminates as errored.
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
  }
}
