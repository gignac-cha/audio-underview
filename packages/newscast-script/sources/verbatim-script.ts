/**
 * Verbatim direct input ("그대로 읽기") — the shared parser (design §2).
 *
 * The whole point of this feature is that NO LLM sees the user's text: what is
 * pasted is what is read aloud. That guarantee is structural, not a prompt
 * instruction, so it lives in one pure module that both surfaces execute:
 * - the web form runs it on every keystroke for the live preview, and
 * - the pipeline worker runs it inline (no durable step — deterministic and
 *   instant) before jumping the stage straight to `tts`.
 *
 * Because those two callers must agree exactly, this file has no DOM, no Workers
 * API and no runtime imports — the only import is a type-only one, erased at
 * build time — and it deliberately does NOT import from `./index.ts`, which
 * pulls in the provider call sites.
 *
 * Every recognition rule below maps 1:1 to a clause of the reference prompt in
 * design §4; changing one means changing the other.
 */

import type { ScriptLine, SpeakerId } from '@audio-underview/newscast-core';

/**
 * One verbatim utterance. Structurally the shared `ScriptLine` — aliased rather
 * than redeclared so verbatim scripts flow into the existing TTS path unchanged,
 * and re-exported under this name so the web preview and the worker can consume
 * the parser without also depending on the core package.
 */
export type VerbatimScriptLine = ScriptLine;

/** Result of {@link parseVerbatimScript}. */
export interface VerbatimScriptParseResult {
  lines: VerbatimScriptLine[];
  warnings: VerbatimWarning[];
}

/**
 * What the parser noticed about the pasted text.
 * - `unprefixed-lines`: how many lines carried no speaker prefix and were
 *   therefore assigned speaker 1. Advisory only — an entirely unprefixed input
 *   is a valid single-narrator script.
 * - `url-in-line`: 1-based positions **in the returned `lines` array** (not the
 *   raw input line numbers, since blank lines are dropped) that still contain a
 *   URL. Advisory only — URLs read aloud badly, but they are not rejected.
 * - `overlong-line`: 1-based positions (same basis as `url-in-line`) of lines
 *   whose spoken text exceeds {@link VERBATIM_LINE_CHARACTER_LIMIT}. Blocking:
 *   one turn is indivisible all the way down to the TTS request.
 * - `empty-script`: no utterance survived parsing. Blocking: the worker answers
 *   400 and the form disables submission.
 */
export type VerbatimWarning =
  | { kind: 'unprefixed-lines'; count: number }
  | { kind: 'url-in-line'; lineNumbers: number[] }
  | { kind: 'overlong-line'; lineNumbers: number[] }
  | { kind: 'empty-script' };

/**
 * The speaker prefixes the parser recognizes, in the canonical form the guidance
 * panel shows to users. Recognition itself is more tolerant than these literals:
 * the Latin forms are case-insensitive, the full-width colon `：` is accepted,
 * and whitespace around the word, the digit and the colon is ignored.
 */
export const VERBATIM_SPEAKER_PREFIXES = ['화자1:', '화자2:', 'Speaker1:', 'Speaker2:'] as const;

/**
 * Part boundary threshold in spoken characters (prefixes excluded). A part is
 * closed after the line that pushes its cumulative count past this limit, so a
 * part is never split mid-line and every closed part exceeds the limit. That
 * lower bound is what keeps the 24,000-character input cap at 8 parts or fewer
 * (design §2) — closing *before* the overflowing line instead would cap parts at
 * 3,000 characters and let a full-length input reach 9.
 */
export const VERBATIM_PART_CHARACTER_LIMIT = 3000;

/**
 * A trailing part shorter than this is merged back into its predecessor, so a
 * two-second last part never gets its own signal sting. The merged part may end
 * up longer than {@link VERBATIM_PART_CHARACTER_LIMIT}; that is intended.
 */
export const VERBATIM_PART_MINIMUM_CHARACTERS = 500;

/**
 * Longest spoken text one utterance may carry.
 *
 * A turn is INDIVISIBLE the whole way down: parts split between lines, and the
 * TTS chunker (`newscast-tts`'s `MAX_CHUNK_DIALOGUE_BYTES`, 3,500 UTF-8
 * bytes) also only ever flushes BETWEEN turns. One pasted line is therefore one
 * synthesis request no matter how long it is, and at 3 bytes per Korean glyph the
 * chunker's own ceiling is around 1,166 characters. 1,000 sits under that with
 * headroom for the style directive and the speaker labels, so no single line can
 * push a request past what the chunker was sized for.
 *
 * The reference prompt (design §4, clause 2) already asks for one sentence per
 * line, so a line over this limit means the text was not converted for reading —
 * which is why the worker treats it as a rejection rather than advice.
 */
