/**
 * Pure playback-timing arithmetic for the share viewer.
 *
 * Everything that maps "where the audio element currently is" onto "which
 * dialogue line and which word are being spoken", and the inverse (a click on a
 * line or a word becomes a seek target), lives here with no React and no DOM so
 * it can be tested against fixtures.
 *
 * The one rule that shapes every signature: `AudioSegment.startMs` and
 * `WordTiming.startMs` are PART-RELATIVE. They are offsets inside the part's own
 * MP3, so a seek that crosses a part boundary is two operations — swap the audio
 * source to the target part, THEN apply the part-relative offset — never a
 * single global timeline seek.
 *
 * Ported from the web app's newscast player (NewscastFloatingPlayer / ScriptCaptions)
 * and reshaped into free functions; the two apps deploy separately, so the code
 * is copied rather than imported across application boundaries.
 */

import type { AudioSegment, ScriptLine } from '@audio-underview/newscast-core';
import type { PublicSharePart } from '../schemas/public-share-view.ts';

/** Sentinel for "no line / no word is currently being spoken". */
export const NO_ACTIVE_INDEX = -1;

/**
 * Index of the segment whose window contains `currentMs`, or
 * {@link NO_ACTIVE_INDEX}. The returned value is `segment.index` (the position
 * of the matching {@link ScriptLine}), not the array position — they normally
 * coincide, but the field is the contract.
 *
 * The window is half-open, `[startMs, startMs + durationMs)`, so the instant a
 * line ends belongs to the next line rather than to both.
 */
export function findActiveLineIndex(segments: AudioSegment[], currentMs: number): number {
  const active = segments.find(
    (segment) =>
      currentMs >= segment.startMs && currentMs < segment.startMs + segment.durationMs,
  );
  return active !== undefined ? active.index : NO_ACTIVE_INDEX;
}

/**
 * Index of the word being spoken inside `segment`, or {@link NO_ACTIVE_INDEX}
 * when the segment carries no word timings (Whisper alignment can fail, and
 * then the viewer degrades to line-level highlighting only) or the playhead
 * sits in a gap between words.
 */
export function findActiveWordIndex(
  segment: AudioSegment | undefined,
  currentMs: number,
): number {
  if (segment?.words === undefined) {
    return NO_ACTIVE_INDEX;
  }
  return segment.words.findIndex(
    (word) => currentMs >= word.startMs && currentMs < word.endMs,
  );
}

/** The segment describing `lineIndex` within a part, if it has timings at all. */
export function findSegmentForLine(
  part: PublicSharePart | undefined,
  lineIndex: number,
): AudioSegment | undefined {
  return part?.segments.find((segment) => segment.index === lineIndex);
}

/**
 * Where a click on `lineIndex` of `partArrayIndex` should move playback.
 *
 * `offsetMilliseconds` is always part-relative, so the caller applies it to the
 * TARGET part's audio element — after switching source when
 * `partArrayIndex` differs from the part currently loaded. A line without
 * timings (or an out-of-range index) falls back to the start of its part rather
 * than refusing to seek, which keeps a partially aligned newscast usable.
 */
export interface LineSeekTarget {
  partArrayIndex: number;
  offsetMilliseconds: number;
}

export function resolveLineSeek(
  parts: PublicSharePart[],
  partArrayIndex: number,
  lineIndex: number,
): LineSeekTarget {
  const clampedPartArrayIndex = Math.min(Math.max(partArrayIndex, 0), Math.max(parts.length - 1, 0));
  const segment = findSegmentForLine(parts[clampedPartArrayIndex], lineIndex);
  return {
    partArrayIndex: clampedPartArrayIndex,
    offsetMilliseconds: segment !== undefined ? segment.startMs : 0,
  };
}

/**
 * Where a click on one WORD should move playback. Word timings are
 * part-relative like segments, so this is the same two-step seek; the word's own
 * `startMs` wins over its line's when it is present.
 */
export function resolveWordSeek(
  parts: PublicSharePart[],
  partArrayIndex: number,
  lineIndex: number,
  wordIndex: number,
): LineSeekTarget {
  const lineTarget = resolveLineSeek(parts, partArrayIndex, lineIndex);
  const word = findSegmentForLine(parts[lineTarget.partArrayIndex], lineIndex)?.words?.[wordIndex];
  if (word === undefined) {
    return lineTarget;
  }
  return { partArrayIndex: lineTarget.partArrayIndex, offsetMilliseconds: word.startMs };
}

/**
 * One dialogue line lifted out of the per-part structure so the transcript can
 * be rendered as one continuous conversation while every entry still knows
 * which part it belongs to (needed for the two-step seek).
 */
