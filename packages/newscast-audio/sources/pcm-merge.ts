/**
 * Dependency-free raw-PCM chunk assembly (no ffmpeg, no decoder).
 *
 * The Gemini Developer API TTS path returns raw signed 16-bit LE PCM per dialogue
 * chunk. Because PCM is headerless and uncompressed, concatenating the chunk byte
 * buffers in order yields the full audio, and each chunk's playback duration is
 * EXACT from its byte length: `seconds = byteLength / (sampleRate * channels *
 * bitsPerSample/8)`. The single concatenated PCM buffer is wrapped ONCE into WAV
 * by the caller (see `wrapPcmToWav` in the TTS package).
 */

/** Per-chunk timing within the merged PCM stream. */
export interface PcmChunkSegment {
  /** Zero-based chunk index. */
  index: number;
  /** Playback start offset (ms) of this chunk within the merged stream. */
  startMs: number;
  /** Exact duration (ms) of this chunk's PCM. */
  durationMs: number;
}

export interface MergedPcm {
  /** All chunk PCM buffers concatenated in order. */
  pcm: Uint8Array;
  /** One segment per input chunk, in order, with cumulative startMs. */
  chunkSegments: PcmChunkSegment[];
}

/**
 * Exact duration (ms) of a raw PCM buffer:
 * `byteLength / (sampleRate * channels * bitsPerSample/8) * 1000`.
 */
export function pcmDurationMs(
  byteLength: number,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16,
): number {
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  return bytesPerSecond === 0 ? 0 : (byteLength / bytesPerSecond) * 1000;
}

/**
 * Concatenate per-chunk PCM buffers into one PCM stream and compute exact
 * per-chunk timing. `chunkSegments[i]` covers `chunks[i]`: `index = i`,
 * `startMs` = the sum of all prior chunk durations, `durationMs` = the exact
 * decoded duration of `chunks[i]`. Durations are rounded to whole milliseconds
 * and accumulated so cumulative offsets stay integers.
 */
export function mergePcmChunks(
  chunks: Uint8Array[],
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16,
): MergedPcm {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcm = new Uint8Array(totalLength);
  const chunkSegments: PcmChunkSegment[] = [];

  let byteOffset = 0;
  let startMs = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    pcm.set(chunk, byteOffset);
    byteOffset += chunk.length;

    const durationMs = Math.round(
      pcmDurationMs(chunk.length, sampleRate, channels, bitsPerSample),
    );
    chunkSegments.push({ index, startMs, durationMs });
    startMs += durationMs;
  }

  return { pcm, chunkSegments };
}
