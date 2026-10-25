/**
 * The HTTP routes of the newscast worker (its default export).
 *
 * The owner's routes, all behind the main session (see `authentication.ts`) and
 * all ownership-scoped:
 *
 *   GET    /newscasts                  -> 200 { data: NewscastJobSummary[] }, the 20 most recent
 *   GET    /newscasts/:id              -> 200 JobStatus, 404 if unknown
 *   POST   /newscasts/:id/title        -> 200 { id, title }
 *   POST   /newscasts/:id/media-token  -> 200 { token, expiresIn }, the ONLY
 *                                         credential `GET .../audio?token=` accepts
 *   GET    /newscasts/:id/audio?part=N|signal -> 200/206 MP3 bytes (Range supported)
 *   PUT    /newscasts/:id/share        -> 200 { token } (409 unless the newscast is done)
 *   GET    /newscasts/:id/share        -> 200 { shared, token?, metadata? }
 *   DELETE /newscasts/:id/share        -> 200 { removed } (idempotent revoke)
 *   POST   /newscasts/schedulers { source } -> 200 { scheduler_id, form_stage_id, newscast_stage_id, source },
 *                                         the scheduler of a newscast template (see `templates.ts`)
 *
 * plus PUBLIC SHARE PERMALINKS, the only unauthenticated routes in the worker:
 *
 *   GET /share/:token                     -> 200 PublicShareView (allowlisted DTO)
 *   GET /share/:token/audio?part=N|signal -> 200/206 MP3 bytes (Range supported)
 *
 * No route creates a newscast: the scheduler does, through the task group.
 *
 * CORS is `ALLOWED_ORIGINS` on every route, except `/share/*`, which answers
 * `Access-Control-Allow-Origin: *` (credential-free GETs a viewer may read from
 * any origin) plus `X-Robots-Tag: noindex`.
 *
 * OWNERSHIP. The verified subject is the newscast's `user_uuid`, taken from the
 * token and NEVER from the body or the path, and every newscast query is scoped to
 * it. Another user's newscast is answered 404, not 403: 403 would confirm that the
 * id exists.
 *
 * MEDIA CREDENTIALS. A `<audio src>` cannot carry an `Authorization` header, so the
 * audio route also reads `?token=` — but ONLY a media token minted by
 * `POST /newscasts/:id/media-token` and bound to THAT newscast (`media-token.ts`).
 */

import { createWorkerLogger } from '@audio-underview/logger';
import {
  createCORSHeaders,
  errorResponse,
  jsonResponse,
  type ResponseContext,
} from '@audio-underview/worker-tools';
import type { SupabaseClient } from '@audio-underview/supabase-connector';
import { authenticateRequest } from './authentication.ts';
import { issueMediaToken } from './media-token.ts';
import { MAX_AUDIO_PART_INDEX, resolveAudioLookup } from './audio-lookup.ts';
import { serveR2Audio } from './audio-serving.ts';
import type { Environment } from './environment.ts';
import {
  parseIncludedMetadata,
  readShareByToken,
  readSharedNewscast,
  readSharedNewscastStatus,
  shareTokenPrefix,
  sharesForUser,
  toPublicShareView,
  type UserShareStore,
} from './shares.ts';
import {
  createNewscastSupabaseClient,
  getNewscastForUser,
  getNewscastRowForUser,
  listNewscastsForUser,
  newscastExistsForUser,
  setNewscastTitleForUser,
} from './storage.ts';
import { handleCreateNewscastScheduler } from './templates.ts';

const logger = createWorkerLogger({
  defaultContext: { module: 'newscast-worker-http' },
});

/** How many newscasts `GET /newscasts` lists, newest first. */
const NEWSCAST_LIST_LIMIT = 20;

/** Upper bound (after trim) on a `POST /newscasts/:id/title` override. */
const MAX_TITLE_OVERRIDE_LENGTH = 200;