export interface FlattenedScriptLine {
  partArrayIndex: number;
  /** 1-based part number as shown to the reader ("2부"). */
  partNumber: number;
  /** Position within THIS part's script — the value seeks are expressed in. */
  lineIndex: number;
  line: ScriptLine;
  /** True on the first line of each part, so the view can draw a divider. */
  startsPart: boolean;
}

/** Every line of every part, in playback order. */
export function flattenScriptLines(parts: PublicSharePart[]): FlattenedScriptLine[] {
  return parts.flatMap((part, partArrayIndex) =>
    part.script.map((line, lineIndex) => ({
      partArrayIndex,
      partNumber: part.index,
      lineIndex,
      line,
      startsPart: lineIndex === 0,
    })),
  );
}

/** Sum of every part's duration, in milliseconds. */
export function totalDurationMilliseconds(parts: PublicSharePart[]): number {
  return parts.reduce((total, part) => total + (part.durationMs ?? 0), 0);
}

/**
 * Elapsed time across the WHOLE newscast: every earlier part in full, plus the
 * playhead inside the current part. Used only for the "elapsed / total" readout;
 * seeking still happens per part.
 */
export function elapsedMillisecondsAcrossParts(
  parts: PublicSharePart[],
  partArrayIndex: number,
  currentPartMilliseconds: number,
): number {
  const precedingMilliseconds = parts
    .slice(0, Math.max(partArrayIndex, 0))
    .reduce((total, part) => total + (part.durationMs ?? 0), 0);
  return precedingMilliseconds + Math.max(currentPartMilliseconds, 0);
}

/**
 * The exact inverse of {@link elapsedMillisecondsAcrossParts}: a position on the
 * WHOLE-newscast timeline becomes the `(part, part-relative offset)` pair the
 * audio element can actually be seeked to.
 *
 * This is what lets the transport show one continuous scrubber over a newscast
 * that is physically several MP3s. Out-of-range input is clamped to the newscast
 * rather than rejected, so a drag past either end lands on a real position.
 *
 * Zero-length parts are skipped rather than swallowing the seek: a part whose
 * duration is 0 can never contain the playhead, so the boundary belongs to the
 * next part that has any audio in it.
 */
export function resolveTimelineSeek(
  parts: PublicSharePart[],
  overallMilliseconds: number,
): LineSeekTarget {
  if (parts.length === 0) {
    return { partArrayIndex: 0, offsetMilliseconds: 0 };
  }
  const clamped = Math.min(
    Math.max(overallMilliseconds, 0),
    totalDurationMilliseconds(parts),
  );
  let remaining = clamped;
  for (let partArrayIndex = 0; partArrayIndex < parts.length - 1; partArrayIndex += 1) {
    const duration = parts[partArrayIndex].durationMs ?? 0;
    if (remaining < duration) {
      return { partArrayIndex, offsetMilliseconds: remaining };
    }
    remaining -= duration;
  }
  return { partArrayIndex: parts.length - 1, offsetMilliseconds: remaining };
}

/**
 * Where each part boundary falls on the unified timeline, as a fraction of the
 * whole (0…1) — the notches drawn over the scrubber. The first part's start is
 * not a boundary, so an n-part newscast yields n-1 fractions and a single-part
 * one yields none.
 */
export function partBoundaryFractions(parts: PublicSharePart[]): number[] {
  const total = totalDurationMilliseconds(parts);
  if (total <= 0) {
    return [];
  }
  const fractions: number[] = [];
  let elapsed = 0;
  for (const part of parts.slice(0, -1)) {
    elapsed += part.durationMs ?? 0;
    fractions.push(elapsed / total);
  }
  return fractions;
}

/**
 * A length in words rather than digits ("8분 42초"), for the byline where the
 * number is prose and not a readout. Seconds are dropped once hours are
 * involved, where they stop being information.
 */
export function formatDurationLabel(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '0초';
  }
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pieces: string[] = [];
  if (hours > 0) {
    pieces.push(`${hours}시간`);
  }
  if (minutes > 0) {
    pieces.push(`${minutes}분`);
  }
  if (seconds > 0 && hours === 0) {
    pieces.push(`${seconds}초`);
  }
  return pieces.length > 0 ? pieces.join(' ') : '0초';
}

/**
 * `m:ss` for the transport row. Non-finite and negative inputs (an audio
 * element reports `NaN` duration until metadata lands) render as `0:00` instead
 * of leaking `NaN:NaN` into the UI.
 */
export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * Caption spotlight brightness (1 = dimmest … 6 = the word being spoken) by
 * distance from the spoken word. Lines that are not the current line render
 * uniformly at level 1.
 */
export function wordLevelForDistance(distance: number): number {
  if (distance === 0) {
    return 6;
  }
  if (distance === 1) {
    return 5;
  }
  if (distance === 2) {
    return 4;
  }
  if (distance === 3) {
    return 3;
  }
  return 2;
}
