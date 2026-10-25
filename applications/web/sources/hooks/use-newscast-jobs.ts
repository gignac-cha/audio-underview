/**
 * Newscast data layer — the "list is the universe" model.
 *
 * - {@link useNewscastJobs}: the recent newscasts, read every 2s while any of them is
 *   running, and while the page says a run that makes newscasts is still in progress
 *   (its newscasts do not exist yet when the form is answered).
 * - {@link useNewscastJobDetail}: one selected newscast, read every 1s until it
 *   reaches a terminal status. Drives the detail pane for running, done, and
 *   failed newscasts alike — there is no separate "live" path.
 *
 * Newscasts are made by the scheduler (the newscast task group), never by this
 * worker, so nothing here creates one.
 */

import { useQuery } from '@tanstack/react-query';
import { loadAuthenticationData } from '@audio-underview/sign-provider';
import type { JobStatus, NewscastJobSummary } from '@audio-underview/newscast-core';
import {
  getNewscastWorkerURL,
  hasAccessToken,
  requestNewscastWorkerJSON,
} from './newscast-request.ts';

/** Read interval of the newscast LIST while at least one newscast is running. */
export const LIST_REFRESH_INTERVAL_MILLISECONDS = 2000;

/** Read interval of the selected newscast's DETAIL while it is running. */
const DETAIL_REFRESH_INTERVAL_MILLISECONDS = 1000;

export const NEWSCASTS_QUERY_KEY = ['newscasts'] as const;

export function newscastKey(jobID: string | undefined) {
  return [...NEWSCASTS_QUERY_KEY, jobID ?? ''] as const;
}

export function mediaTokenKey(jobID: string | undefined) {
  return [...newscastKey(jobID), 'media-token'] as const;
}

function unreadableResponseError() {
  return new Error('The server sent a response this page cannot read.');
}

/** A minted media token and the instant it stops being usable. */
interface HeldMediaToken {
  value: string;
  expiresAtMilliseconds: number;
}

/**
 * The media token currently held for each newscast ID — the ONLY credential that
 * ever goes into an audio URL.
 *
 * It lives in a module map rather than in React state because the URL builders
 * below are called during RENDER by components that cannot await anything. The
 * token is put here by {@link useMediaToken}, whose query re-renders those
 * components when a token arrives, so the URL they build next carries it.
 */
const mediaTokensByJobID = new Map<string, HeldMediaToken>();

/**
 * Media URLs already handed out, keyed by their bare (token-less) form.
 *
 * A `<audio src>` that CHANGES makes the browser drop what it buffered and
 * restart the track, so a token refresh must not rewrite a URL that is already
 * playing. Each built URL is therefore frozen until its own token is nearly
 * spent; only then does a rebuild pick up the newer token. A part that starts
 * after a refresh gets the fresh token straight away. The floating player
 * additionally holds the URL of the part it is playing, so this freeze is the
 * second line of defence, for callers that rebuild URLs every render.
 */
const issuedMediaURLs = new Map<string, { url: string; frozenUntilMilliseconds: number }>();

/**
 * How long before a media token's expiry a URL built from it stops being reused.
 * Wide enough that a URL handed to `<audio>` is never seconds from dying.
 */
const MEDIA_URL_FREEZE_MARGIN_MILLISECONDS = 60_000;

/** Drop every cached media token and built URL (sign-out, and test isolation). */
export function clearMediaTokens(): void {
  mediaTokensByJobID.clear();
  issuedMediaURLs.clear();
}

/**
 * Append this newscast's MEDIA token to a media URL as `?token=`.
 *
 * A browser `<audio src>` cannot carry an `Authorization` header, so the audio
 * route also reads `?token=` — but what rides there is never the session
 * credential. That credential authorizes every route and a URL leaks into browser
 * history, `Referer`, and the worker's invocation logs; the media token is minted
 * per newscast, expires within the hour, and unlocks nothing but that newscast's
 * audio.
 *
 * With no token yet (or signed out), this returns the bare URL instead of
 * throwing or blocking: these builders run during RENDER, so a missing token must
 * degrade to "the audio 401s until the token lands" rather than take the page down.
 */
