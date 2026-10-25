/**
 * Public share permalinks.
 *
 * One `newscast_shares` row is one LIVE capability URL for one COMPLETED newscast:
 * whoever holds `token` may read that newscast's public projection and stream its
 * audio with no session at all. The link is a live reference, never a snapshot —
 * a newscast that is no longer `done` stops showing, and deleting the newscast (or
 * the share row) makes it 404.
 *
 * TWO ACCESS PATHS, deliberately separated in this file:
 *
 * 1. The OWNER path ({@link sharesForUser}): every statement carries
 *    `user_uuid = eq.<owner>`, so a request handler cannot touch a share row it
 *    does not own even if it forgets to check first.
 * 2. The PUBLIC path ({@link readShareByToken} / {@link readSharedNewscast} /
 *    {@link readSharedNewscastStatus}) is unscoped ON PURPOSE — the token IS the
 *    authorization, and there is no caller identity to scope by. Everything it
 *    returns goes through {@link toPublicShareView}, which builds the wire shape
 *    from an ALLOWLIST rather than by removing fields from the owner projection.
 *    That direction is the whole point: a public projection that starts from the
 *    owner's `JobStatus` and deletes keys leaks the NEXT field somebody adds.
 *
 * NOTHING here ever reads `newscasts.user_uuid`, `error`, `error_code`, `stage`,
 * `audioKey`, the newscast's voices, or an article's `content`, and of `request`
 * and `details` only the fields the view names. The DTO builders below are the
 * only writers of the public shape, and `tests/shares.test.ts` pins their key lists.
 */

import type {
  AudioSegment,
  JobDetails,
  NewscastPart,
  NewscastResult,
  ScriptLine,
  SpeakerId,
  WordTiming,
} from '@audio-underview/newscast-core';
import type { SupabaseClient } from '@audio-underview/supabase-connector';

/** Maximum characters kept from the shared-by display name snapshot. */
const MAXIMUM_DISPLAY_NAME_LENGTH = 100;

/** Maximum characters kept from the shared-by email snapshot (RFC 5321 path limit). */
const MAXIMUM_EMAIL_LENGTH = 254;

/**
 * Upper bound on a share token accepted from a URL. Tokens are
 * `crypto.randomUUID()` (36 characters); anything longer is junk and is refused
 * before it reaches the database so a giant path segment is never a query.
 */
const MAXIMUM_SHARE_TOKEN_LENGTH = 100;

/**
 * Title shown when a shared newscast has neither a user override nor a source
 * title. The public view always has a title — a headerless viewer page would look
 * broken — and this one reveals nothing about the newscast.
 */
export const FALLBACK_SHARE_TITLE = '뉴스캐스트';

/**
 * The opt-in public metadata flags, as stored in `newscast_shares.included_metadata`.
 * Everything is private by default: an ABSENT key means "not shared", which is
 * why the two profile fields are optional strings rather than a flag plus a
 * lookup — the worker cannot resolve a name or an email (the session JWT carries
 * the user's UUID and nothing else), so the sharer's client sends the value it is
 * showing them and this is a SNAPSHOT of it.
 */
export interface ShareIncludedMetadata {
  /** Sharer's display name, snapshotted at share time. Absent = not shared. */
  displayName?: string;
  /** Sharer's email, snapshotted at share time. Absent = not shared. */
  email?: string;
  /** Publish the script provider / model / effort set. */
  showModel?: boolean;
  /** Publish the source articles' titles and links. */
  showSourceLinks?: boolean;
  /** Publish the newscast's creation timestamp. */
  showCreatedAt?: boolean;
}

/** One word's timing inside a shared line (public projection of {@link WordTiming}). */
export interface PublicShareWordTiming {
  text: string;
  startMs: number;
  endMs: number;
}

/** One line's timing inside a shared part (public projection of {@link AudioSegment}). */
export interface PublicShareSegment {
  index: number;
  startMs: number;
  durationMs: number;
  words?: PublicShareWordTiming[];
}

/** One dialogue line of a shared newscast (public projection of {@link ScriptLine}). */
export interface PublicShareScriptLine {
  speaker: SpeakerId;
  text: string;
}

/**
 * One part of a shared newscast. `audioKey` is deliberately NOT here: it embeds
 * the newscast id, and the viewer never needs it — audio is fetched as
 * `GET /share/:token/audio?part=N`.
 */