const NEWSCASTS_PATHNAME = '/newscasts';
const NEWSCAST_SCHEDULERS_PATHNAME = '/newscasts/schedulers';
const NEWSCAST_PATTERN = /^\/newscasts\/([^/]+)$/;
const NEWSCAST_TITLE_PATTERN = /^\/newscasts\/([^/]+)\/title$/;
const NEWSCAST_MEDIA_TOKEN_PATTERN = /^\/newscasts\/([^/]+)\/media-token$/;
const NEWSCAST_AUDIO_PATTERN = /^\/newscasts\/([^/]+)\/audio$/;
const NEWSCAST_SHARE_PATTERN = /^\/newscasts\/([^/]+)\/share$/;

/**
 * CORS preflight of the owner routes. `Authorization` MUST be advertised in
 * `Access-Control-Allow-Headers`: the browser sends the preflight WITHOUT the
 * credential and refuses to send the real request unless the header comes back
 * allowed. PUT and DELETE are there for the share routes.
 */
function handleCORSPreflight(request: Request, environment: Environment): Response {
  const origin = request.headers.get('Origin') ?? '';
  const headers = createCORSHeaders(origin, environment.ALLOWED_ORIGINS, logger);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(null, { status: 204, headers });
}

/** The 401 every owner route shares. Says nothing about WHY the credential failed. */
function unauthorizedResponse(context: ResponseContext): Response {
  return errorResponse('unauthorized', 'Valid authentication is required', 401, context);
}

function methodNotAllowed(context: ResponseContext, allow: string): Response {
  const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
  response.headers.set('Allow', allow);
  return response;
}

/** The 404 of a newscast that is unknown OR another user's (indistinguishable on purpose). */
function newscastNotFound(error: string, id: string, context: ResponseContext): Response {
  return errorResponse(error, `Newscast ${id} was not found.`, 404, context);
}

/** Read a JSON body, or `null` when there is none or it is not JSON. */
async function readJSONBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * GET /newscasts — THE CALLER'S recent newscasts (newest first, capped) as
 * history summaries so past newscasts can be browsed and replayed.
 */
async function handleListNewscasts(
  client: SupabaseClient,
  userUUID: string,
  context: ResponseContext,
): Promise<Response> {
  try {
    const summaries = await listNewscastsForUser(client, userUUID, NEWSCAST_LIST_LIMIT);
    return jsonResponse({ data: summaries }, 200, context);
  } catch (error) {
    logger.error('Failed to list newscasts', error, { function: 'handleListNewscasts' });
    return errorResponse('job_list_failed', 'Could not list the newscasts.', 500, context);
  }
}

/**
 * GET /newscasts/:id — the live owner `JobStatus`, or 404 if unknown OR owned by
 * another user.
 */
async function handleGetNewscast(
  client: SupabaseClient,
  userUUID: string,
  id: string,
  context: ResponseContext,
): Promise<Response> {
  const status = await getNewscastForUser(client, userUUID, id);
  if (status === null) {
    return newscastNotFound('not_found', id, context);
  }
  return jsonResponse(status, 200, context);
}

/**
 * POST /newscasts/:id/title — record a user-edited display title so a bad derived
 * title (e.g. a pasted article's first line standing in as its title) can be
 * corrected after the fact.
 *
 * Display-only: the override changes what the list / detail views SHOW but never
 * feeds back into the prompt, checkpoints, or the stored result. Allowed for a
 * newscast in ANY status — running, done, or error — because even a finished
 * newscast's title can be wrong.
 *
 * Answers 400 (missing/blank/too-long `title`), 404 (unknown newscast), else
 * 200 `{ id, title }`.
 */
async function handleUpdateNewscastTitle(
  request: Request,
  client: SupabaseClient,
  userUUID: string,
  id: string,
  context: ResponseContext,
): Promise<Response> {
  const body = await readJSONBody(request);
  const rawTitle =
    body !== null && typeof body === 'object' ? (body as { title?: unknown }).title : undefined;
  if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) {
    return errorResponse('invalid_title', 'title must be a non-empty string.', 400, context);
  }
  const trimmedTitle = rawTitle.trim();
  if (trimmedTitle.length > MAX_TITLE_OVERRIDE_LENGTH) {
    return errorResponse(
      'invalid_title',
      `title must be ${MAX_TITLE_OVERRIDE_LENGTH} characters or fewer.`,
      400,
      context,
    );
  }

  if (!(await setNewscastTitleForUser(client, userUUID, id, trimmedTitle))) {
    return newscastNotFound('job_not_found', id, context);
  }
  return jsonResponse({ id, title: trimmedTitle }, 200, context);
}

