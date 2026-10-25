/**
 * The wire contract of the public share endpoint, `GET {worker}/share/:token`
 * (design doc 2026-08-13-public-share-permalink.md §4.1).
 *
 * This is an ALLOWLIST projection assembled server-side — it is deliberately
 * NOT the owner-facing `JobStatus`. Nothing here identifies the owner account,
 * the job, or the R2 keys: no `userId`, no `jobId`, no `audioKey`, no `stage`,
 * no `error`, no raw `details`. The viewer must never expect those fields, and
 * adding one here would be a contract change on the worker side first.
 *
 * The types are re-declared locally (rather than imported from the worker)
 * because the two deploy independently; `ScriptLine` / `AudioSegment` come from
 * newscast-core so the dialogue and timing shapes stay pinned to the one
 * pipeline contract.
 */

import type { AudioSegment, ScriptLine } from '@audio-underview/newscast-core';

/**
 * One playable part of the shared newscast. The worker normalizes legacy
 * single-audio jobs into a one-element `parts` array, so the viewer only ever
 * handles this shape.
 *
 * IMPORTANT: `segments[].startMs` is PART-RELATIVE (offset inside this part's
 * own MP3), not an offset into the whole newscast. Every seek that crosses a
 * part boundary has to switch the audio source first and then apply the
 * part-relative offset.
 */
export interface PublicSharePart {
  /** 1-based part number, as spoken ("1부", "2부"). */
  index: number;
  durationMs: number;
  script: ScriptLine[];
  segments: AudioSegment[];
}

/** The sharer's profile as it stood WHEN THE LINK WAS CREATED (a snapshot). */
export interface PublicShareSharedBy {
  displayName?: string;
  email?: string;
}

/** Which model wrote the script, shown only when the sharer opted in. */
export interface PublicShareModel {
  provider: string;
  model: string;
  effort?: string;
}

/** One source article, trimmed to the three publishable fields. */
export interface PublicShareSource {
  title: string;
  originalUrl: string;
  discussionUrl?: string;
}

/**
 * Everything the sharer explicitly opted into publishing. Every field is
 * optional and the whole object is `{}` when nothing was opted in — the viewer
 * treats "no visible fields" as "render no metadata card at all".
 */
export interface PublicShareMetadata {
  sharedBy?: PublicShareSharedBy;
  model?: PublicShareModel;
  sources?: PublicShareSource[];
  createdAt?: string;
}

export interface PublicShareView {
  version: number;
  title: string;
  parts: PublicSharePart[];
  /** Whether a between-parts transition sting exists (the key stays hidden). */
  hasSignalAudio: boolean;
  metadata: PublicShareMetadata;
}

/**
 * True when the metadata card has at least one thing to show. A `sharedBy`
 * object with no populated string counts as nothing, so an opted-in-then-empty
 * profile does not leave an empty card behind.
 */
export function hasVisibleMetadata(metadata: PublicShareMetadata): boolean {
  const sharedByVisible =
    metadata.sharedBy !== undefined &&
    ((metadata.sharedBy.displayName ?? '') !== '' || (metadata.sharedBy.email ?? '') !== '');
  const sourcesVisible = metadata.sources !== undefined && metadata.sources.length > 0;
  return (
    sharedByVisible ||
    sourcesVisible ||
    metadata.model !== undefined ||
    (metadata.createdAt ?? '') !== ''
  );
}
