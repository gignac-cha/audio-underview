/**
 * Fuzzy alignment of the KNOWN newscast script to a Whisper word-timestamp
 * transcript, yielding REAL per-line caption timings.
 *
 * Whisper's transcript never matches the script exactly (mishearings, dropped
 * or inserted words, punctuation differences), so a literal string match is
 * hopeless. Instead we:
 *   1. flatten the script into an ordered "reference" syllable sequence,
 *      remembering which script line each syllable came from;
 *   2. flatten the transcript into a "hypothesis" syllable sequence, giving each
 *      syllable a timestamp by prorating its word's [startMs,endMs] linearly;
 *   3. run a global Needleman-Wunsch sequence alignment (match 0, substitution 1,
 *      gap 1) to obtain a MONOTONIC mapping between the two sequences;
 *   4. copy each exactly-matched hypothesis syllable's start time onto its
 *      reference syllable, linearly interpolate the gaps, and clamp monotonic;
 *   5. read off each line's start time (its first reference syllable) and derive
 *      per-line durations.
 *
 * The DP is BANDED around the diagonal so a long newscast (several thousand
 * syllables) stays well within Worker memory; for short inputs the band widens
 * to the full matrix, i.e. exact Needleman-Wunsch.
 *
 * A confidence gate (fraction of reference syllables that got an EXACT match)
 * rejects low-quality alignments by returning `null`, letting the caller keep
 * its proportional estimate.
 */

import type {
  AudioSegment,
  ScriptLine,
  WordTiming,
} from '@audio-underview/newscast-core';
import type { TranscriptWord } from './transcribe.ts';

/**
 * Minimum fraction of reference syllables that must EXACTLY match a transcript
 * syllable for the alignment to be trusted. Below this the result is discarded.
 */
const CONFIDENCE_THRESHOLD = 0.45;

/** Direction codes stored during the DP for traceback. */
const DIAGONAL = 0; // match or substitution: consume one ref + one hyp
const UP = 1; //       delete reference syllable (Whisper missed it)
const LEFT = 2; //     insert hypothesis syllable (Whisper heard extra)

/**
 * Derive per-line caption timings by aligning `script` to Whisper's `words`.
 * Returns one {@link AudioSegment} per script line (index-aligned), or `null`
 * when alignment is impossible or low-confidence (caller keeps its estimate).
 */