/**
 * POST /newscasts/:id/media-token — mint the short-lived, newscast-scoped
 * credential a `<audio src>` may carry in its query string.
 *
 * Authenticated like every other owner route (a real `Authorization` header) and
 * gated on the SAME ownership check as the audio route, so a token only ever
 * exists for a newscast the caller owns. The minted token authorizes nothing but
 * reading THIS newscast's audio, and only for an hour.
 */
async function handleIssueMediaToken(
  client: SupabaseClient,
  environment: Environment,
  userUUID: string,
  id: string,
  context: ResponseContext,
): Promise<Response> {
  if (!(await newscastExistsForUser(client, userUUID, id))) {
    return newscastNotFound('job_not_found', id, context);
  }
  const { token, expiresIn } = await issueMediaToken(userUUID, id, environment.JWT_SECRET);
  return jsonResponse({ token, expiresIn }, 200, context);
}

/**
 * GET /newscasts/:id/audio?part=N|signal — stream one part's audio (or the
 * signal sting), or 404 until the audio stage has stored it.
 *
 * Ownership is checked BEFORE the bucket is touched: the audio is the whole
 * product of a newscast, so leaving it on an unguessable-but-public URL would make
 * every other guard cosmetic. A newscast the caller does not own answers exactly
 * like one that has no audio yet.
 */
async function handleGetAudio(
  request: Request,
  client: SupabaseClient,
  environment: Environment,
  userUUID: string,
  id: string,
  context: ResponseContext,
): Promise<Response> {
  const notReady = (): Response =>
    errorResponse('not_ready', `Audio for newscast ${id} is not ready yet.`, 404, context);

  if (!(await newscastExistsForUser(client, userUUID, id))) {
    return notReady();
  }

  const lookup = resolveAudioLookup(id, new URL(request.url).searchParams.get('part'));
  if (!lookup.valid) {
    return errorResponse(
      'invalid_part',
      `The 'part' query must be 'signal' or a positive integer up to ${MAX_AUDIO_PART_INDEX}.`,
      400,
      context,
    );
  }

  const served = await serveR2Audio(
    environment.NEWSCAST_AUDIO,
    () => createCORSHeaders(context.origin, environment.ALLOWED_ORIGINS, logger),
    lookup.key,
    request.headers.get('Range'),
  );
  return served ?? notReady();
}

// ---------------------------------------------------------------------------
// Public share permalinks
//
// The ONLY unauthenticated routes in this worker. They are carved out by an
// EXACT `/share/` prefix, and the carve-out is the whole security surface of the
// feature, so it is deliberately dumb: one prefix, two GET shapes, no fallthrough
// into anything else.
//
// A share token is a capability — `crypto.randomUUID()`, 122 random bits — so
// there is no session, no media token and no ownership check on these routes.
// What replaces them:
//   * the view is built by an ALLOWLIST (`toPublicShareView`), never by removing
//     fields from the owner projection;
//   * BOTH routes re-read the share row and the newscast's status on EVERY
//     request, so revoking (a DELETE) takes effect immediately;
//   * responses are `no-store` + `X-Robots-Tag: noindex`, and the token never
//     reaches a log line whole (`shareTokenPrefix`).
// ---------------------------------------------------------------------------

/** The carve-out. Exact prefix: `/share` (no slash) is not a share route. */
const SHARE_PATH_PREFIX = '/share/';
const SHARE_VIEW_PATTERN = /^\/share\/([^/]+)$/;
const SHARE_AUDIO_PATTERN = /^\/share\/([^/]+)\/audio$/;