export const VERBATIM_LINE_CHARACTER_LIMIT = 1000;

/**
 * `화자1:` `화자2:` `Speaker1:` `Speaker2:` and their tolerated variants. The `i`
 * flag only affects the Latin form. Speakers other than 1 and 2 do not match and
 * fall through to the unprefixed path, keeping the two-voice TTS contract.
 */
const SPEAKER_PREFIX_PATTERN = /^\s*(?:화자|speaker)\s*([12])\s*[:：]\s*/i;

/** Matches the URL shapes the reference prompt forbids (design §4, clause 5). */
const URL_PATTERN = /https?:\/\/|www\./i;

/**
 * Parse pasted text into utterances, exactly as they will be read aloud.
 *
 * One line is one utterance; blank lines are dropped; a recognized prefix is
 * stripped from the text and selects the speaker; a line without a prefix is
 * assigned speaker 1 and counted in the `unprefixed-lines` warning. A line that
 * is nothing but a prefix has nothing to read and is dropped like a blank line.
 *
 * Warning order is stable (`unprefixed-lines`, `url-in-line`, `overlong-line`,
 * `empty-script`) so the preview does not reshuffle while typing.
 */
export function parseVerbatimScript(text: string): VerbatimScriptParseResult {
  const lines: VerbatimScriptLine[] = [];
  const urlLineNumbers: number[] = [];
  const overlongLineNumbers: number[] = [];
  let unprefixedCount = 0;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0) {
      continue;
    }

    const prefixMatch = SPEAKER_PREFIX_PATTERN.exec(trimmedLine);
    let speaker: SpeakerId = 1;
    let lineText = trimmedLine;

    if (prefixMatch === null) {
      unprefixedCount += 1;
    } else {
      speaker = Number(prefixMatch[1]) as SpeakerId;
      lineText = trimmedLine.slice(prefixMatch[0].length).trim();
    }

    if (lineText.length === 0) {
      continue;
    }

    lines.push({ speaker, text: lineText });
    if (URL_PATTERN.test(lineText)) {
      urlLineNumbers.push(lines.length);
    }
    if (lineText.length > VERBATIM_LINE_CHARACTER_LIMIT) {
      overlongLineNumbers.push(lines.length);
    }
  }

  const warnings: VerbatimWarning[] = [];
  if (unprefixedCount > 0) {
    warnings.push({ kind: 'unprefixed-lines', count: unprefixedCount });
  }
  if (urlLineNumbers.length > 0) {
    warnings.push({ kind: 'url-in-line', lineNumbers: urlLineNumbers });
  }
  if (overlongLineNumbers.length > 0) {
    warnings.push({ kind: 'overlong-line', lineNumbers: overlongLineNumbers });
  }
  if (lines.length === 0) {
    warnings.push({ kind: 'empty-script' });
  }

  return { lines, warnings };
}

/**
 * Split parsed utterances into TTS parts, deterministically (design §2).
 *
 * A line is appended to the current part; when that part's spoken-character
 * count passes {@link VERBATIM_PART_CHARACTER_LIMIT} the part is closed after
 * that line, so no line is ever split. A trailing part under
 * {@link VERBATIM_PART_MINIMUM_CHARACTERS} is merged into the previous part.
 *
 * Every closed part therefore exceeds 3,000 characters, which bounds a
 * 24,000-character input at 8 parts. The returned arrays are fresh; the input is
 * not mutated.
 */
export function splitVerbatimParts(lines: readonly VerbatimScriptLine[]): VerbatimScriptLine[][] {
  const parts: VerbatimScriptLine[][] = [];
  let currentPart: VerbatimScriptLine[] = [];
  let currentCharacters = 0;

  for (const line of lines) {
    currentPart.push(line);
    currentCharacters += line.text.length;

    if (currentCharacters > VERBATIM_PART_CHARACTER_LIMIT) {
      parts.push(currentPart);
      currentPart = [];
      currentCharacters = 0;
    }
  }

  if (currentPart.length > 0) {
    parts.push(currentPart);
  }

  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1];
    if (countVerbatimCharacters(lastPart) < VERBATIM_PART_MINIMUM_CHARACTERS) {
      parts[parts.length - 2].push(...lastPart);
      parts.pop();
    }
  }

  return parts;
}

/**
 * Spoken-character count of a set of utterances — speaker prefixes excluded,
 * because they are never read aloud. Shared so the preview's part estimate and
 * the split use the same measure.
 */
export function countVerbatimCharacters(lines: readonly VerbatimScriptLine[]): number {
  return lines.reduce((total, line) => total + line.text.length, 0);
}
