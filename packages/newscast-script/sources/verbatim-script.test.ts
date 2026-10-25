import { describe, expect, it } from 'vitest';

import type { VerbatimScriptLine, VerbatimWarning } from './verbatim-script.ts';
import {
  VERBATIM_LINE_CHARACTER_LIMIT,
  VERBATIM_PART_CHARACTER_LIMIT,
  VERBATIM_PART_MINIMUM_CHARACTERS,
  VERBATIM_SPEAKER_PREFIXES,
  countVerbatimCharacters,
  parseVerbatimScript,
  splitVerbatimParts,
} from './verbatim-script.ts';

/** `n` utterances of exactly `characters` spoken characters each, all speaker 1. */
function filledLines(count: number, characters: number): VerbatimScriptLine[] {
  return Array.from({ length: count }, () => ({
    speaker: 1 as const,
    text: '가'.repeat(characters),
  }));
}

function warningOfKind<Kind extends VerbatimWarning['kind']>(warnings: VerbatimWarning[], kind: Kind): Extract<VerbatimWarning, { kind: Kind }> | undefined {
  return warnings.find((warning): warning is Extract<VerbatimWarning, { kind: Kind }> => {
    return warning.kind === kind;
  });
}

describe('parseVerbatimScript prefixes', () => {
  it('recognizes all four documented prefixes and strips them', () => {
    const result = parseVerbatimScript(['화자1: 첫 문장입니다.', '화자2: 두 번째 문장입니다.', 'Speaker1: 세 번째.', 'Speaker2: 네 번째.'].join('\n'));

    expect(result.lines).toEqual([
      { speaker: 1, text: '첫 문장입니다.' },
      { speaker: 2, text: '두 번째 문장입니다.' },
      { speaker: 1, text: '세 번째.' },
      { speaker: 2, text: '네 번째.' },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('matches the Latin prefixes case-insensitively', () => {
    const result = parseVerbatimScript(['speaker1: 소문자.', 'SPEAKER2: 대문자.', 'SpEaKeR1: 혼합.'].join('\n'));

    expect(result.lines).toEqual([
      { speaker: 1, text: '소문자.' },
      { speaker: 2, text: '대문자.' },
      { speaker: 1, text: '혼합.' },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts the full-width colon', () => {
    const result = parseVerbatimScript(['화자1： 전각 콜론.', 'Speaker2： full width.'].join('\n'));

    expect(result.lines).toEqual([
      { speaker: 1, text: '전각 콜론.' },
      { speaker: 2, text: 'full width.' },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('tolerates whitespace around the word, digit, colon and text', () => {
    const result = parseVerbatimScript(['   화자1 :   앞뒤 공백.   ', '\t화자 2\t：\t탭 구분.\t', 'Speaker 1 : spaced latin.'].join('\n'));

    expect(result.lines).toEqual([
      { speaker: 1, text: '앞뒤 공백.' },
      { speaker: 2, text: '탭 구분.' },
      { speaker: 1, text: 'spaced latin.' },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('ignores blank lines and prefix-only lines, and handles CRLF input', () => {
    const result = parseVerbatimScript('화자1: 첫 줄.\r\n\r\n화자2:\r\n   \r\n화자2: 마지막 줄.\r\n');

    expect(result.lines).toEqual([
      { speaker: 1, text: '첫 줄.' },
      { speaker: 2, text: '마지막 줄.' },
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe('parseVerbatimScript unprefixed fallback', () => {
  it('assigns unprefixed lines to speaker 1 and counts them in a warning', () => {
    const result = parseVerbatimScript(['화자2: 접두가 있는 줄.', '접두가 없는 줄.', '또 없는 줄.'].join('\n'));

    expect(result.lines).toEqual([
      { speaker: 2, text: '접두가 있는 줄.' },
      { speaker: 1, text: '접두가 없는 줄.' },
      { speaker: 1, text: '또 없는 줄.' },
    ]);
    expect(warningOfKind(result.warnings, 'unprefixed-lines')).toEqual({
      kind: 'unprefixed-lines',
      count: 2,
    });
  });

  it('turns an entirely unprefixed input into a single-narrator script', () => {
    const result = parseVerbatimScript(['첫 문장.', '두 번째 문장.', '세 번째 문장.'].join('\n'));

    expect(result.lines.every((line) => line.speaker === 1)).toBe(true);
    expect(result.lines).toHaveLength(3);
    expect(result.warnings).toEqual([{ kind: 'unprefixed-lines', count: 3 }]);
  });

  it('does not treat speakers other than 1 and 2 as a prefix', () => {
    const result = parseVerbatimScript('화자3: 세 번째 화자는 없습니다.');

    expect(result.lines).toEqual([{ speaker: 1, text: '화자3: 세 번째 화자는 없습니다.' }]);
    expect(warningOfKind(result.warnings, 'unprefixed-lines')).toEqual({
      kind: 'unprefixed-lines',
      count: 1,
    });
  });
});

describe('parseVerbatimScript warnings', () => {
  it('reports URL-bearing lines by their 1-based position in the parsed lines', () => {
    const result = parseVerbatimScript(
      ['화자1: 깨끗한 줄.', '', '화자2: 자세한 내용은 https://example.com 에 있습니다.', '화자1: 또 다른 깨끗한 줄.', '화자2: www.example.com 도 보세요.'].join(
        '\n',
      ),
    );

    expect(result.lines).toHaveLength(4);
    expect(warningOfKind(result.warnings, 'url-in-line')).toEqual({
      kind: 'url-in-line',
      lineNumbers: [2, 4],
    });
  });

  it('warns exactly once with empty-script for blank input', () => {
    for (const input of ['', '   ', '\n\n\t\n', '화자1:\n화자2：\n']) {
      const result = parseVerbatimScript(input);

      expect(result.lines).toEqual([]);
      expect(result.warnings).toEqual([{ kind: 'empty-script' }]);
    }
  });

  it('emits warnings in a stable order', () => {
    const result = parseVerbatimScript(
      ['접두 없는 줄 https://example.com', '화자2: 정상 줄.', `화자1: ${'가'.repeat(VERBATIM_LINE_CHARACTER_LIMIT + 1)}`].join('\n'),
    );

    expect(result.warnings.map((warning) => warning.kind)).toEqual(['unprefixed-lines', 'url-in-line', 'overlong-line']);
  });
});

describe('parseVerbatimScript overlong lines', () => {
  it('exposes the documented line limit', () => {
    expect(VERBATIM_LINE_CHARACTER_LIMIT).toBe(1000);
  });

  it('accepts a line of exactly the limit and warns one character later', () => {
    // A turn is never split — not into parts, and not by the TTS chunker either —
    // so this boundary is what keeps one pasted line inside one synthesis request.
    const atLimit = parseVerbatimScript(`화자1: ${'가'.repeat(VERBATIM_LINE_CHARACTER_LIMIT)}`);
    expect(atLimit.lines[0].text).toHaveLength(VERBATIM_LINE_CHARACTER_LIMIT);
    expect(atLimit.warnings).toEqual([]);

    const overLimit = parseVerbatimScript(`화자1: ${'가'.repeat(VERBATIM_LINE_CHARACTER_LIMIT + 1)}`);
    expect(warningOfKind(overLimit.warnings, 'overlong-line')).toEqual({
      kind: 'overlong-line',
      lineNumbers: [1],
    });
  });

  it('measures the SPOKEN text, so a prefix never pushes a line over the limit', () => {
    // The prefix is a format marker that is never read aloud (and never reaches
    // TTS), so it must not count toward the limit it exists to protect.
    const result = parseVerbatimScript(`화자2:   ${'가'.repeat(VERBATIM_LINE_CHARACTER_LIMIT)}   `);

    expect(result.warnings).toEqual([]);
  });

  it('reports every overlong line by its 1-based position in the parsed lines', () => {
    const overlong = '가'.repeat(VERBATIM_LINE_CHARACTER_LIMIT + 200);
    const result = parseVerbatimScript(
      [`화자1: ${overlong}`, '', '화자2: 짧은 줄.', `화자1: ${overlong}`, `화자2: ${overlong}`].join('\n'),
    );

    // Blank lines are dropped before numbering, exactly as `url-in-line` numbers.
    expect(result.lines).toHaveLength(4);
    expect(warningOfKind(result.warnings, 'overlong-line')).toEqual({
      kind: 'overlong-line',
      lineNumbers: [1, 3, 4],
    });
  });
});

describe('splitVerbatimParts', () => {
  it('exposes the documented constants and prefix list', () => {
    expect(VERBATIM_PART_CHARACTER_LIMIT).toBe(3000);
    expect(VERBATIM_PART_MINIMUM_CHARACTERS).toBe(500);
    expect(VERBATIM_SPEAKER_PREFIXES).toEqual(['화자1:', '화자2:', 'Speaker1:', 'Speaker2:']);
  });

  it('returns no parts for an empty script', () => {
    expect(splitVerbatimParts([])).toEqual([]);
  });

  it('keeps a script at exactly the limit in one part', () => {
    const lines = filledLines(3, 1000);

    const parts = splitVerbatimParts(lines);

    expect(parts).toHaveLength(1);
    expect(countVerbatimCharacters(parts[0])).toBe(3000);
  });

  it('closes a part after the line that passes the limit, never mid-line', () => {
    const lines = filledLines(8, 1000);

    const parts = splitVerbatimParts(lines);

    expect(parts.map((part) => part.length)).toEqual([4, 4]);
    expect(parts.map((part) => countVerbatimCharacters(part))).toEqual([4000, 4000]);
  });

  it('merges a trailing part under 500 characters into the previous part', () => {
    const lines = [...filledLines(4, 1000), { speaker: 2 as const, text: '가'.repeat(499) }];

    const parts = splitVerbatimParts(lines);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(5);
    expect(countVerbatimCharacters(parts[0])).toBe(4499);
  });

  it('keeps a trailing part of exactly 500 characters on its own', () => {
    const lines = [...filledLines(4, 1000), { speaker: 2 as const, text: '가'.repeat(500) }];

    const parts = splitVerbatimParts(lines);

    expect(parts.map((part) => countVerbatimCharacters(part))).toEqual([4000, 500]);
  });

  it('gives a single over-long line its own part rather than splitting it', () => {
    const lines = [{ speaker: 1 as const, text: '가'.repeat(7000) }, ...filledLines(1, 900)];

    const parts = splitVerbatimParts(lines);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(1);
    expect(countVerbatimCharacters(parts[0])).toBe(7000);
  });

  it('does not mutate the input lines', () => {
    const lines = filledLines(6, 1000);
    const snapshot = lines.map((line) => ({ ...line }));

    splitVerbatimParts(lines);

    expect(lines).toEqual(snapshot);
  });

  it('caps a 24,000-character script at 8 parts and preserves every line in order', () => {
    const source = Array.from({ length: 240 }, (_, index) => {
      const speaker = index % 2 === 0 ? '화자1' : '화자2';
      return `${speaker}: ${'가'.repeat(100)}`;
    }).join('\n');

    const { lines, warnings } = parseVerbatimScript(source);
    const parts = splitVerbatimParts(lines);

    expect(warnings).toEqual([]);
    expect(countVerbatimCharacters(lines)).toBe(24_000);
    expect(parts.length).toBeLessThanOrEqual(8);
    expect(parts.flat()).toEqual(lines);
    expect(countVerbatimCharacters(parts.flat())).toBe(24_000);
  });

  it('caps 24,000 characters at 8 parts even when every line is a short sentence', () => {
    const lines = filledLines(1200, 20);

    const parts = splitVerbatimParts(lines);

    expect(countVerbatimCharacters(lines)).toBe(24_000);
    expect(parts.length).toBeLessThanOrEqual(8);
    expect(parts.flat()).toEqual(lines);
  });
});
