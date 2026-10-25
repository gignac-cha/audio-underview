/**
 * The viewer's entire server surface: one JSON read and two audio URLs, all
 * addressed by the share token already present in the page URL.
 *
 * There is no session, no credential, and no media token — the token IS the
 * capability, and the worker re-checks it on every single request (including
 * each audio range request), so a revoked link stops working immediately.
 */

import type { PublicShareView } from '../schemas/public-share-view.ts';

/** Base origin of the newscast pipeline worker, without a trailing slash. */
export function newscastWorkerOrigin(): string {
  const configured = import.meta.env.VITE_NEWSCAST_WORKER_URL ?? '';
  return configured.replace(/\/+$/, '');
}

export function shareViewUrl(token: string): string {
  return `${newscastWorkerOrigin()}/share/${encodeURIComponent(token)}`;
}

/** MP3 stream of one part (`partIndex` is the 1-based part number). */
export function sharePartAudioUrl(token: string, partIndex: number): string {
  return `${shareViewUrl(token)}/audio?part=${partIndex}`;
}

/** MP3 stream of the between-parts transition sting. */
export function shareSignalAudioUrl(token: string): string {
  return `${shareViewUrl(token)}/audio?part=signal`;
}

/**
 * Raised when the worker answers 404 — which it does BOTH for an unknown token
 * and for a job that is no longer `done`. The two are deliberately
 * indistinguishable, so the viewer shows one "this link is no longer valid"
 * screen for either.
 */
export class ShareNotFoundError extends Error {
  constructor() {
    super('share-not-found');
    this.name = 'ShareNotFoundError';
  }
}

export async function fetchShareView(
  token: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PublicShareView> {
  const response = await fetchImplementation(shareViewUrl(token), {
    headers: { accept: 'application/json' },
    // The payload is a live projection of a mutable job; a cached copy could
    // outlive a revoked link.
    cache: 'no-store',
  });
  if (response.status === 404) {
    throw new ShareNotFoundError();
  }
  if (!response.ok) {
    throw new Error(`share request failed with status ${response.status}`);
  }
  return (await response.json()) as PublicShareView;
}