export function alignScriptToTranscript(
  script: ScriptLine[],
  words: TranscriptWord[],
  totalDurationMs: number,
): AudioSegment[] | null {
  if (script.length === 0 || words.length === 0) {
    return null;
  }

  // Step 1 — reference syllables + their owning line AND word index. A "word" is
  // one whitespace-split token of the line's text; its syllables are that token's
  // normalized alignable characters. Splitting per word before flattening yields
  // the exact same syllable sequence as flattening the whole line (whitespace is
  // dropped anyway), so alignment is unchanged — we just also remember the word.
  const referenceSyllables: string[] = [];
  const referenceLineIndexes: number[] = [];
  const referenceWordIndexes: number[] = [];
  // Original (un-normalized) whitespace-split word text, per line.
  const lineWords: string[][] = new Array(script.length);
  for (let lineIndex = 0; lineIndex < script.length; lineIndex += 1) {
    const wordTexts = splitWords(script[lineIndex].text);
    lineWords[lineIndex] = wordTexts;
    for (let wordIndex = 0; wordIndex < wordTexts.length; wordIndex += 1) {
      for (const syllable of toSyllables(wordTexts[wordIndex])) {
        referenceSyllables.push(syllable);
        referenceLineIndexes.push(lineIndex);
        referenceWordIndexes.push(wordIndex);
      }
    }
  }
  if (referenceSyllables.length === 0) {
    return null;
  }

  // Step 2 — hypothesis syllables with prorated timestamps.
  const hypothesisSyllables: string[] = [];
  const hypothesisStartMs: number[] = [];
  for (const word of words) {
    const syllables = toSyllables(word.text);
    if (syllables.length === 0) {
      continue;
    }
    const span = word.endMs - word.startMs;
    for (let position = 0; position < syllables.length; position += 1) {
      hypothesisSyllables.push(syllables[position]);
      hypothesisStartMs.push(word.startMs + (span * position) / syllables.length);
    }
  }
  if (hypothesisSyllables.length === 0) {
    return null;
  }

  // Step 3 + 4 — banded Needleman-Wunsch, then read matched times.
  const { referenceTimeMs, matchCount } = alignSyllables(
    referenceSyllables,
    hypothesisSyllables,
    hypothesisStartMs,
  );

  // Step 6 (early) — confidence gate.
  if (matchCount / referenceSyllables.length < CONFIDENCE_THRESHOLD) {
    return null;
  }

  // Step 4 (finish) — default endpoints, interpolate gaps, clamp monotonic.
  const times = interpolateTimes(referenceTimeMs, totalDurationMs);

  // Step 5 — per-line start (first reference syllable) and duration.
  const firstSyllablePosition = new Array<number | undefined>(script.length).fill(
    undefined,
  );
  for (let position = 0; position < referenceLineIndexes.length; position += 1) {
    const lineIndex = referenceLineIndexes[position];
    if (firstSyllablePosition[lineIndex] === undefined) {
      firstSyllablePosition[lineIndex] = position;
    }
  }

  const starts: number[] = new Array(script.length);
  let runningMs = 0;
  for (let lineIndex = 0; lineIndex < script.length; lineIndex += 1) {
    const position = firstSyllablePosition[lineIndex];
    // A line with no syllables (pure punctuation) inherits the running time.
    let start = position === undefined ? runningMs : times[position];
    if (start < runningMs) {
      start = runningMs; // enforce non-decreasing line starts
    }
    starts[lineIndex] = Math.round(start);
    runningMs = start;
  }

  // Per-line, per-word aligned times: the first (min) and last syllable time of
  // each word. `times` is globally non-decreasing, so a word's first syllable is
  // its minimum and its last syllable is its maximum.
  const wordFirstMs: Array<Array<number | undefined>> = lineWords.map((wordTexts) =>
    new Array<number | undefined>(wordTexts.length).fill(undefined),
  );
  const wordLastMs: Array<Array<number | undefined>> = lineWords.map((wordTexts) =>
    new Array<number | undefined>(wordTexts.length).fill(undefined),
  );
  for (let position = 0; position < referenceSyllables.length; position += 1) {
    const lineIndex = referenceLineIndexes[position];
    const wordIndex = referenceWordIndexes[position];
    const time = times[position];
    if (wordFirstMs[lineIndex][wordIndex] === undefined) {
      wordFirstMs[lineIndex][wordIndex] = time; // first syllable → minimum
    }
    wordLastMs[lineIndex][wordIndex] = time; // last write → last syllable
  }

  const segments: AudioSegment[] = new Array(script.length);
  for (let lineIndex = 0; lineIndex < script.length; lineIndex += 1) {
    const start = starts[lineIndex];
    const end =
      lineIndex < script.length - 1
        ? starts[lineIndex + 1]
        : Math.round(totalDurationMs);
    const durationMs = Math.max(0, end - start);
    const words = buildWordTimings(
      lineWords[lineIndex],
      wordFirstMs[lineIndex],
      wordLastMs[lineIndex],
      start,
      start + durationMs,
    );
    segments[lineIndex] =
      words.length > 0
        ? { index: lineIndex, startMs: start, durationMs, words }
        : { index: lineIndex, startMs: start, durationMs };
  }
  return segments;
}

/** Split a line into whitespace-delimited word tokens, dropping empty tokens. */
function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * Derive monotonic, non-overlapping per-word timings for one line from its
 * per-word first/last aligned syllable times. Words with no alignable syllables
 * (e.g. pure punctuation) inherit the previous boundary. Starts are clamped into
 * `[lineStartMs, lineEndMs]` and kept non-decreasing; each word ends at the next
 * word's start (`max`'d with its own last syllable time for safety), and the last
 * word ends at `lineEndMs`.
 */
