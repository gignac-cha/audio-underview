/**
 * Supabase persistence for newscasts (migration 016).
 *
 * The `newscasts` row is the single source of truth for a newscast's live
 * progress. Every unit of pipeline work updates the row so the web page can poll
 * `GET /newscasts/:id` and observe stage / progress changes, and the task group
 * reads the rows of one stage run to report to the scheduler.
 *
 * The row shape is a superset of the frozen `JobStatus` contract from
 * `@audio-underview/newscast-core`; {@link rowToOwnerJobStatus} maps it back to
 * the exact wire shape. `request`, `details` and `result` are JSONB whose names
 * are the core's camelCase.
 *
 * OWNERSHIP. Every read a REQUEST HANDLER makes goes through one of the
 * `...ForUser` functions, which pin `user_uuid` into the filter, so "someone
 * else's newscast" and "no such newscast" are indistinguishable (404, never 403).
 * The unscoped writers below (`updateNewscastStage` / `markNewscastDone` /
 * `markNewscastError` / `mergeNewscastDetails`) are for the WORKFLOW, which is
 * already running on behalf of the newscast it was created for and has no
 * request to authenticate.
 *
 * Every query lists its columns explicitly: a `select('*')` here would hand the
 * client whatever column is added next.
 */

import type {
  JobDetails,
  JobErrorCode,
  JobRunStatus,
  JobStatus,
  NewscastJobSummary,
  NewscastResult,
  NewscastStage,
  StageTiming,
} from '@audio-underview/newscast-core';
import {
  parseJobErrorCode,
  redactAndTruncate,
} from '@audio-underview/newscast-core';
import { createSupabaseClient, type SupabaseClient } from '@audio-underview/supabase-connector';
import type { Environment, NewscastRequest } from './environment.ts';

// The summary shape is a shared wire contract; re-exported so worker-local
// callers keep importing it from here.
export type { NewscastJobSummary };

/**
 * Base `overallProgress` for each stage (dynamic-parts design doc §7-7).
 * Six working stages, each worth 1/6 of the overall bar; `done` is 1.0. The
 * `organize` stage added between `crawl-articles` and `script` is what turned the
 * old five-way 0.20 split into this six-way 1/6 split.
 */
const STAGE_OVERALL_BASE: Record<NewscastStage, number> = {
  'crawl-list': 0 / 6,
  'crawl-articles': 1 / 6,
  organize: 2 / 6,
  script: 3 / 6,
  tts: 4 / 6,
  merge: 5 / 6,
  done: 1.0,
};

/** Weight of a single working stage within the overall progress bar. */
const STAGE_WEIGHT = 1 / 6;

/**
 * Character cap for the `error` column, matching the one `buildFailureDetails`
 * puts on `details.failure.message` — the two carry the SAME text (the thrown
 * stage error), so treating them differently would just mean the leakier of the
 * pair sets the real limit.
 */
const NEWSCAST_ERROR_MAXIMUM_LENGTH = 2_000;

/** A newscast id is a UUID; anything else is answered as "no such newscast" without a query. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compute `overallProgress` (0..1, clamped) from the active stage and its
 * in-stage progress: `base[stage] + (1/6) * stageProgress`.
 */
export function computeOverallProgress(
  stage: NewscastStage,
  stageProgress: number,
): number {
  const overall = STAGE_OVERALL_BASE[stage] + STAGE_WEIGHT * stageProgress;
  return Math.min(1, Math.max(0, overall));
}

/**
 * Raw `newscasts` row as stored. The JSONB columns arrive parsed but untrusted, so
 * they are `unknown` here and narrowed by the mappers below.
 */
