/**
 * The timing arithmetic is the part of the viewer that is easy to get subtly
 * wrong and impossible to eyeball, so it is pinned against the fixture rather
 * than against hand-made numbers: the fixture is the same shape the worker
 * emits, including a line with no word timings and a second part whose offsets
 * restart at zero.
 */

import { describe, expect, it } from 'vitest';
import { SAMPLE_SHARE_VIEW } from '../fixtures/sample-share-view.ts';
import {
  NO_ACTIVE_INDEX,
  elapsedMillisecondsAcrossParts,
  findActiveLineIndex,
  findActiveWordIndex,
  findSegmentForLine,
  flattenScriptLines,
  formatDurationLabel,
  formatPlaybackTime,
  partBoundaryFractions,
  resolveLineSeek,
  resolveTimelineSeek,
  resolveWordSeek,
  totalDurationMilliseconds,
  wordLevelForDistance,
} from './timings.ts';

const parts = SAMPLE_SHARE_VIEW.parts;
const firstPart = parts[0];
const secondPart = parts[1];

describe('findActiveLineIndex', () => {
  it('reports the line whose window contains the playhead', () => {
    expect(findActiveLineIndex(firstPart.segments, 0)).toBe(0);
    expect(findActiveLineIndex(firstPart.segments, 3999)).toBe(0);
    expect(findActiveLineIndex(firstPart.segments, 5000)).toBe(1);
    expect(findActiveLineIndex(firstPart.segments, 8000)).toBe(2);
  });

  it('treats the window as half-open so a boundary belongs to the next line only', () => {
    expect(findActiveLineIndex(firstPart.segments, 4000)).toBe(1);
    expect(findActiveLineIndex(firstPart.segments, 7500)).toBe(2);
  });

  it('reports nothing past the end of the part', () => {
    expect(findActiveLineIndex(firstPart.segments, 12_000)).toBe(NO_ACTIVE_INDEX);
  });

  it('restarts from zero in a later part, because offsets are part-relative', () => {
    expect(findActiveLineIndex(secondPart.segments, 0)).toBe(0);
    expect(findActiveLineIndex(secondPart.segments, 6000)).toBe(1);
  });
});

describe('findActiveWordIndex', () => {
  it('spotlights the word being spoken', () => {
    const segment = findSegmentForLine(firstPart, 0);
    expect(findActiveWordIndex(segment, 0)).toBe(0);
    expect(findActiveWordIndex(segment, 1300)).toBe(1);
    expect(findActiveWordIndex(segment, 3999)).toBe(2);
  });

  it('degrades to no spotlight when the line carries no word timings', () => {
    const segment = findSegmentForLine(firstPart, 2);
    expect(segment?.words).toBeUndefined();
    expect(findActiveWordIndex(segment, 8000)).toBe(NO_ACTIVE_INDEX);
  });

  it('reports nothing for a missing segment or a gap between words', () => {
    expect(findActiveWordIndex(undefined, 0)).toBe(NO_ACTIVE_INDEX);
    expect(findActiveWordIndex(findSegmentForLine(firstPart, 0), 9_999)).toBe(
      NO_ACTIVE_INDEX,
    );
  });
});

describe('resolveLineSeek', () => {
  it('returns a part-relative offset within the same part', () => {
    expect(resolveLineSeek(parts, 0, 1)).toEqual({
      partArrayIndex: 0,
      offsetMilliseconds: 4000,
    });
  });

  it('crosses a part boundary without adding the earlier parts durations', () => {
    // Part 2 line 1 starts 5s into PART 2, not 17s into the newscast.
    expect(resolveLineSeek(parts, 1, 1)).toEqual({
      partArrayIndex: 1,
      offsetMilliseconds: 5000,
    });
  });

  it('falls back to the start of the part for a line with no timings', () => {
    expect(resolveLineSeek(parts, 1, 99)).toEqual({
      partArrayIndex: 1,
      offsetMilliseconds: 0,
    });
  });

  it('clamps an out-of-range part rather than producing an undefined target', () => {
    expect(resolveLineSeek(parts, 42, 0).partArrayIndex).toBe(parts.length - 1);
  });
});

describe('resolveWordSeek', () => {
  it('prefers the word offset over the line offset', () => {
    expect(resolveWordSeek(parts, 0, 1, 2)).toEqual({
      partArrayIndex: 0,
      offsetMilliseconds: 6200,
    });
  });

  it('crosses a part boundary with a part-relative word offset', () => {
    expect(resolveWordSeek(parts, 1, 0, 3)).toEqual({
      partArrayIndex: 1,
      offsetMilliseconds: 3300,
    });
  });

  it('falls back to the line offset when the word has no timing', () => {
    expect(resolveWordSeek(parts, 0, 2, 0)).toEqual({
      partArrayIndex: 0,
      offsetMilliseconds: 7500,
    });
  });
});