function withMediaToken(url: string, jobID: string): string {
  if (loadAuthenticationData() === null) {
    return url;
  }
  const mediaToken = mediaTokensByJobID.get(jobID);
  if (mediaToken === undefined) {
    return url;
  }
  const nowMilliseconds = Date.now();
  const issued = issuedMediaURLs.get(url);
  if (issued !== undefined && issued.frozenUntilMilliseconds > nowMilliseconds) {
    return issued.url;
  }
  const separator = url.includes('?') ? '&' : '?';
  const built = `${url}${separator}token=${encodeURIComponent(mediaToken.value)}`;
  issuedMediaURLs.set(url, {
    url: built,
    frozenUntilMilliseconds: mediaToken.expiresAtMilliseconds - MEDIA_URL_FREEZE_MARGIN_MILLISECONDS,
  });
  return built;
}

export function newscastsEndpoint(): string {
  return `${getNewscastWorkerURL()}/newscasts`;
}

/**
 * Absolute URL of a newscast's audio without a part, which the worker answers with
 * part 1. The floating player only falls back to it for a result without `parts`.
 */
export function audioURLForJob(jobID: string): string {
  return withMediaToken(`${newscastsEndpoint()}/${jobID}/audio`, jobID);
}

/**
 * Absolute URL of ONE part's MP3 for multi-part playback — the floating player
 * points its single `<audio>` at this per current part. The worker's audio route
 * resolves `?part=N` to the R2 key `${newscastID}/part-${N}`.
 */
export function audioURLForJobPart(jobID: string, partIndex: number): string {
  return withMediaToken(`${newscastsEndpoint()}/${jobID}/audio?part=${partIndex}`, jobID);
}

/**
 * Absolute URL of a newscast's transition sting — the signal sound the floating
 * player plays between parts. The worker's audio route resolves `?part=signal` to
 * the R2 key `${newscastID}/signal`. Only meaningful when the result carries
 * `signalAudioKey`.
 */
export function signalAudioURLForJob(jobID: string): string {
  return withMediaToken(`${newscastsEndpoint()}/${jobID}/audio?part=signal`, jobID);
}

async function fetchRecentJobs(): Promise<NewscastJobSummary[]> {
  // The list is scoped SERVER-side to the credential's subject, so this returns the
  // signed-in user's newscasts.
  const body = await requestNewscastWorkerJSON('/newscasts');
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw unreadableResponseError();
  }
  return data as NewscastJobSummary[];
}

export async function fetchJobStatus(jobID: string): Promise<JobStatus> {
  return await requestNewscastWorkerJSON(`/newscasts/${jobID}`) as JobStatus;
}

interface NewscastListOptions {
  refreshIntervalMilliseconds?: number;
}

/**
 * The recent newscasts. Read again while any newscast is running so every row's
 * progress strip stays live; pauses entirely once the list is settled.
 */
export function useNewscastJobs(options: NewscastListOptions = {}) {
  const refreshIntervalMilliseconds = options.refreshIntervalMilliseconds ?? LIST_REFRESH_INTERVAL_MILLISECONDS;

  const query = useQuery<NewscastJobSummary[], Error>({
    queryKey: NEWSCASTS_QUERY_KEY,
    queryFn: fetchRecentJobs,
    enabled: hasAccessToken(),
    refetchInterval: (activeQuery) => {
      const jobs = activeQuery.state.data;
      const anyRunning = jobs !== undefined && jobs.some((job) => job.status === 'running');
      return anyRunning ? refreshIntervalMilliseconds : false;
    },
  });

  return {
    jobs: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error ?? undefined,
  };
}

/** The 200 body of `POST /newscasts/:id/media-token`. */
export interface MediaTokenResponse {
  token: string;
  /** Seconds the token stays valid, straight from the worker. */
  expiresIn: number;
}

/**
 * A media token is refreshed at HALF its lifetime, so whatever token a URL is
 * built from still has at least half a lifetime ahead of it — 30 minutes on the
 * worker's one-hour tokens, longer than any single part of a newscast. That
 * matters because the floating player holds a part's URL for as long as the
 * part plays (a changed `<audio>` src restarts the track from 0:00, the
 * "rewinds mid-part" bug), so the token inside a held URL must not expire
 * underneath it. Half-life is also far wider than
 * {@link MEDIA_URL_FREEZE_MARGIN_MILLISECONDS}, so a frozen URL is only ever rebuilt
 * on a token that is already in hand.
 */
