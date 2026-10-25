/**
 * Dependency-free MPEG audio (MP3) duration estimation.
 *
 * The merged newscast audio needs per-line timing for time-synced captions, but
 * we cannot pull in ffmpeg or a decoder. Instead we walk the raw MPEG audio
 * frame headers and sum each frame's playback duration
 * (`samplesPerFrame / sampleRate`). This is exact for constant-bitrate streams
 * and a very close estimate otherwise. A leading ID3v2 tag is skipped so it does
 * not corrupt the frame walk.
 *
 * Frame header reference (32 bits, big-endian):
 *   AAAAAAAA AAABBCCD EEEEFFGH ...
 *   A (11) sync, B (2) MPEG version, C (2) layer, D (1) protection,
 *   E (4) bitrate index, F (2) sample-rate index, G (1) padding, H (1) private.
 */

/** Bitrate tables in kilobits per second, indexed by the 4-bit bitrate field. */
// MPEG Version 1, by layer number (1 = Layer I, 2 = Layer II, 3 = Layer III).
const BITRATES_MPEG1: Record<number, readonly number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
// MPEG Version 2 and 2.5, by layer number.
const BITRATES_MPEG2: Record<number, readonly number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** Sample-rate tables in hertz, indexed by the 2-bit sample-rate field. */
// Keyed by the raw 2-bit MPEG version field: 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5.
const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** Layer number (1/2/3) from the raw 2-bit layer field. */
const LAYER_BY_FIELD: Record<number, number> = { 1: 3, 2: 2, 3: 1 };

interface Mp3FrameInfo {
  /** Total byte length of this frame (header + payload). */
  frameLength: number;
  /** Audio samples represented by this frame. */
  samplesPerFrame: number;
  /** Sampling rate in hertz. */
  sampleRate: number;
}

/**
 * Length in bytes of a leading ID3v2 tag, or 0 if the buffer does not start with
 * one. The tag body size is a 28-bit "syncsafe" integer; a footer (flag bit 4)
 * adds another 10 bytes. Shared by the duration walk and the merge/strip logic.
 */
export function id3v2Length(buffer: Uint8Array): number {
  const startsWithId3Tag =
    buffer.length >= 10 &&
    buffer[0] === 0x49 && // 'I'
    buffer[1] === 0x44 && // 'D'
    buffer[2] === 0x33; // '3'
  if (!startsWithId3Tag) {
    return 0;
  }

  const hasFooter = (buffer[5] & 0x10) !== 0;
  const bodySize =
    ((buffer[6] & 0x7f) << 21) |
    ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) |
    (buffer[9] & 0x7f);

  return 10 + bodySize + (hasFooter ? 10 : 0);
}

/**
 * Parse one MPEG audio frame header at `offset`, returning its length, sample
 * count, and sample rate — or `null` when the four bytes are not a valid frame
 * header (reserved fields, free/bad bitrate, or reserved sample rate).
 */
function parseFrameHeader(
  buffer: Uint8Array,
  offset: number,
): Mp3FrameInfo | null {
  // Sync word: 11 bits set (0xFF followed by top 3 bits of the next byte).
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
    return null;
  }

  const byte1 = buffer[offset + 1];
  const byte2 = buffer[offset + 2];

  const versionField = (byte1 >> 3) & 0x03; // 0=2.5, 1=reserved, 2=2, 3=1
  const layerField = (byte1 >> 1) & 0x03; // 0=reserved, 1=III, 2=II, 3=I
  if (versionField === 0x01 || layerField === 0x00) {
    return null;
  }

  const bitrateIndex = (byte2 >> 4) & 0x0f;
  const sampleRateIndex = (byte2 >> 2) & 0x03;
  const padding = (byte2 >> 1) & 0x01;
  // Reject free-format (0) and bad (15) bitrate indexes and the reserved rate.
  if (bitrateIndex === 0x00 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) {
    return null;
  }

  const layer = LAYER_BY_FIELD[layerField];
  const isMpeg1 = versionField === 0x03;

  const bitrateKbps = (isMpeg1 ? BITRATES_MPEG1 : BITRATES_MPEG2)[layer][bitrateIndex];
  const sampleRate = SAMPLE_RATES[versionField][sampleRateIndex];
  if (bitrateKbps === undefined || sampleRate === undefined || bitrateKbps === 0) {
    return null;
  }
  const bitrateBitsPerSecond = bitrateKbps * 1000;

  // Samples per frame: Layer I = 384; Layer II = 1152;
  // Layer III = 1152 on MPEG1, 576 on MPEG2/2.5.
  let samplesPerFrame: number;
  if (layer === 1) {
    samplesPerFrame = 384;
  } else if (layer === 2) {
    samplesPerFrame = 1152;
  } else {
    samplesPerFrame = isMpeg1 ? 1152 : 576;
  }

  // Frame length in bytes. Layer I uses 4-byte slots; Layers II/III use bytes.
  let frameLength: number;
  if (layer === 1) {
    frameLength =
      (Math.floor((12 * bitrateBitsPerSecond) / sampleRate) + padding) * 4;
  } else {
    frameLength =
      Math.floor((samplesPerFrame / 8) * (bitrateBitsPerSecond / sampleRate)) +
      padding;
  }
  if (frameLength <= 0) {
    return null;
  }

  return { frameLength, samplesPerFrame, sampleRate };
}

/**
 * Estimate the playback duration of a single MP3 buffer in milliseconds by
 * summing decoded MPEG frame durations. A leading ID3v2 tag is skipped. Bytes
 * that are not a valid frame header are skipped one at a time so stray data
 * between frames never stalls the walk.
 */
export function estimateMp3DurationMs(buffer: Uint8Array): number {
  const length = buffer.length;
  let offset = id3v2Length(buffer);
  let totalSeconds = 0;

  while (offset + 4 <= length) {
    const frame = parseFrameHeader(buffer, offset);
    if (frame === null) {
      offset += 1;
      continue;
    }
    totalSeconds += frame.samplesPerFrame / frame.sampleRate;
    offset += frame.frameLength;
  }

  return Math.round(totalSeconds * 1000);
}
