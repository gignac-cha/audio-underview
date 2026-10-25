/**
 * Pure-JavaScript MP3 encoding for the "GeekNews -> 2-host Korean audio
 * newscast" pipeline.
 *
 * The merge step concatenates every dialogue chunk's raw PCM (signed 16-bit
 * little-endian, 24000 Hz mono from the Gemini Developer API TTS) into a single
 * PCM stream. Storing that uncompressed (as WAV) is ~19 MB for a 7-minute
 * newscast. Encoding it to a 128 kbps MP3 instead shrinks the stored/served
 * audio roughly ten-fold with no perceptible quality loss for spoken word.
 *
 * `@breezystack/lamejs` is a maintained, ESM-friendly fork of `lamejs` that runs
 * in the Cloudflare Workers runtime with NO Node built-ins and NO ffmpeg — the
 * original `lamejs@1.2.1` throws `MPEGMode is not defined` under strict ESM /
 * esbuild, so the fork is required for a clean Workers bundle.
 */

import { Mp3Encoder } from '@breezystack/lamejs';

/** Constant-bit-rate target (kbps). 128 kbps is transparent for spoken word. */
const BIT_RATE_KILOBITS_PER_SECOND = 128;

/** lamejs consumes exactly one MPEG frame's worth of samples per call. */
const SAMPLES_PER_FRAME = 1152;

/** Default sample rate — matches the Gemini TTS raw PCM output. */
const DEFAULT_SAMPLE_RATE = 24_000;

/** Default channel count — the newscast is mono. */
const DEFAULT_CHANNELS = 1;

/**
 * Encode raw PCM bytes into a 128 kbps MP3.
 *
 * `pcm` is interpreted as signed 16-bit little-endian samples. For mono the
 * samples feed lamejs directly; for stereo they are treated as interleaved
 * (L, R, L, R, ...) and de-interleaved per frame. The samples are pushed through
 * lamejs in 1152-sample frames, and every `encodeBuffer` output plus the final
 * `flush` is concatenated into the returned MP3 byte stream.
 */
export function encodePcmToMp3(
  pcm: Uint8Array,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
  channels: number = DEFAULT_CHANNELS,
): Uint8Array {
  const samples = readInt16LittleEndian(pcm);
  const encoder = new Mp3Encoder(channels, sampleRate, BIT_RATE_KILOBITS_PER_SECOND);
  const mp3Parts: Uint8Array[] = [];

  if (channels === 2) {
    const left = new Int16Array(SAMPLES_PER_FRAME);
    const right = new Int16Array(SAMPLES_PER_FRAME);
    const frameCount = Math.floor(samples.length / (SAMPLES_PER_FRAME * 2));
    for (let frame = 0; frame < frameCount; frame += 1) {
      const base = frame * SAMPLES_PER_FRAME * 2;
      for (let position = 0; position < SAMPLES_PER_FRAME; position += 1) {
        left[position] = samples[base + position * 2];
        right[position] = samples[base + position * 2 + 1];
      }
      pushEncoded(mp3Parts, encoder.encodeBuffer(left, right));
    }
  } else {
    for (let offset = 0; offset < samples.length; offset += SAMPLES_PER_FRAME) {
      const frame = samples.subarray(offset, offset + SAMPLES_PER_FRAME);
      pushEncoded(mp3Parts, encoder.encodeBuffer(frame));
    }
  }

  pushEncoded(mp3Parts, encoder.flush());
  return concatenate(mp3Parts);
}

/** Collect a non-empty lamejs output frame. */
function pushEncoded(parts: Uint8Array[], encoded: Uint8Array): void {
  if (encoded.length > 0) {
    parts.push(encoded);
  }
}

/**
 * View `pcm` as signed 16-bit little-endian samples. Cloudflare Workers (and
 * Node on x86/ARM) are little-endian, so a direct `Int16Array` view is a correct
 * LE interpretation; the source is copied first only when its byte offset is not
 * 2-byte aligned (a `TypedArray` constructor requirement).
 */
function readInt16LittleEndian(pcm: Uint8Array): Int16Array {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  if (pcm.byteOffset % 2 === 0) {
    return new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
  }
  const aligned = new Uint8Array(sampleCount * 2);
  aligned.set(pcm.subarray(0, sampleCount * 2));
  return new Int16Array(aligned.buffer, 0, sampleCount);
}

/** Concatenate encoded MP3 frames into one contiguous byte stream. */
function concatenate(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const mp3 = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    mp3.set(part, offset);
    offset += part.length;
  }
  return mp3;
}
