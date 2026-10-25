import { describe, expect, it } from 'vitest';

import { MAX_AUDIO_PART_INDEX, resolveAudioLookup } from '../sources/audio-lookup.ts';

const NEWSCAST_ID = 'newscast-42';

describe('resolveAudioLookup — ?part=N mapping', () => {
  it('maps a valid part to its R2 key', () => {
    expect(resolveAudioLookup(NEWSCAST_ID, '2')).toEqual({ valid: true, key: 'newscast-42/part-2' });
  });

  it('accepts part 1 and the MAX_AUDIO_PART_INDEX upper boundary', () => {
    expect(resolveAudioLookup(NEWSCAST_ID, '1')).toEqual({ valid: true, key: 'newscast-42/part-1' });
    expect(resolveAudioLookup(NEWSCAST_ID, String(MAX_AUDIO_PART_INDEX))).toEqual({
      valid: true,
      key: `newscast-42/part-${MAX_AUDIO_PART_INDEX}`,
    });
  });

  it('rejects a part that is zero, negative, over the cap, or non-integer', () => {
    for (const bad of ['0', '-1', String(MAX_AUDIO_PART_INDEX + 1), '1.5', 'abc', '', ' 1', '01x', '2e1']) {
      expect(resolveAudioLookup(NEWSCAST_ID, bad)).toEqual({ valid: false });
    }
  });
});

describe('resolveAudioLookup — ?part=signal', () => {
  it('maps the literal `signal` keyword to the sting key', () => {
    expect(resolveAudioLookup(NEWSCAST_ID, 'signal')).toEqual({ valid: true, key: 'newscast-42/signal' });
  });

  it('resolves `signal` BEFORE the integer check, so it is never a bad-number 400', () => {
    // `signal` is non-numeric, so if it were not branched first it would fall into
    // the integer validation and 400 — this guards that ordering.
    expect(resolveAudioLookup(NEWSCAST_ID, 'signal').valid).toBe(true);
  });

  it('keeps the sting key distinct from a numeric part key', () => {
    expect(resolveAudioLookup(NEWSCAST_ID, 'signal')).not.toEqual(resolveAudioLookup(NEWSCAST_ID, '1'));
  });
});

describe('resolveAudioLookup — no ?part', () => {
  it('plays part 1', () => {
    expect(resolveAudioLookup(NEWSCAST_ID, null)).toEqual({ valid: true, key: 'newscast-42/part-1' });
  });
});
