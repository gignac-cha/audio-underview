import { estimateMp3DurationMs, id3v2Length } from './mp3-duration.ts';

// MPEG1 Layer III, 128 kbps, 44100 Hz, no padding.
// Frame length = floor(1152/8 * 128000/44100) = 417 bytes.
// Frame duration = 1152 / 44100 s ≈ 26.122 ms.
const MPEG1_FRAME_BYTES = 417;
const MPEG1_FRAME_MS = 1152 / 44100 * 1000;

function makeMpeg1Frame(): Uint8Array {
  const frame = new Uint8Array(MPEG1_FRAME_BYTES);
  frame[0] = 0xff;
  frame[1] = 0xfb; // sync + MPEG1 + Layer III
  frame[2] = 0x90; // bitrate index 9 (128k) + sample-rate index 0 (44100)
  frame[3] = 0xc0; // mono channel mode (payload is irrelevant to parsing)
  return frame;
}

function makeMpeg1Frames(count: number): Uint8Array {
  const frame = makeMpeg1Frame();
  const bytes = new Uint8Array(MPEG1_FRAME_BYTES * count);
  for (let index = 0; index < count; index += 1) {
    bytes.set(frame, index * MPEG1_FRAME_BYTES);
  }
  return bytes;
}

// A syncsafe-sized ID3v2 tag (10-byte header + `bodyLength` zero bytes, no footer).
function makeId3v2Tag(bodyLength: number): Uint8Array {
  const tag = new Uint8Array(10 + bodyLength);
  tag[0] = 0x49; // 'I'
  tag[1] = 0x44; // 'D'
  tag[2] = 0x33; // '3'
  tag[3] = 0x03; // version major
  tag[4] = 0x00; // version minor
  tag[5] = 0x00; // flags (no footer)
  tag[6] = (bodyLength >> 21) & 0x7f;
  tag[7] = (bodyLength >> 14) & 0x7f;
  tag[8] = (bodyLength >> 7) & 0x7f;
  tag[9] = bodyLength & 0x7f;
  return tag;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe('id3v2Length', () => {
  test('returns 0 when there is no leading ID3v2 tag', () => {
    expect(id3v2Length(makeMpeg1Frame())).toBe(0);
  });

  test('returns header + syncsafe body size', () => {
    expect(id3v2Length(makeId3v2Tag(10))).toBe(20);
    expect(id3v2Length(makeId3v2Tag(200))).toBe(210);
  });

  test('adds 10 bytes when the footer flag is set', () => {
    const tag = makeId3v2Tag(10);
    tag[5] = 0x10; // footer present
    expect(id3v2Length(tag)).toBe(30);
  });
});

describe('estimateMp3DurationMs', () => {
  test('sums MPEG1 Layer III frame durations', () => {
    expect(estimateMp3DurationMs(makeMpeg1Frames(1))).toBe(Math.round(MPEG1_FRAME_MS));
    expect(estimateMp3DurationMs(makeMpeg1Frames(10))).toBe(Math.round(MPEG1_FRAME_MS * 10));
  });

  test('skips a leading ID3v2 tag', () => {
    const withTag = concat(makeId3v2Tag(37), makeMpeg1Frames(3));
    const withoutTag = makeMpeg1Frames(3);
    expect(estimateMp3DurationMs(withTag)).toBe(estimateMp3DurationMs(withoutTag));
    expect(estimateMp3DurationMs(withTag)).toBe(Math.round(MPEG1_FRAME_MS * 3));
  });

  test('reads the actual sample rate and layer of an MPEG2 (24 kHz) frame', () => {
    // MPEG2 Layer III, 48 kbps, 24000 Hz: frame length 144 bytes, 576 samples.
    const frame = new Uint8Array(144);
    frame[0] = 0xff;
    frame[1] = 0xf3; // sync + MPEG2 + Layer III
    frame[2] = 0x64; // bitrate index 6 (48k) + sample-rate index 1 (24000)
    frame[3] = 0xc0;
    expect(estimateMp3DurationMs(frame)).toBe(Math.round((576 / 24000) * 1000)); // 24
  });

  test('returns 0 for a buffer with no valid frames', () => {
    expect(estimateMp3DurationMs(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBe(0);
  });
});
