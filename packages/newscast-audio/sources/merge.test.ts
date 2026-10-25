import { mergeLineAudio } from './merge.ts';

const MPEG1_FRAME_BYTES = 417;
const MPEG1_FRAME_MS = 1152 / 44100 * 1000;

function makeMpeg1Frames(count: number): Uint8Array {
  const bytes = new Uint8Array(MPEG1_FRAME_BYTES * count);
  for (let index = 0; index < count; index += 1) {
    const base = index * MPEG1_FRAME_BYTES;
    bytes[base] = 0xff;
    bytes[base + 1] = 0xfb;
    bytes[base + 2] = 0x90;
    bytes[base + 3] = 0xc0;
  }
  return bytes;
}

function makeId3v2Tag(bodyLength: number): Uint8Array {
  const tag = new Uint8Array(10 + bodyLength);
  tag[0] = 0x49;
  tag[1] = 0x44;
  tag[2] = 0x33;
  tag[3] = 0x03;
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

describe('mergeLineAudio', () => {
  test('returns empty bytes and no segments for an empty input', () => {
    const merged = mergeLineAudio([]);
    expect(merged.bytes).toHaveLength(0);
    expect(merged.segments).toEqual([]);
  });

  test('concatenates buffers and computes cumulative, index-aligned timings', () => {
    const first = makeMpeg1Frames(3);
    const second = makeMpeg1Frames(2);
    const merged = mergeLineAudio([first, second]);

    expect(merged.bytes).toHaveLength(first.length + second.length);
    // Byte-faithful concatenation.
    expect(Array.from(merged.bytes.subarray(0, first.length))).toEqual(Array.from(first));
    expect(Array.from(merged.bytes.subarray(first.length))).toEqual(Array.from(second));

    const durationThree = Math.round(MPEG1_FRAME_MS * 3);
    const durationTwo = Math.round(MPEG1_FRAME_MS * 2);
    expect(merged.segments).toEqual([
      { index: 0, startMs: 0, durationMs: durationThree },
      { index: 1, startMs: durationThree, durationMs: durationTwo },
    ]);
  });

  test('keeps the first ID3v2 tag but strips it from later buffers', () => {
    const first = concat(makeId3v2Tag(16), makeMpeg1Frames(3));
    const second = concat(makeId3v2Tag(24), makeMpeg1Frames(3));
    const merged = mergeLineAudio([first, second]);

    // First buffer kept intact; second buffer's 34-byte tag (10 + 24) removed.
    const expectedLength = first.length + (second.length - (10 + 24));
    expect(merged.bytes).toHaveLength(expectedLength);

    // The tail of the merged stream equals the second buffer's audio frames only.
    const expectedTail = makeMpeg1Frames(3);
    expect(Array.from(merged.bytes.subarray(first.length))).toEqual(Array.from(expectedTail));

    // Timing is unaffected by ID3 stripping (durations come from frame headers).
    const durationThree = Math.round(MPEG1_FRAME_MS * 3);
    expect(merged.segments).toEqual([
      { index: 0, startMs: 0, durationMs: durationThree },
      { index: 1, startMs: durationThree, durationMs: durationThree },
    ]);
  });
});