export type NewscastRow = {
  id: string;
  user_uuid: string;
  stage_run_id: string | null;
  source_index: number;
  status: JobRunStatus;
  stage: string;
  stage_progress: number;
  overall_progress: number;
  title: string | null;
  title_override: string | null;
  request: unknown;
  details: unknown;
  result: unknown;
  error: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

/** What the task group inserts for each source of a stage run. */
export type NewscastInsert = {
  user_uuid: string;
  stage_run_id: string;
  source_index: number;
  status: JobRunStatus;
  stage: NewscastStage;
  stage_progress: number;
  overall_progress: number;
  title: string | null;
  request: NewscastRequest;
  details: JobDetails;
};

/**
 * The `newscasts` table in the Supabase generic schema shape. The connector's
 * `Database` type does not describe it, so the queries here read the table
 * through this type instead.
 */
export type NewscastDatabase = {
  public: {
    Tables: {
      newscasts: {
        Row: NewscastRow;
        Insert: NewscastInsert;
        Update: Partial<Omit<NewscastRow, 'id' | 'user_uuid' | 'created_at'>>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};

/** Every column, for the reads that hand the whole row on. */
const NEWSCAST_COLUMNS =
  'id,user_uuid,stage_run_id,source_index,status,stage,stage_progress,overall_progress,title,title_override,request,details,result,error,error_code,created_at,updated_at';

/**
 * The columns a status read selects. `user_uuid` is deliberately NOT here: the
 * caller had to prove ownership to reach the row, so echoing the owner back adds
 * nothing and only risks leaking it into a client-side cache or a screenshot.
 */
const JOB_STATUS_COLUMNS =
  'id,status,stage,stage_progress,overall_progress,title_override,request,details,result,error,error_code';

/** The columns the history list selects (no result payload, no error text). */
const JOB_SUMMARY_COLUMNS = 'id,status,stage,overall_progress,title,title_override,created_at';

/** A client for this worker's environment, on the schema of the environment. */
export function createNewscastSupabaseClient(
  environment: Pick<Environment, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'SUPABASE_SCHEMA'>,
): SupabaseClient {
  return createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    schema: environment.SUPABASE_SCHEMA,
  });
}

/** The `newscasts` table, typed by {@link NewscastDatabase}. */
function newscastsTable(client: SupabaseClient) {
  return (client as unknown as SupabaseClient<NewscastDatabase>).from('newscasts');
}

/**
 * Narrow a stored `details` value into {@link JobDetails}. Defensive: a
 * NULL/absent/non-object `details` maps to `{}`.
 */
function parseJobDetails(details: unknown): JobDetails {
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    return details as JobDetails;
  }
  return {};
}

/**
 * Insert one `running` row per source of a stage run, then read every row of the
 * stage run back, in source order.
 *
 * Idempotent: `(stage_run_id, source_index)` is unique, and a row that already
 * exists is left exactly as it is (`ignoreDuplicates`). A repeated start of the
 * same stage run therefore makes no second row, and reads back the rows — with
 * their ids and their stored requests, voices included — the first start made.
 */
export async function insertNewscastsOfStageRun(
  client: SupabaseClient,
  stageRunID: string,
  rows: NewscastInsert[],
): Promise<NewscastRow[]> {
  const { error } = await newscastsTable(client).upsert(rows, {
    onConflict: 'stage_run_id,source_index',
    ignoreDuplicates: true,
  });
  if (error) {
    throw new Error(`Failed to insert newscasts: ${error.message}`);
  }
  return listNewscastsOfStageRun(client, stageRunID);
}

/** Every newscast of one stage run, in source order. */
export async function listNewscastsOfStageRun(
  client: SupabaseClient,
  stageRunID: string,
): Promise<NewscastRow[]> {
  const { data, error } = await newscastsTable(client)
    .select(NEWSCAST_COLUMNS)
    .eq('stage_run_id', stageRunID)
    .order('source_index', { ascending: true });
  if (error) {
    throw new Error(`Failed to list the newscasts of a stage run: ${error.message}`);
  }
  return (data ?? []) as NewscastRow[];
}

/**
 * Read the current `details`, deep-merge `patch` into it, and write it back.
 * Top-level keys are shallow-merged (a provided key REPLACES the stored one),
 * except `timings`, which is merged per-stage so each stage's timing accumulates
 * (e.g. a `startedAt`-only patch then a `finishedAt`/`durationMs` patch combine).
 *
 * Defensive: a NULL/absent/invalid `details` is treated as `{}`, so a patch always
 * lands on a well-formed object. The workflow is the only writer of a newscast's
 * `details` and writes them one at a time, so the read-modify-write does not race.
 */
export async function mergeNewscastDetails(
  client: SupabaseClient,
  id: string,
  patch: Partial<JobDetails>,
): Promise<void> {
  const { data, error } = await newscastsTable(client)
    .select('details')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read newscast details: ${error.message}`);
  }
  if (data === null) {
    return;
  }
  const current = parseJobDetails((data as { details: unknown }).details);

  const merged: JobDetails = { ...current, ...patch };
  if (patch.timings !== undefined) {
    const mergedTimings: Partial<Record<NewscastStage, StageTiming>> = {
      ...(current.timings ?? {}),
    };
    for (const [stage, timing] of Object.entries(patch.timings) as Array<
      [NewscastStage, StageTiming]
    >) {
      mergedTimings[stage] = { ...(mergedTimings[stage] ?? {}), ...timing };
    }
    merged.timings = mergedTimings;
  }

  const { error: updateError } = await newscastsTable(client)
    .update({ details: merged, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updateError) {
    throw new Error(`Failed to update newscast details: ${updateError.message}`);
  }
}

/**
 * Update a running newscast's active stage and progress. `overallProgress` is
 * derived from the stage + stageProgress so callers only report local progress.
 */
export async function updateNewscastStage(
  client: SupabaseClient,
  id: string,
  stage: NewscastStage,
  stageProgress: number,
): Promise<void> {
  const { error } = await newscastsTable(client)
    .update({
      stage,
      stage_progress: stageProgress,
      overall_progress: computeOverallProgress(stage, stageProgress),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) {
    throw new Error(`Failed to update the newscast stage: ${error.message}`);
  }
}

/**
 * Mark a newscast complete: store the {@link NewscastResult}, move to the
 * terminal `done` stage, and fill the progress bars.
 */
export async function markNewscastDone(
  client: SupabaseClient,
  id: string,
  result: NewscastResult,
): Promise<void> {
  const { error } = await newscastsTable(client)
    .update({
      status: 'done',
      stage: 'done',
      stage_progress: 1,
      overall_progress: 1,
      result,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) {
    throw new Error(`Failed to mark the newscast done: ${error.message}`);
  }
}

/**
 * Mark a running newscast failed: record the error message and its safe code, and
 * stop. The stage/progress are left at wherever the pipeline reached so the
 * failure point stays observable. A newscast that is no longer running is left as
 * it is: a late error must not turn a finished newscast into a failed one.
 *
 * The message is credential-masked and capped HERE, at the write (design §1.3).
 * It is the same thrown stage error `details.failure.message` records, and a 401
 * body routinely quotes the caller's own key back — an unmasked, unbounded copy in
 * the `error` column would have made the masking on the `details` twin pointless.
 *
 * `errorCode` is the SAFE classification the web branches on (`blocked_no_key`
 * sends the user to key registration instead of showing a provider error). It has
 * a column of its own, written in the same update as the status, so a poller that
 * sees `status: 'error'` always has the classification with it.
 */
export async function markNewscastError(
  client: SupabaseClient,
  id: string,
  message: string,
  errorCode?: JobErrorCode,
): Promise<void> {
  const { error } = await newscastsTable(client)
    .update({
      status: 'error',
      error: redactAndTruncate(message, NEWSCAST_ERROR_MAXIMUM_LENGTH),
      error_code: errorCode ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'running');
  if (error) {
    throw new Error(`Failed to mark the newscast failed: ${error.message}`);
  }
}

/** The columns {@link rowToOwnerJobStatus} reads. */
export type NewscastStatusRow = Pick<
  NewscastRow,
  | 'id'
  | 'status'
  | 'stage'
  | 'stage_progress'
  | 'overall_progress'
  | 'title_override'
  | 'request'
  | 'details'
  | 'result'
  | 'error'
  | 'error_code'
>;

/**
 * Map a row to the {@link JobStatus} wire shape returned to the newscast's OWNER —
 * the only shape there is. Every route resolves the row through a `...ForUser`
 * read and answers 404 to everyone else, so the ownership predicate IS the
 * boundary.
 *
 * `details` is the row's `details` with two columns folded back into the core
 * shape the web reads: the `request` column as `details.request`, and the
 * `title_override` column as `details.titleOverride`.
 *
 * `errorCode` rides along as the SAFE classification of a failure, while `error` /
 * `details` carry the provider's own words — masked and capped at the write
 * (`markNewscastError` / `buildFailureDetails`), never here.
 *
 * `user_uuid` is never mapped: the caller had to prove ownership to reach the row,
 * so echoing the owner back adds nothing and only risks leaking it.
 */
export function rowToOwnerJobStatus(row: NewscastStatusRow): JobStatus {
  const status: JobStatus = {
    id: row.id,
    stage: row.stage as NewscastStage,
    stageProgress: row.stage_progress,
    overallProgress: row.overall_progress,
    status: row.status,
  };
  if (status.status === 'error') {
    // The stored code is narrowed rather than cast: a value written by a
    // different deployment (or hand-edited) must degrade to the generic bucket,
    // never reach the web as a branch it has no UI for.
    status.errorCode = parseJobErrorCode(row.error_code) ?? 'pipeline_failed';
  }
  if (row.result !== null && typeof row.result === 'object') {
    status.result = row.result as NewscastResult;
  }
  if (row.error !== null && row.error.length > 0) {
    status.error = row.error;
  }
  const details: JobDetails = { ...parseJobDetails(row.details) };
  if (row.request !== null && typeof row.request === 'object' && !Array.isArray(row.request)) {
    details.request = row.request as NewscastRequest;
  }
  const titleOverride = titleFromOverride(row.title_override);
  if (titleOverride !== null) {
    details.titleOverride = titleOverride;
  }
  if (Object.keys(details).length > 0) {
    status.details = details;
  }
  return status;
}

/** Columns selected for the history list (avoids pulling the whole row). */
export type NewscastSummaryRow = Pick<
  NewscastRow,
  'id' | 'status' | 'stage' | 'overall_progress' | 'title' | 'title_override' | 'created_at'
>;

/**
 * A trimmed `title_override`, or `null` when absent/blank. A blank stored value is
 * treated the same as absent so it never masks a real title.
 */
function titleFromOverride(titleOverride: string | null): string | null {
  const trimmed = titleOverride?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

/**
 * The title a newscast shows. Priority:
 * 1. `title_override` — a user-edited correction (`POST .../title`). ALWAYS wins,
 *    because it exists specifically to fix a bad derived title (e.g. a pasted
 *    article's first line standing in as its title).
 * 2. `title` — the source's title, written when the row is created.
 * 3. `null` when neither is available.
 */
export function resolveNewscastTitle(
  row: Pick<NewscastRow, 'title' | 'title_override'>,
): string | null {
  return titleFromOverride(row.title_override) ?? row.title ?? null;
}

/** Map a summary row to the shared {@link NewscastJobSummary} wire shape. */
export function rowToJobSummary(row: NewscastSummaryRow): NewscastJobSummary {
  return {
    id: row.id,
    status: row.status,
    stage: row.stage as NewscastStage,
    overallProgress: row.overall_progress,
    createdAt: row.created_at,
    title: resolveNewscastTitle(row),
  };
}

/**
 * List ONE user's most recent newscasts (newest first, at most `limit`) as history
 * summaries. Used by `GET /newscasts`.
 */
export async function listNewscastsForUser(
  client: SupabaseClient,
  userUUID: string,
  limit: number,
): Promise<NewscastJobSummary[]> {
  const { data, error } = await newscastsTable(client)
    .select(JOB_SUMMARY_COLUMNS)
    .eq('user_uuid', userUUID)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`Failed to list newscasts: ${error.message}`);
  }
  return ((data ?? []) as NewscastSummaryRow[]).map(rowToJobSummary);
}

/**
 * Read a newscast OWNED BY `userUUID` and map it to the owner `JobStatus` wire
 * shape, or `null` when the id is unknown OR belongs to somebody else — the two
 * cases are deliberately identical so a stranger's probe cannot confirm that a
 * newscast id exists (404, never 403).
 */
export async function getNewscastForUser(
  client: SupabaseClient,
  userUUID: string,
  id: string,
): Promise<JobStatus | null> {
  if (!UUID_PATTERN.test(id)) {
    return null;
  }
  const { data, error } = await newscastsTable(client)
    .select(JOB_STATUS_COLUMNS)
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to get the newscast: ${error.message}`);
  }
  return data === null ? null : rowToOwnerJobStatus(data as NewscastStatusRow);
}