describe('flattenScriptLines', () => {
  it('produces one continuous conversation that remembers its part', () => {
    const entries = flattenScriptLines(parts);
    expect(entries).toHaveLength(5);
    expect(entries[0]).toMatchObject({ partArrayIndex: 0, lineIndex: 0, startsPart: true });
    expect(entries[3]).toMatchObject({
      partArrayIndex: 1,
      partNumber: 2,
      lineIndex: 0,
      startsPart: true,
    });
    expect(entries[4]).toMatchObject({ partArrayIndex: 1, lineIndex: 1, startsPart: false });
  });
});

describe('whole-newscast arithmetic', () => {
  it('sums every part duration', () => {
    expect(totalDurationMilliseconds(parts)).toBe(21_000);
  });

  it('adds every earlier part in full to the playhead inside the current one', () => {
    expect(elapsedMillisecondsAcrossParts(parts, 0, 3000)).toBe(3000);
    expect(elapsedMillisecondsAcrossParts(parts, 1, 3000)).toBe(15_000);
  });
});

describe('resolveTimelineSeek', () => {
  it('keeps a position inside the first part part-relative and unchanged', () => {
    expect(resolveTimelineSeek(parts, 5000)).toEqual({
      partArrayIndex: 0,
      offsetMilliseconds: 5000,
    });
  });

  it('subtracts the earlier parts once the position crosses a boundary', () => {
    // 15s into a 12s + 9s newscast is 3s into PART 2.
    expect(resolveTimelineSeek(parts, 15_000)).toEqual({
      partArrayIndex: 1,
      offsetMilliseconds: 3000,
    });
  });

  it('hands the boundary itself to the part that starts there', () => {
    expect(resolveTimelineSeek(parts, 12_000)).toEqual({
      partArrayIndex: 1,
      offsetMilliseconds: 0,
    });
  });

  it('clamps both ends rather than refusing the seek', () => {
    expect(resolveTimelineSeek(parts, -5000)).toEqual({
      partArrayIndex: 0,
      offsetMilliseconds: 0,
    });
    expect(resolveTimelineSeek(parts, 99_000)).toEqual({
      partArrayIndex: 1,
      offsetMilliseconds: 9000,
    });
  });

  it('round-trips against elapsedMillisecondsAcrossParts', () => {
    for (const overall of [0, 1, 4000, 11_999, 12_000, 12_001, 20_999, 21_000]) {
      const target = resolveTimelineSeek(parts, overall);
      expect(
        elapsedMillisecondsAcrossParts(
          parts,
          target.partArrayIndex,
          target.offsetMilliseconds,
        ),
      ).toBe(overall);
    }
  });

  it('skips a zero-length part instead of trapping the playhead in it', () => {
    const withEmptyPart = [{ ...firstPart, durationMs: 0 }, secondPart];
    expect(resolveTimelineSeek(withEmptyPart, 0)).toEqual({
      partArrayIndex: 1,
      offsetMilliseconds: 0,
    });
  });

  it('survives an empty newscast', () => {
    expect(resolveTimelineSeek([], 4000)).toEqual({
      partArrayIndex: 0,
      offsetMilliseconds: 0,
    });
  });
});

describe('partBoundaryFractions', () => {
  it('places one notch per boundary, proportional to the whole', () => {
    expect(partBoundaryFractions(parts)).toEqual([12_000 / 21_000]);
  });

  it('produces no notch for a single part or an empty newscast', () => {
    expect(partBoundaryFractions([firstPart])).toEqual([]);
    expect(partBoundaryFractions([])).toEqual([]);
  });
});

describe('presentation helpers', () => {
  it('formats playback time as m:ss and survives a NaN duration', () => {
    expect(formatPlaybackTime(0)).toBe('0:00');
    expect(formatPlaybackTime(65.9)).toBe('1:05');
    expect(formatPlaybackTime(Number.NaN)).toBe('0:00');
    expect(formatPlaybackTime(-4)).toBe('0:00');
  });

  it('spells a length out in Korean for the byline', () => {
    expect(formatDurationLabel(totalDurationMilliseconds(parts))).toBe('21초');
    expect(formatDurationLabel(522_000)).toBe('8분 42초');
    expect(formatDurationLabel(120_000)).toBe('2분');
    expect(formatDurationLabel(3_720_000)).toBe('1시간 2분');
    expect(formatDurationLabel(0)).toBe('0초');
    expect(formatDurationLabel(Number.NaN)).toBe('0초');
  });

  it('brightens words closer to the one being spoken', () => {
    expect(wordLevelForDistance(0)).toBe(6);
    expect(wordLevelForDistance(1)).toBe(5);
    expect(wordLevelForDistance(3)).toBe(3);
    expect(wordLevelForDistance(9)).toBe(2);
  });
});