function buildWordTimings(
  wordTexts: string[],
  firstMs: Array<number | undefined>,
  lastMs: Array<number | undefined>,
  lineStartMs: number,
  lineEndMs: number,
): WordTiming[] {
  const wordCount = wordTexts.length;
  if (wordCount === 0) {
    return [];
  }

  // Monotonic non-decreasing starts, clamped into the line's span.
  const startMsByWord = new Array<number>(wordCount);
  let previous = lineStartMs;
  for (let wordIndex = 0; wordIndex < wordCount; wordIndex += 1) {
    const candidate = firstMs[wordIndex];
    let start = candidate === undefined ? previous : candidate;
    if (start < previous) {
      start = previous;
    }
    if (start > lineEndMs) {
      start = lineEndMs;
    }
    startMsByWord[wordIndex] = Math.round(start);
    previous = startMsByWord[wordIndex];
  }

  const timings: WordTiming[] = new Array(wordCount);
  for (let wordIndex = 0; wordIndex < wordCount; wordIndex += 1) {
    const start = startMsByWord[wordIndex];
    // endMs = max(next word's start, this word's last syllable time); the last
    // word ends at the line's end. Because `times` is monotonic the next word's
    // start already exceeds this word's last syllable, so words tile cleanly.
    let end: number;
    if (wordIndex < wordCount - 1) {
      const nextStart = startMsByWord[wordIndex + 1];
      const last = lastMs[wordIndex];
      end = last === undefined ? nextStart : Math.max(nextStart, Math.round(last));
    } else {
      end = lineEndMs;
    }
    if (end < start) {
      end = start; // ensure endMs >= startMs
    }
    timings[wordIndex] = { text: wordTexts[wordIndex], startMs: start, endMs: end };
  }
  return timings;
}

/**
 * Normalize text into an ordered list of alignment "syllables": each Hangul
 * syllable block and each Latin letter / digit becomes its own token;
 * whitespace and punctuation are dropped and letters are lower-cased. Iterating
 * with `for...of` walks by code point.
 */
function toSyllables(text: string): string[] {
  const syllables: string[] = [];
  for (const character of text.toLowerCase()) {
    if (isAlignableCharacter(character)) {
      syllables.push(character);
    }
  }
  return syllables;
}

/** Keep Hangul syllable blocks (U+AC00–U+D7A3) and lower-case alphanumerics. */
function isAlignableCharacter(character: string): boolean {
  return (
    (character >= '가' && character <= '힣') ||
    (character >= 'a' && character <= 'z') ||
    (character >= '0' && character <= '9')
  );
}

/**
 * Banded Needleman-Wunsch between `reference` and `hypothesis`. Returns, for
 * each reference syllable, the start time (ms) of the hypothesis syllable it was
 * EXACTLY matched to (or `null`), plus the total number of exact matches.
 */
