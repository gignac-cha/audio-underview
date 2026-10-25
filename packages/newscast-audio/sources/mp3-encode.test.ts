import { encodePcmToMp3 } from './mp3-encode.ts';

/**
 * Build a short synthetic mono PCM buffer: a 220 Hz sine at 24000 Hz, signed
 * 16-bit little-endian, `durationMs` long.
 */
function makeSinePcm(durationMs: number, sampleRate = 24_000): Uint8Array {
  const sampleCount = Math.round((sampleRate * durationMs) / 1_000);
  const pcm = new Uint8Array(sampleCount * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 12_000);
    view.setInt16(index * 2, value, true);
  }
  return pcm;
}

describe('encodePcmToMp3', () => {
  test('produces a non-empty MP3 that starts with a frame sync (or ID3)', () => {
    const pcm = makeSinePcm(500);
    const mp3 = encodePcmToMp3(pcm, 24_000, 1);

    expect(mp3.length).toBeGreaterThan(0);

    const isFrameSync = mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0;
    const isId3 = mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33; // "ID3"
    expect(isFrameSync || isId3).toBe(true);
  });

  test('compresses well below the raw PCM size', () => {
    const pcm = makeSinePcm(2_000);
    const mp3 = encodePcmToMp3(pcm);

    expect(mp3.length).toBeGreaterThan(0);
    expect(mp3.length).toBeLessThan(pcm.length);
  });

  test('handles an empty PCM buffer without throwing', () => {
    const mp3 = encodePcmToMp3(new Uint8Array(0));
    expect(mp3).toBeInstanceOf(Uint8Array);
  });
});