export interface PublicSharePart {
  index: number;
  durationMs: number;
  script: PublicShareScriptLine[];
  segments: PublicShareSegment[];
}

/** The opt-in metadata block; `{}` when the sharer published nothing. */
export interface PublicShareMetadata {
  sharedBy?: { displayName?: string; email?: string };
  model?: { provider?: string; model?: string; effort?: string };
  sources?: Array<{ title: string; originalUrl: string; discussionUrl: string }>;
  createdAt?: string;
}

/**
 * The ENTIRE public wire shape of a shared newscast — the only thing
 * `GET /share/:token` may answer with.
 */
export interface PublicShareView {
  version: 1;
  title: string;
  parts: PublicSharePart[];
  hasSignalAudio: boolean;
  metadata: PublicShareMetadata;
}

/**
 * The `newscasts` columns the public path reads. Spelled out (like the select
 * list below) so a column added later is never served by accident: `user_uuid`,
 * `error`, `error_code` and `stage` are not here, and cannot be. `request`,
 * `result` and `details` are JSONB, so they arrive parsed — but still untrusted.
 */
export interface SharedNewscastRow {
  status: string;
  request: unknown;
  result: unknown;
  details: unknown;
  title_override: string | null;
  created_at: string;
}

/** A live share link, as the owner routes report it. */
export interface NewscastShare {
  token: string;
  newscastID: string;
  metadata: ShareIncludedMetadata;
}

/** First 8 characters of a token — the ONLY fragment allowed into a log line. */
export function shareTokenPrefix(token: string): string {
  return token.slice(0, 8);
}

/**
 * Is this a token shape worth a database round trip? Length-bounded; the real
 * check is the lookup itself.
 */
function isPlausibleShareToken(token: string): boolean {
  return token.length > 0 && token.length <= MAXIMUM_SHARE_TOKEN_LENGTH;
}

/** Trim, drop empties, and cap one snapshot string; `undefined` = not shared. */
function parseSnapshotString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, maximumLength);
}

/**
 * Narrow an arbitrary value — a request body, or a JSON value read back out of
 * the database — to {@link ShareIncludedMetadata}.
 *
 * An ALLOWLIST in both directions: an unknown key is dropped on the way in (so a
 * client cannot invent a flag) and on the way out (so a hand-edited row cannot
 * introduce one). A flag is kept only when it is literally `true`, and a profile
 * string only when it is a non-blank string, so "all toggles off" stores `{}` and
 * publishes `metadata: {}`.
 */
export function parseIncludedMetadata(value: unknown): ShareIncludedMetadata {
  if (value === null || typeof value !== 'object') {
    return {};
  }
  const candidate = value as Record<string, unknown>;
  const metadata: ShareIncludedMetadata = {};
  const displayName = parseSnapshotString(candidate.displayName, MAXIMUM_DISPLAY_NAME_LENGTH);
  if (displayName !== undefined) {
    metadata.displayName = displayName;
  }
  const email = parseSnapshotString(candidate.email, MAXIMUM_EMAIL_LENGTH);
  if (email !== undefined) {
    metadata.email = email;
  }
  if (candidate.showModel === true) {
    metadata.showModel = true;
  }
  if (candidate.showSourceLinks === true) {
    metadata.showSourceLinks = true;
  }
  if (candidate.showCreatedAt === true) {
    metadata.showCreatedAt = true;
  }
  return metadata;
}

/** A stored JSON object, or `undefined` for anything else. */
function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A stored `details` value; anything that is not an object means `{}`. */
function parseNewscastDetails(details: unknown): JobDetails {
  return (toRecord(details) as JobDetails | undefined) ?? {};
}

/** A stored `result` value; `null` when absent or not an object. */
function parseResult(result: unknown): NewscastResult | null {
  return (toRecord(result) as NewscastResult | undefined) ?? null;
}

/** A finite number, or `fallback` — a stored NaN/undefined must not reach the wire. */
function toFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A string, or `''` — the public shape has no optional text fields to leave out. */
function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `value` when it is an array, else an empty one (a malformed row renders empty). */
function toArray<Item>(value: unknown): Item[] {
  return Array.isArray(value) ? (value as Item[]) : [];
}

function toPublicScriptLine(line: ScriptLine): PublicShareScriptLine {
  return { speaker: line?.speaker === 2 ? 2 : 1, text: toText(line?.text) };
}

