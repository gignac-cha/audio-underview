import { mergePcmChunks, pcmDurationMs } from './pcm-merge.ts';

describe('pcmDurationMs', () => {
  test('computes exact duration from byte length (mono, 16-bit)', () => {
    // 24000 Hz * 1 channel * 2 bytes = 48000 bytes/second.
    expect(pcmDurationMs(48_000, 24_000)).toBe(1_000);
    expect(pcmDurationMs(24_000, 24_000)).toBe(500);
    expect(pcmDurationMs(0, 24_000)).toBe(0);
  });

  test('returns 0 for a zero sample rate rather than dividing by zero', () => {
    expect(pcmDurationMs(1_000, 0)).toBe(0);
  });
});

describe('mergePcmChunks', () => {
  test('concatenates PCM in order and derives cumulative per-chunk timing', () => {
    // Each chunk is 24000 bytes => 500 ms at 24000 Hz mono 16-bit.
    const chunkA = new Uint8Array(24_000).fill(1);
    const chunkB = new Uint8Array(48_000).fill(2); // 1000 ms

    const { pcm, chunkSegments } = mergePcmChunks([chunkA, chunkB], 24_000);

    expect(pcm).toHaveLength(72_000);
    expect(pcm[0]).toBe(1);
    expect(pcm[24_000]).toBe(2);

    expect(chunkSegments).toEqual([
      { index: 0, startMs: 0, durationMs: 500 },
      { index: 1, startMs: 500, durationMs: 1_000 },
    ]);
  });

  test('handles an empty chunk list', () => {
    const { pcm, chunkSegments } = mergePcmChunks([], 24_000);
    expect(pcm).toHaveLength(0);
    expect(chunkSegments).toEqual([]);
  });
});