function alignSyllables(
  reference: string[],
  hypothesis: string[],
  hypothesisStartMs: number[],
): { referenceTimeMs: (number | null)[]; matchCount: number } {
  const rowCount = reference.length; // n
  const columnCount = hypothesis.length; // m

  // Band radius: cover the length difference plus generous slack, and never
  // less than the per-row diagonal slope (so the band stays connected).
  const slopeGuard =
    Math.ceil(
      Math.max(rowCount / Math.max(columnCount, 1), columnCount / Math.max(rowCount, 1)),
    ) + 1;
  let radius = Math.abs(rowCount - columnCount) + Math.max(64, Math.ceil(Math.max(rowCount, columnCount) * 0.15));
  radius = Math.max(radius, slopeGuard);
  radius = Math.min(radius, columnCount); // full matrix when small

  const diagonalColumn = (row: number): number =>
    rowCount === 0 ? 0 : Math.round((row * columnCount) / rowCount);
  const lowColumn = (row: number): number => Math.max(0, diagonalColumn(row) - radius);
  const highColumn = (row: number): number =>
    Math.min(columnCount, diagonalColumn(row) + radius);

  const lowByRow = new Array<number>(rowCount + 1);
  const highByRow = new Array<number>(rowCount + 1);
  for (let row = 0; row <= rowCount; row += 1) {
    lowByRow[row] = lowColumn(row);
    highByRow[row] = highColumn(row);
  }

  // One direction row per matrix row (jagged, band-width only) for traceback.
  const directions: Uint8Array[] = new Array(rowCount + 1);

  const readCost = (
    costs: Float64Array,
    low: number,
    high: number,
    column: number,
  ): number => (column < low || column > high ? Infinity : costs[column - low]);

  // Row 0: aligning nothing against `hypothesis[0..column)` costs `column`
  // insertions (all LEFT moves).
  let previousLow = lowByRow[0];
  let previousHigh = highByRow[0];
  let previousCosts = new Float64Array(previousHigh - previousLow + 1);
  const rowZeroDirections = new Uint8Array(previousHigh - previousLow + 1);
  for (let column = previousLow; column <= previousHigh; column += 1) {
    previousCosts[column - previousLow] = column;
    if (column > 0) {
      rowZeroDirections[column - previousLow] = LEFT;
    }
  }
  directions[0] = rowZeroDirections;

  for (let row = 1; row <= rowCount; row += 1) {
    const low = lowByRow[row];
    const high = highByRow[row];
    const width = high - low + 1;
    const costs = new Float64Array(width);
    const rowDirections = new Uint8Array(width);

    for (let column = low; column <= high; column += 1) {
      const index = column - low;
      if (column === 0) {
        costs[index] = row; // delete all `row` reference syllables
        rowDirections[index] = UP;
        continue;
      }
      const substitution = reference[row - 1] === hypothesis[column - 1] ? 0 : 1;
      const diagonal =
        readCost(previousCosts, previousLow, previousHigh, column - 1) + substitution;
      const up = readCost(previousCosts, previousLow, previousHigh, column) + 1;
      const left = readCost(costs, low, high, column - 1) + 1;

      let best = diagonal;
      let direction = DIAGONAL;
      if (up < best) {
        best = up;
        direction = UP;
      }
      if (left < best) {
        best = left;
        direction = LEFT;
      }
      costs[index] = best;
      rowDirections[index] = direction;
    }

    directions[row] = rowDirections;
    previousCosts = costs;
    previousLow = low;
    previousHigh = high;
  }

  // Traceback from (rowCount, columnCount) to (0, 0).
  const referenceTimeMs = new Array<number | null>(rowCount).fill(null);
  let matchCount = 0;
  let row = rowCount;
  let column = columnCount;
  while (row > 0 || column > 0) {
    if (row === 0) {
      column -= 1;
      continue;
    }
    if (column === 0) {
      row -= 1;
      continue;
    }
    const index = column - lowByRow[row];
    // Defensive: outside the stored band, prefer the deletion move.
    const direction =
      index < 0 || index >= directions[row].length ? UP : directions[row][index];
    if (direction === DIAGONAL) {
      if (reference[row - 1] === hypothesis[column - 1]) {
        referenceTimeMs[row - 1] = hypothesisStartMs[column - 1];
        matchCount += 1;
      }
      row -= 1;
      column -= 1;
    } else if (direction === UP) {
      row -= 1;
    } else {
      column -= 1;
    }
  }

  return { referenceTimeMs, matchCount };
}

/**
 * Fill missing reference times: the first defaults to 0 and the last toward
 * `totalDurationMs`, interior gaps are linearly interpolated between the nearest
 * known anchors, and the whole sequence is clamped non-decreasing.
 */
function interpolateTimes(
  referenceTimeMs: (number | null)[],
  totalDurationMs: number,
): number[] {
  const count = referenceTimeMs.length;
  const times: (number | null)[] = referenceTimeMs.slice();
  if (times[0] === null) {
    times[0] = 0;
  }
  if (times[count - 1] === null) {
    times[count - 1] = totalDurationMs;
  }

  let previousKnown = 0; // times[0] is now known
  for (let position = 1; position < count; position += 1) {
    if (times[position] === null) {
      continue;
    }
    const startValue = times[previousKnown] as number;
    const endValue = times[position] as number;
    const gap = position - previousKnown;
    for (let between = previousKnown + 1; between < position; between += 1) {
      times[between] = startValue + ((endValue - startValue) * (between - previousKnown)) / gap;
    }
    previousKnown = position;
  }

  const resolved = times as number[];
  if (resolved[0] < 0) {
    resolved[0] = 0;
  }
  for (let position = 1; position < count; position += 1) {
    if (resolved[position] < resolved[position - 1]) {
      resolved[position] = resolved[position - 1];
    }
  }
  return resolved;
}