/**
 * Does a newscast exist AND belong to `userUUID`? The same ownership filter as the
 * reads above, selecting the id alone: the audio route asks this on every Range
 * request, which must not pull the request, details and result JSON for a yes/no.
 */
export async function newscastExistsForUser(
  client: SupabaseClient,
  userUUID: string,
  id: string,
): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) {
    return false;
  }
  const { data, error } = await newscastsTable(client)
    .select('id')
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to get the newscast: ${error.message}`);
  }
  return data !== null;
}

/**
 * The whole row of a newscast OWNED BY `userUUID`, or `null` (unknown OR not
 * theirs). For routes that need a column the wire shape does not carry.
 */
export async function getNewscastRowForUser(
  client: SupabaseClient,
  userUUID: string,
  id: string,
): Promise<NewscastRow | null> {
  if (!UUID_PATTERN.test(id)) {
    return null;
  }
  const { data, error } = await newscastsTable(client)
    .select(NEWSCAST_COLUMNS)
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to get the newscast: ${error.message}`);
  }
  return (data as NewscastRow | null) ?? null;
}

/**
 * Record a user-edited display title on one of this user's newscasts.
 * Display-only: it never feeds back into prompts, checkpoints, or the stored
 * result. Validating the title is the route's job.
 *
 * @returns whether the newscast exists and is this user's
 */
export async function setNewscastTitleForUser(
  client: SupabaseClient,
  userUUID: string,
  id: string,
  title: string,
): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) {
    return false;
  }
  const { data, error } = await newscastsTable(client)
    .update({ title_override: title, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_uuid', userUUID)
    .select('id');
  if (error) {
    throw new Error(`Failed to set the newscast title: ${error.message}`);
  }
  return (data ?? []).length > 0;
}