const MEDIA_TOKEN_REFRESH_FRACTION = 0.5;

/** Floor on the refresh interval so a tiny/absent `expiresIn` cannot spin the query. */
const MINIMUM_MEDIA_TOKEN_REFRESH_MILLISECONDS = 30_000;

async function fetchMediaToken(jobID: string): Promise<MediaTokenResponse> {
  const body = await requestNewscastWorkerJSON(`/newscasts/${jobID}/media-token`, { method: 'POST' }) as MediaTokenResponse;
  if (typeof body?.token !== 'string' || typeof body.expiresIn !== 'number') {
    throw unreadableResponseError();
  }
  // Publish it for the synchronous URL builders; this query's own re-render is
  // what makes the components that call them pick the new URL up.
  mediaTokensByJobID.set(jobID, {
    value: body.token,
    expiresAtMilliseconds: Date.now() + body.expiresIn * 1000,
  });
  return body;
}

/** Refresh delay for a token that lives `expiresIn` seconds. */
function mediaTokenRefreshIntervalMilliseconds(expiresIn: number | undefined): number {
  if (expiresIn === undefined) {
    return MINIMUM_MEDIA_TOKEN_REFRESH_MILLISECONDS;
  }
  return Math.max(
    expiresIn * 1000 * MEDIA_TOKEN_REFRESH_FRACTION,
    MINIMUM_MEDIA_TOKEN_REFRESH_MILLISECONDS,
  );
}

/**
 * Keep a valid media token cached for one newscast, refreshed at half its
 * lifetime so a long listening session never falls off the end of its token.
 *
 * Deliberately fire-and-forget: nothing here is rendered, and a failure only
 * means the audio URLs stay bare (the worker answers 401) — never that the page
 * breaks. Retries are off for the same reason a poll would be wrong: the next
 * scheduled refresh is the retry.
 */
function useMediaToken(jobID: string | undefined): void {
  useQuery<MediaTokenResponse, Error>({
    queryKey: mediaTokenKey(jobID),
    queryFn: () => fetchMediaToken(jobID as string),
    enabled: jobID !== undefined && hasAccessToken(),
    retry: false,
    refetchInterval: (activeQuery) =>
      mediaTokenRefreshIntervalMilliseconds(activeQuery.state.data?.expiresIn),
    staleTime: MINIMUM_MEDIA_TOKEN_REFRESH_MILLISECONDS,
  });
}

/**
 * Whether a newscast can be played: it is done and has parts. Every newscast of
 * the worker stores its audio as parts, so there is no whole-newscast audio to
 * fall back to.
 */
export function isPlayable(status: JobStatus | undefined): boolean {
  return status?.status === 'done' && (status.result?.parts?.length ?? 0) > 0;
}

/**
 * One selected newscast's full status, read until terminal. `audioURL` is only set
 * once the newscast is playable (its part MP3s exist from that point on).
 *
 * It also keeps this newscast's media token warm ({@link useMediaToken}), which is
 * what lets the synchronous audio-URL builders carry a credential at all — the
 * page mounts this hook for both the SELECTED and the PLAYING newscast, so the
 * floating player's per-part and signal URLs are covered by the playing one's token.
 */
export function useNewscastJobDetail(jobID: string | undefined) {
  useMediaToken(jobID);

  const query = useQuery<JobStatus, Error>({
    queryKey: newscastKey(jobID),
    queryFn: () => fetchJobStatus(jobID as string),
    enabled: jobID !== undefined && hasAccessToken(),
    refetchInterval: (activeQuery) => {
      const status = activeQuery.state.data;
      if (status !== undefined && (status.status === 'done' || status.status === 'error')) {
        return false;
      }
      return DETAIL_REFRESH_INTERVAL_MILLISECONDS;
    },
  });

  const status = query.data;
  return {
    status,
    audioURL: jobID !== undefined && isPlayable(status) ? audioURLForJob(jobID) : undefined,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
  };
}