function toPublicWordTiming(word: WordTiming): PublicShareWordTiming {
  return {
    text: toText(word?.text),
    startMs: toFiniteNumber(word?.startMs),
    endMs: toFiniteNumber(word?.endMs),
  };
}

function toPublicSegment(segment: AudioSegment): PublicShareSegment {
  const publicSegment: PublicShareSegment = {
    index: toFiniteNumber(segment?.index),
    startMs: toFiniteNumber(segment?.startMs),
    durationMs: toFiniteNumber(segment?.durationMs),
  };
  if (Array.isArray(segment?.words)) {
    publicSegment.words = segment.words.map(toPublicWordTiming);
  }
  return publicSegment;
}

/** Longest `startMs + durationMs` across segments — the fallback part duration. */
function durationFromSegments(segments: PublicShareSegment[]): number {
  return segments.reduce(
    (longest, segment) => Math.max(longest, segment.startMs + segment.durationMs),
    0,
  );
}

/**
 * The parts a viewer plays, ALWAYS as a non-empty list of parts.
 *
 * A result without `parts` — only the top-level `script` / `segments` /
 * `audioKey` trio of the `NewscastResult` legacy-reader contract — is normalized
 * here into a single part 1, whose audio `?part=1` serves (`${id}/part-1`, where
 * the audio stage stores part 1 of every newscast). That normalization is what
 * lets the viewer have exactly one playback path.
 */
function toPublicParts(result: NewscastResult): PublicSharePart[] {
  const storedParts = toArray<NewscastPart>(result.parts);
  if (storedParts.length > 0) {
    return storedParts.map((part, position) => {
      const segments = toArray<AudioSegment>(part?.segments).map(toPublicSegment);
      return {
        index: toFiniteNumber(part?.index, position + 1),
        durationMs: toFiniteNumber(part?.durationMs, durationFromSegments(segments)),
        script: toArray<ScriptLine>(part?.script).map(toPublicScriptLine),
        segments,
      };
    });
  }
  const segments = toArray<AudioSegment>(result.segments).map(toPublicSegment);
  return [
    {
      index: 1,
      durationMs: durationFromSegments(segments),
      script: toArray<ScriptLine>(result.script).map(toPublicScriptLine),
      segments,
    },
  ];
}

/**
 * The shared newscast's title: the owner's override first (it exists precisely to
 * fix a bad derived title), then the first source article's title, then a neutral
 * fallback.
 */
function resolveShareTitle(titleOverride: string | null, result: NewscastResult): string {
  const override = typeof titleOverride === 'string' ? titleOverride.trim() : '';
  if (override.length > 0) {
    return override;
  }
  const sourceTitle = toText(toArray<{ title?: unknown }>(result.sources)[0]?.title).trim();
  return sourceTitle.length > 0 ? sourceTitle : FALLBACK_SHARE_TITLE;
}

/**
 * Render a `YYYY-MM-DD HH:MM:SS` (UTC) timestamp as an ISO instant so the viewer
 * can format it in the reader's own timezone without guessing. Anything that is
 * not that exact shape (a Postgres `timestamptz` already is an instant) is passed
 * through untouched.
 */
function toIsoTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}.000Z`
    : value;
}

/**
 * Assemble the opt-in metadata block — the ONLY place a newscast field becomes
 * public because a flag was set.
 *
 * Each branch names the exact fields it copies. `sources` in particular copies
 * three fields and leaves `content`, `geeknewsSummary` and `hackerNewsComments`
 * (the whole crawled article, including a pasted article's body) behind; the
 * model block copies `provider`, `model` and `effort` out of the newscast's
 * `request` (the settings it was made with, or the `details.request` snapshot of
 * the prototype's shape) and never its source or its voices.
 */
function toPublicMetadata(
  row: SharedNewscastRow,
  details: JobDetails,
  result: NewscastResult,
  included: ShareIncludedMetadata,
): PublicShareMetadata {
  const metadata: PublicShareMetadata = {};

  const sharedBy: { displayName?: string; email?: string } = {};
  if (included.displayName !== undefined) {
    sharedBy.displayName = included.displayName;
  }
  if (included.email !== undefined) {
    sharedBy.email = included.email;
  }
  if (Object.keys(sharedBy).length > 0) {
    metadata.sharedBy = sharedBy;
  }

  if (included.showModel === true) {
    const request = toRecord(row.request) ?? toRecord(details.request);
    const model: { provider?: string; model?: string; effort?: string } = {};
    if (typeof request?.provider === 'string') {
      model.provider = request.provider;
    }
    if (typeof request?.model === 'string') {
      model.model = request.model;
    }
    if (typeof request?.effort === 'string') {
      model.effort = request.effort;
    }
    if (Object.keys(model).length > 0) {
      metadata.model = model;
    }
  }

  if (included.showSourceLinks === true) {
    const sources = toArray<{ title?: unknown; originalUrl?: unknown; discussionUrl?: unknown }>(
      result.sources,
    ).map((source) => ({
      title: toText(source?.title),
      originalUrl: toText(source?.originalUrl),
      discussionUrl: toText(source?.discussionUrl),
    }));
    if (sources.length > 0) {
      metadata.sources = sources;
    }
  }

  if (included.showCreatedAt === true) {
    metadata.createdAt = toIsoTimestamp(row.created_at);
  }

  return metadata;
}

/**
 * Build the public view of a shared newscast, or `null` when there is nothing to
 * show — the newscast is not `done` (it is running, or it failed), or its stored
 * result is missing.
 *
 * `null` is answered with the SAME 404 as an unknown token, so a visitor can
 * never tell a revoked link from a running newscast from one that never existed.
 */
export function toPublicShareView(
  row: SharedNewscastRow,
  included: ShareIncludedMetadata,
): PublicShareView | null {
  if (row.status !== 'done') {
    return null;
  }
  const result = parseResult(row.result);
  if (result === null) {
    return null;
  }
  const details = parseNewscastDetails(row.details);
  return {
    version: 1,
    title: resolveShareTitle(row.title_override, result),
    parts: toPublicParts(result),
    hasSignalAudio: typeof result.signalAudioKey === 'string' && result.signalAudioKey.length > 0,
    metadata: toPublicMetadata(row, details, result, included),
  };
}

// ---------------------------------------------------------------------------
// Storage — the PUBLIC (token-scoped) path
// ---------------------------------------------------------------------------

/** Columns a share read selects; `user_uuid` is not among them (nothing needs it). */
const SHARE_COLUMNS = 'token,newscast_id,included_metadata';

interface ShareRow {
  token: string;
  newscast_id: string;
  included_metadata: unknown;
}

function toNewscastShare(row: ShareRow): NewscastShare {
  return {
    token: row.token,
    newscastID: row.newscast_id,
    metadata: parseIncludedMetadata(row.included_metadata),
  };
}

/**
 * Resolve a share token to its newscast, or `null` when the token is unknown —
 * which is also what a REVOKED token is, because revoking deletes the row.
 *
 * Unscoped by design: the token is the capability. It is never logged whole (see
 * {@link shareTokenPrefix}), and neither is an error that might quote it.
 */
export async function readShareByToken(
  client: SupabaseClient,
  token: string,
): Promise<NewscastShare | null> {
  if (!isPlausibleShareToken(token)) {
    return null;
  }
  const { data, error } = await client
    .from('newscast_shares')
    .select(SHARE_COLUMNS)
    .eq('token', token)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read a share link: ${error.message}`);
  }
  return data === null ? null : toNewscastShare(data as ShareRow);
}

/** Columns the public newscast read selects — the complete list. */
const SHARED_NEWSCAST_COLUMNS = 'status,request,result,details,title_override,created_at';

/**
 * Read the columns a public view is built from, or `null` when the newscast is
 * gone (a deleted newscast's link 404s — the share is a live reference).
 */
export async function readSharedNewscast(
  client: SupabaseClient,
  newscastID: string,
): Promise<SharedNewscastRow | null> {
  const { data, error } = await client
    .from('newscasts')
    .select(SHARED_NEWSCAST_COLUMNS)
    .eq('id', newscastID)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read a shared newscast: ${error.message}`);
  }
  return (data as SharedNewscastRow | null) ?? null;
}

/**
 * The cheapest possible "is this newscast still shareable?" probe — one column,
 * no payload. The audio route runs it on EVERY request rather than trusting the
 * share row alone, so a newscast that is no longer `done` stops streaming at once,
 * exactly like the JSON view's `no-store` policy.
 */
export async function readSharedNewscastStatus(
  client: SupabaseClient,
  newscastID: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('newscasts')
    .select('status')
    .eq('id', newscastID)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read a shared newscast: ${error.message}`);
  }
  return data === null ? null : (data as { status: string }).status;
}