/**
 * Base headers for EVERY public share response, hit or miss.
 *
 * `Access-Control-Allow-Origin: *` is scoped to these routes alone: the requests
 * carry no credential and cannot be given one (no `Allow-Credentials`), so a
 * wildcard here grants a browser exactly what typing the URL already grants.
 * `ALLOWED_ORIGINS` stays untouched, so no authenticated route widens by accident.
 *
 * `X-Robots-Tag: noindex` keeps shared newscasts out of search indexes while
 * leaving OG/link-preview scrapers (which ignore it) working.
 */
function publicShareHeaders(): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Robots-Tag', 'noindex');
  return headers;
}

/** A public JSON body. `no-store` is what makes a revoked link stop rendering. */
function publicShareJsonResponse(data: unknown, status: number): Response {
  const headers = publicShareHeaders();
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * The ONE 404 every public miss answers with — unknown token, revoked token,
 * deleted newscast, a newscast that is not `done` — so a visitor cannot
 * distinguish those cases, and a probe learns nothing from the difference.
 */
function publicShareNotFound(): Response {
  return publicShareJsonResponse(
    {
      error: 'share_not_found',
      error_description: 'This share link is no longer available.',
    },
    404,
  );
}

/** A public 4xx that is the CALLER's mistake (a bad `?part`), not a missing link. */
function publicShareErrorResponse(
  error: string,
  errorDescription: string,
  status: number,
): Response {
  return publicShareJsonResponse({ error, error_description: errorDescription }, status);
}

/**
 * A public 500 for a storage failure (a database that cannot be reached, or one
 * the share migration has not reached yet).
 *
 * Deliberately NOT folded into the 404: "this link is gone" is a permanent answer
 * a viewer shows the visitor and a scraper caches, while an outage is temporary.
 * It reveals nothing either, because it happens for every token equally.
 */
function publicShareUnavailableResponse(error: unknown, route: string): Response {
  // The token is NOT in the log context: an error path is exactly where a
  // credential tends to end up quoted.
  logger.error('A public share route could not read its storage', error, {
    function: route,
  });
  return publicShareErrorResponse(
    'share_unavailable',
    'This share link cannot be read right now.',
    500,
  );
}

/**
 * CORS preflight for `/share/*` only. A viewer's own GETs are simple requests,
 * but a preflight arrives as soon as a client sets a header of its own, and the
 * owner preflight would answer it from `ALLOWED_ORIGINS`.
 */
function publicSharePreflight(): Response {
  const headers = publicShareHeaders();
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Range');
  return new Response(null, { status: 204, headers });
}

/**
 * GET /share/:token — the read-only public view of one shared newscast.
 *
 * Three reads, any of which answers the same 404: the token, the newscast it
 * names, and (inside `toPublicShareView`) the newscast's `done` status. Nothing
 * here is cached, so revoking the link is effective on the visitor's next render.
 */
async function handlePublicShareView(client: SupabaseClient, token: string): Promise<Response> {
  try {
    const share = await readShareByToken(client, token);
    if (share === null) {
      return publicShareNotFound();
    }
    const newscast = await readSharedNewscast(client, share.newscastID);
    if (newscast === null) {
      return publicShareNotFound();
    }
    const view = toPublicShareView(newscast, share.metadata);
    if (view === null) {
      return publicShareNotFound();
    }
    return publicShareJsonResponse(view, 200);
  } catch (error) {
    return publicShareUnavailableResponse(error, 'handlePublicShareView');
  }
}

/**
 * GET /share/:token/audio?part=N|signal — stream one part's MP3.
 *
 * The share token in the URL is the credential, so there is no media token to
 * mint or refresh — but the price of a URL that never expires is that EVERY
 * request re-checks the share row AND the newscast's status before a byte is read
 * from R2. Serving (key resolution, Range) is the owner route's code.
 */
async function handlePublicShareAudio(
  request: Request,
  client: SupabaseClient,
  environment: Environment,
  token: string,
): Promise<Response> {
  let newscastID: string;
  try {
    const share = await readShareByToken(client, token);
    if (share === null) {
      return publicShareNotFound();
    }
    const status = await readSharedNewscastStatus(client, share.newscastID);
    if (status !== 'done') {
      return publicShareNotFound();
    }
    newscastID = share.newscastID;
  } catch (error) {
    return publicShareUnavailableResponse(error, 'handlePublicShareAudio');
  }

  const lookup = resolveAudioLookup(newscastID, new URL(request.url).searchParams.get('part'));
  if (!lookup.valid) {
    return publicShareErrorResponse(
      'invalid_part',
      `The 'part' query must be 'signal' or a positive integer up to ${MAX_AUDIO_PART_INDEX}.`,
      400,
    );
  }

  const served = await serveR2Audio(
    environment.NEWSCAST_AUDIO,
    publicShareHeaders,
    lookup.key,
    request.headers.get('Range'),
  );
  return served ?? publicShareNotFound();
}

/**
 * `decodeURIComponent` that answers `undefined` on a malformed escape instead of
 * throwing, so a bad `%` in an unauthenticated path is a 404, not an exception.
 */
function decodePathSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Everything under `/share/`. Only two GET shapes exist; every other method and
 * path answers the same 404, so the carve-out cannot become a second router.
 */
async function handlePublicShareRoute(
  request: Request,
  environment: Environment,
  pathname: string,
): Promise<Response> {
  if (request.method !== 'GET') {
    return publicShareNotFound();
  }

  const viewMatch = SHARE_VIEW_PATTERN.exec(pathname);
  if (viewMatch !== null) {
    const token = decodePathSegment(viewMatch[1]);
    return token === undefined
      ? publicShareNotFound()
      : handlePublicShareView(createNewscastSupabaseClient(environment), token);
  }

  const audioMatch = SHARE_AUDIO_PATTERN.exec(pathname);
  if (audioMatch !== null) {
    const token = decodePathSegment(audioMatch[1]);
    return token === undefined
      ? publicShareNotFound()
      : handlePublicShareAudio(request, createNewscastSupabaseClient(environment), environment, token);
  }

  return publicShareNotFound();
}

// ---------------------------------------------------------------------------
// Share management — the OWNER's three routes
//
// Ownership-scoped like every other newscast route: an id the caller does not
// own answers 404. The responses carry the TOKEN only — the viewer's origin
// belongs to the web app, so this worker never learns a URL it would then have to
// keep in sync with a deployment.
// ---------------------------------------------------------------------------

/**
 * The owner-side 500 for a share-storage failure. The newscast id is safe to log
 * (it is the caller's own path parameter); a token never is, so none is passed in.
 */
function shareStorageFailure(
  error: unknown,
  route: string,
  newscastID: string,
  context: ResponseContext,
): Response {
  logger.error('A share route could not reach its storage', error, {
    function: route,
    metadata: { newscastID },
  });
  return errorResponse(
    'share_unavailable',
    'Could not read or write the share link for this newscast.',
    500,
    context,
  );
}

/**
 * GET /newscasts/:id/share — is this newscast shared, and with what published?
 * Answers `{ shared: false }` for an un-shared newscast the caller owns, 404 for
 * one they do not.
 */
async function handleGetShare(
  client: SupabaseClient,
  shares: UserShareStore,
  userUUID: string,
  id: string,
  context: ResponseContext,
): Promise<Response> {
  if (!(await newscastExistsForUser(client, userUUID, id))) {
    return newscastNotFound('job_not_found', id, context);
  }
  try {
    const share = await shares.read(id);
    if (share === null) {
      return jsonResponse({ shared: false }, 200, context);
    }
    return jsonResponse({ shared: true, token: share.token, metadata: share.metadata }, 200, context);
  } catch (error) {
    return shareStorageFailure(error, 'handleGetShare', id, context);
  }
}

/**
 * PUT /newscasts/:id/share — create the link, change what it publishes, or
 * (with `regenerate: true`) replace the token so every copy of the old URL dies.
 *
 * Only a `done` newscast can be shared: a link to a running newscast would render
 * nothing and a link to a failed one would publish an error state, so both answer
 * 409 rather than creating a row that resolves to a 404.
 *
 * The body's `metadata` is narrowed by {@link parseIncludedMetadata}, which drops
 * unknown keys — a client cannot invent a flag that publishes something the view
 * builder was never asked about.
 */
async function handlePutShare(
  request: Request,
  client: SupabaseClient,
  shares: UserShareStore,
  userUUID: string,
  id: string,
  context: ResponseContext,
): Promise<Response> {
  const row = await getNewscastRowForUser(client, userUUID, id);
  if (row === null) {
    return newscastNotFound('job_not_found', id, context);
  }
  if (row.status !== 'done') {
    return errorResponse(
      'job_not_shareable',
      `Newscast ${id} is not finished yet (status: ${row.status}).`,
      409,
      context,
    );
  }

  const body = await readJSONBody(request);
  const requestBody =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const regenerate = requestBody.regenerate === true;
  const metadata = parseIncludedMetadata(requestBody.metadata);

  let share: Awaited<ReturnType<UserShareStore['put']>>;
  try {
    share = await shares.put(id, metadata, regenerate);
  } catch (error) {
    return shareStorageFailure(error, 'handlePutShare', id, context);
  }
  if (share === null) {
    // The row exists but belongs to somebody else — only reachable if a newscast
    // changed hands after it was shared. Refused rather than adopted.
    return shareStorageFailure(
      new Error('The share row for this newscast is owned by another user.'),
      'handlePutShare',
      id,
      context,
    );
  }

  // Only the token's PREFIX is ever logged: the whole value is the credential,
  // and invocation logs are not the place to publish one.
  logger.info(
    'Share link written',
    { newscastID: id, tokenPrefix: shareTokenPrefix(share.token), regenerate },
    { function: 'handlePutShare' },
  );
  return jsonResponse({ token: share.token }, 200, context);
}

/**
 * DELETE /newscasts/:id/share — revoke the link (the row is deleted, so the token
 * stops resolving immediately). Idempotent: a newscast with no link answers 200
 * with `removed: false`, because the post-condition the caller asked for holds
 * either way.
 */
async function handleDeleteShare(
  client: SupabaseClient,
  shares: UserShareStore,
  userUUID: string,
  id: string,
  context: ResponseContext,
): Promise<Response> {
  if (!(await newscastExistsForUser(client, userUUID, id))) {
    return newscastNotFound('job_not_found', id, context);
  }
  let removed: boolean;
  try {
    removed = await shares.remove(id);
  } catch (error) {
    return shareStorageFailure(error, 'handleDeleteShare', id, context);
  }
  logger.info('Share link revoked', { newscastID: id, removed }, { function: 'handleDeleteShare' });
  return jsonResponse({ removed }, 200, context);
}

/**
 * Everything under `/newscasts`. Authentication comes first, so a route added here
 * later is authenticated by construction. Only the audio route may take its
 * credential from `?token=`, and only a media token minted for THAT newscast —
 * streaming any other newscast with it is a 401, not a 404: the credential is
 * wrong, not the newscast.
 */
async function routeNewscasts(
  request: Request,
  pathname: string,
  environment: Environment,
  context: ResponseContext,
): Promise<Response> {
  if (!environment.JWT_SECRET) {
    logger.error('JWT_SECRET is not configured', undefined, { function: 'routeNewscasts' });
    return errorResponse('server_error', 'Server configuration error', 500, context);
  }

  const audioMatch = NEWSCAST_AUDIO_PATTERN.exec(pathname);
  const audioNewscastID = request.method === 'GET' && audioMatch !== null ? audioMatch[1] : undefined;
  const user = await authenticateRequest(request, environment.JWT_SECRET, {
    allowQueryToken: audioNewscastID !== undefined,
  });
  if (user === null) {
    return unauthorizedResponse(context);
  }
  if (user.mediaNewscastID !== undefined && user.mediaNewscastID !== audioNewscastID) {
    return unauthorizedResponse(context);
  }
  const { userUUID } = user;
  const client = createNewscastSupabaseClient(environment);

  if (pathname === NEWSCASTS_PATHNAME) {
    if (request.method !== 'GET') {
      return methodNotAllowed(context, 'GET');
    }
    return handleListNewscasts(client, userUUID, context);
  }

  // POST /newscasts/schedulers — ahead of the `:id` routes, which would read "schedulers" as an id
  if (pathname === NEWSCAST_SCHEDULERS_PATHNAME) {
    if (request.method !== 'POST') {
      return methodNotAllowed(context, 'POST');
    }
    // A session always has the header (only the audio route reads a token from the query), which the
    // scheduler gets again unchanged
    const authorization = request.headers.get('Authorization');
    if (authorization === null) {
      return unauthorizedResponse(context);
    }
    return handleCreateNewscastScheduler(
      await readJSONBody(request),
      authorization,
      client,
      environment,
      userUUID,
      context,
    );
  }

  // An `:id` that is not a UUID needs no check here: the storage reads answer it
  // as an unknown newscast without a query.

  // GET /newscasts/:id/audio
  if (audioMatch !== null) {
    if (request.method !== 'GET') {
      return methodNotAllowed(context, 'GET');
    }
    return handleGetAudio(request, client, environment, userUUID, audioMatch[1], context);
  }

  // POST /newscasts/:id/title
  const titleMatch = NEWSCAST_TITLE_PATTERN.exec(pathname);
  if (titleMatch !== null) {
    if (request.method !== 'POST') {
      return methodNotAllowed(context, 'POST');
    }
    return handleUpdateNewscastTitle(request, client, userUUID, titleMatch[1], context);
  }

  // POST /newscasts/:id/media-token
  const mediaTokenMatch = NEWSCAST_MEDIA_TOKEN_PATTERN.exec(pathname);
  if (mediaTokenMatch !== null) {
    if (request.method !== 'POST') {
      return methodNotAllowed(context, 'POST');
    }
    return handleIssueMediaToken(client, environment, userUUID, mediaTokenMatch[1], context);
  }

  // PUT, GET, DELETE /newscasts/:id/share
  const shareMatch = NEWSCAST_SHARE_PATTERN.exec(pathname);
  if (shareMatch !== null) {
    if (request.method !== 'PUT' && request.method !== 'GET' && request.method !== 'DELETE') {
      return methodNotAllowed(context, 'GET, PUT, DELETE');
    }
    const id = shareMatch[1];
    const shares = sharesForUser(client, userUUID);
    if (request.method === 'PUT') {
      return handlePutShare(request, client, shares, userUUID, id, context);
    }
    if (request.method === 'GET') {
      return handleGetShare(client, shares, userUUID, id, context);
    }
    return handleDeleteShare(client, shares, userUUID, id, context);
  }

  // GET /newscasts/:id
  const newscastMatch = NEWSCAST_PATTERN.exec(pathname);
  if (newscastMatch !== null) {
    if (request.method !== 'GET') {
      return methodNotAllowed(context, 'GET');
    }
    return handleGetNewscast(client, userUUID, newscastMatch[1], context);
  }

  return errorResponse('not_found', 'Endpoint not found', 404, context);
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const { pathname } = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';

    if (request.method === 'OPTIONS') {
      // `/share/*` answers its own preflight with the wildcard origin.
      return pathname.startsWith(SHARE_PATH_PREFIX)
        ? publicSharePreflight()
        : handleCORSPreflight(request, environment);
    }

    const context: ResponseContext = {
      origin,
      allowedOrigins: environment.ALLOWED_ORIGINS,
      logger,
    };

    try {
      // THE ONLY CARVE-OUT from authentication: public share permalinks, matched
      // on the exact `/share/` prefix and handled entirely inside
      // `handlePublicShareRoute` — nothing there can fall through into an owner route.
      if (pathname.startsWith(SHARE_PATH_PREFIX)) {
        return await handlePublicShareRoute(request, environment, pathname);
      }

      if (pathname === NEWSCASTS_PATHNAME || pathname.startsWith(`${NEWSCASTS_PATHNAME}/`)) {
        return await routeNewscasts(request, pathname, environment, context);
      }

      return errorResponse('not_found', 'Endpoint not found', 404, context);
    } catch (error) {
      // Not the path: on a share route it holds the whole token
      logger.error('Unhandled worker error', error, { function: 'fetch' });
      return errorResponse('server_error', 'An unexpected error occurred', 500, context);
    }
  },
} satisfies ExportedHandler<Environment>;
