import type { ScriptLine } from '@audio-underview/newscast-core';
import { alignScriptToTranscript } from './align.ts';
import type { TranscriptWord } from './transcribe.ts';

describe('alignScriptToTranscript', () => {
  test('mostly-matching transcript yields monotonic per-line starts near the word times', () => {
    // Two lines. Reference syllables:
    //   line 0: 안 녕 하 세 요 여 러 분  (8)
    //   line 1: 오 늘 뉴 스 입 니 다      (7)
    const script: ScriptLine[] = [
      { speaker: 1, text: '안녕하세요 여러분!' },
      { speaker: 2, text: '오늘 뉴스입니다.' },
    ];
    // Transcript with a substitution (분 -> 뷴) and a missing syllable (늘 dropped).
    const words: TranscriptWord[] = [
      { text: '안녕하세요', startMs: 0, endMs: 1_000 }, // 안0 녕200 하400 세600 요800
      { text: '여러뷴', startMs: 1_000, endMs: 1_600 }, // 여1000 러1200 뷴1400(sub)
      { text: '오', startMs: 1_700, endMs: 1_900 }, // 오1700 (늘 missing)
      { text: '뉴스입니다', startMs: 2_100, endMs: 3_100 }, // 뉴2100 스2300 입2500 니2700 다2900
    ];

    const segments = alignScriptToTranscript(script, words, 3_400);
    expect(segments).not.toBeNull();
    const result = segments as NonNullable<typeof segments>;

    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);

    // Line 0 starts at 안 -> 0ms; line 1 starts at 오 -> ~1700ms.
    expect(result[0].startMs).toBeLessThanOrEqual(50);
    expect(Math.abs(result[1].startMs - 1_700)).toBeLessThan(250);

    // Monotonic starts, non-negative durations, and tiling into total duration.
    expect(result[0].startMs).toBeLessThanOrEqual(result[1].startMs);
    expect(result[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(result[0].startMs + result[0].durationMs).toBe(result[1].startMs);
    expect(result[1].startMs + result[1].durationMs).toBe(3_400);
  });

  test('a matched line yields per-word timings that tile the line monotonically', () => {
    const script: ScriptLine[] = [
      { speaker: 1, text: '안녕하세요 여러분!' },
      { speaker: 2, text: '오늘 뉴스입니다.' },
    ];
    const words: TranscriptWord[] = [
      { text: '안녕하세요', startMs: 0, endMs: 1_000 },
      { text: '여러뷴', startMs: 1_000, endMs: 1_600 },
      { text: '오', startMs: 1_700, endMs: 1_900 },
      { text: '뉴스입니다', startMs: 2_100, endMs: 3_100 },
    ];

    const segments = alignScriptToTranscript(script, words, 3_400);
    expect(segments).not.toBeNull();
    const result = segments as NonNullable<typeof segments>;

    const line0 = result[0];
    expect(line0.words).toBeDefined();
    const line0Words = line0.words as NonNullable<typeof line0.words>;

    // Word text equals the script line's whitespace-split tokens (un-normalized).
    expect(line0Words.map((word) => word.text)).toEqual(['안녕하세요', '여러분!']);

    // Monotonic, non-overlapping, and contained in the line's [start, start+dur].
    const lineStart = line0.startMs;
    const lineEnd = line0.startMs + line0.durationMs;
    let previousEnd = lineStart;
    for (const word of line0Words) {
      expect(word.startMs).toBeGreaterThanOrEqual(previousEnd); // no overlap
      expect(word.endMs).toBeGreaterThanOrEqual(word.startMs);
      expect(word.startMs).toBeGreaterThanOrEqual(lineStart);
      expect(word.endMs).toBeLessThanOrEqual(lineEnd);
      previousEnd = word.endMs;
    }
    // The line's words tile it edge to edge.
    expect(line0Words[0].startMs).toBe(lineStart);
    expect(line0Words[line0Words.length - 1].endMs).toBe(lineEnd);
  });

  test('garbage transcript that shares no syllables returns null', () => {
    const script: ScriptLine[] = [
      { speaker: 1, text: '안녕하세요 여러분' },
      { speaker: 2, text: '오늘 뉴스입니다' },
    ];
    const words: TranscriptWord[] = [
      { text: 'xyz123', startMs: 0, endMs: 500 },
      { text: 'qqq999', startMs: 500, endMs: 1_000 },
    ];
    expect(alignScriptToTranscript(script, words, 1_000)).toBeNull();
  });

  test('empty transcript or empty script returns null', () => {
    const script: ScriptLine[] = [{ speaker: 1, text: '안녕하세요' }];
    expect(alignScriptToTranscript(script, [], 1_000)).toBeNull();
    expect(
      alignScriptToTranscript([], [{ text: '안녕', startMs: 0, endMs: 100 }], 1_000),
    ).toBeNull();
  });

  test('long perfectly-matching sequence exercises the banded DP and stays monotonic', () => {
    // 150 lines x 4 distinct Hangul syllables = 600 reference syllables, which
    // forces the diagonal band to be narrower than the full matrix.
    const lineCount = 150;
    const syllablesPerLine = 4;
    const base = 0xac00;
    const script: ScriptLine[] = [];
    const words: TranscriptWord[] = [];
    for (let line = 0; line < lineCount; line += 1) {
      let text = '';
      for (let position = 0; position < syllablesPerLine; position += 1) {
        text += String.fromCharCode(base + line * syllablesPerLine + position);
      }
      script.push({ speaker: line % 2 === 0 ? 1 : 2, text });
      // One transcript word per line, each spanning 100ms.
      words.push({ text, startMs: line * 100, endMs: line * 100 + 80 });
    }
    const totalDurationMs = lineCount * 100;

    const segments = alignScriptToTranscript(script, words, totalDurationMs);
    expect(segments).not.toBeNull();
    const result = segments as NonNullable<typeof segments>;

    expect(result).toHaveLength(lineCount);
    for (let line = 0; line < lineCount; line += 1) {
      expect(result[line].index).toBe(line);
      expect(result[line].durationMs).toBeGreaterThanOrEqual(0);
      if (line > 0) {
        expect(result[line].startMs).toBeGreaterThanOrEqual(result[line - 1].startMs);
      }
      // Each line's start should land near its injected 100ms-per-line time.
      expect(Math.abs(result[line].startMs - line * 100)).toBeLessThan(120);
    }
  });
});
