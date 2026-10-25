/**
 * Concatenate per-line MP3 buffers into one MP3 stream (no ffmpeg) and compute
 * per-line timing.
 *
 * MPEG audio frames are self-contained, so concatenating the raw frame bytes of
 * each line yields a single playable MP3. Any ID3v2 metadata tag that Google
 * TTS might prepend is stripped from every buffer except the first, since a tag
 * in the middle of the stream is not valid frame data. Timings are derived from
 * the decoded frame durations (see `estimateMp3DurationMs`), independent of the
 * byte layout, so each line's caption can be highlighted during playback.
 */

import type { AudioSegment } from '@audio-underview/newscast-core';
import { estimateMp3DurationMs, id3v2Length } from './mp3-duration.ts';

export interface MergedAudio {
  /** All line MP3s concatenated into one MP3 stream. */
  bytes: Uint8Array;
  /** One segment per input buffer, in order, with cumulative startMs. */
  segments: AudioSegment[];
}

/**
 * Return the buffer with any leading ID3v2 tag removed. When no tag is present
 * the original buffer is returned unchanged.
 */
function stripLeadingId3v2Tag(buffer: Uint8Array): Uint8Array {
  const tagLength = id3v2Length(buffer);
  return tagLength > 0 ? buffer.subarray(tagLength) : buffer;
}

/**
 * Merge per-line MP3 buffers into a single MP3 and compute per-line timing.
 *
 * - The first buffer is kept intact (its ID3v2 tag, if any, leads the stream);
 *   every later buffer has its ID3v2 tag stripped before concatenation.
 * - `segments[i]` covers `lineBuffers[i]`: `index = i`, `startMs` = the sum of
 *   all prior line durations, `durationMs = estimateMp3DurationMs(buffer)`.
 */
export function mergeLineAudio(lineBuffers: Uint8Array[]): MergedAudio {
  const prepared = lineBuffers.map((buffer, index) =>
    index === 0 ? buffer : stripLeadingId3v2Tag(buffer),
  );

  const totalLength = prepared.reduce((sum, buffer) => sum + buffer.length, 0);
  const bytes = new Uint8Array(totalLength);
  const segments: AudioSegment[] = [];

  let byteOffset = 0;
  let startMs = 0;
  for (let index = 0; index < prepared.length; index += 1) {
    const buffer = prepared[index];
    bytes.set(buffer, byteOffset);
    byteOffset += buffer.length;

    const durationMs = estimateMp3DurationMs(buffer);
    segments.push({ index, startMs, durationMs });
    startMs += durationMs;
  }

  return { bytes, segments };
}