// ---------------------------------------------------------------------------
// Storage — the OWNER path (every statement carries `user_uuid = eq.<owner>`)
// ---------------------------------------------------------------------------

/**
 * Every share statement a REQUEST HANDLER may run, pinned to one owner, so "did
 * this query filter by user?" is answered once, here.
 */
export interface UserShareStore {
  /** This newscast's live link, or `null` (no link, unknown newscast, or not theirs). */
  read(newscastID: string): Promise<NewscastShare | null>;
  /**
   * Create the link, replace its token (`regenerate`), or just update the
   * published metadata. `null` means the row could not be written because it
   * belongs to somebody else.
   */
  put(
    newscastID: string,
    metadata: ShareIncludedMetadata,
    regenerate: boolean,
  ): Promise<NewscastShare | null>;
  /** Revoke the link. Idempotent; `false` = there was nothing to revoke. */
  remove(newscastID: string): Promise<boolean>;
}

/** The Postgres code of a UNIQUE or PRIMARY KEY violation. */
const UNIQUE_VIOLATION = '23505';

async function readShareByNewscast(
  client: SupabaseClient,
  newscastID: string,
  userUUID: string,
): Promise<NewscastShare | null> {
  const { data, error } = await client
    .from('newscast_shares')
    .select(SHARE_COLUMNS)
    .eq('newscast_id', newscastID)
    .eq('user_uuid', userUUID)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read a share link: ${error.message}`);
  }
  return data === null ? null : toNewscastShare(data as ShareRow);
}

/**
 * Create / re-issue / re-configure one newscast's link.
 *
 * `newscast_id` is UNIQUE — one live link per newscast. Re-issuing overwrites
 * `token` in the one row, so the previous token stops resolving the instant the
 * statement commits, with no window in which two tokens are live for one
 * newscast. Every write is scoped to the owner, and a first insert that collides
 * with a row of somebody else (the UNIQUE `newscast_id`) is reported as `null`
 * rather than handing back a token that resolves to nothing.
 */
async function putShare(
  client: SupabaseClient,
  newscastID: string,
  userUUID: string,
  metadata: ShareIncludedMetadata,
  regenerate: boolean,
): Promise<NewscastShare | null> {
  const existing = await readShareByNewscast(client, newscastID, userUUID);
  if (existing !== null && !regenerate) {
    const { error } = await client
      .from('newscast_shares')
      .update({ included_metadata: metadata })
      .eq('newscast_id', newscastID)
      .eq('user_uuid', userUUID);
    if (error) {
      throw new Error(`Failed to update a share link: ${error.message}`);
    }
    return { token: existing.token, newscastID, metadata };
  }

  const token = crypto.randomUUID();
  if (existing !== null) {
    const { data, error } = await client
      .from('newscast_shares')
      .update({ token, included_metadata: metadata, created_at: new Date().toISOString() })
      .eq('newscast_id', newscastID)
      .eq('user_uuid', userUUID)
      .select('token');
    if (error) {
      throw new Error(`Failed to re-issue a share link: ${error.message}`);
    }
    return (data ?? []).length === 0 ? null : { token, newscastID, metadata };
  }

  const { error } = await client
    .from('newscast_shares')
    .insert({ token, newscast_id: newscastID, user_uuid: userUUID, included_metadata: metadata });
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return null;
    }
    throw new Error(`Failed to create a share link: ${error.message}`);
  }
  return { token, newscastID, metadata };
}

/** Build the {@link UserShareStore} for one verified user UUID. */
export function sharesForUser(client: SupabaseClient, userUUID: string): UserShareStore {
  return {
    read: (newscastID) => readShareByNewscast(client, newscastID, userUUID),
    put: (newscastID, metadata, regenerate) =>
      putShare(client, newscastID, userUUID, metadata, regenerate),
    remove: async (newscastID) => {
      const { data, error } = await client
        .from('newscast_shares')
        .delete()
        .eq('newscast_id', newscastID)
        .eq('user_uuid', userUUID)
        .select('token');
      if (error) {
        throw new Error(`Failed to revoke a share link: ${error.message}`);
      }
      return (data ?? []).length > 0;
    },
  };
}
