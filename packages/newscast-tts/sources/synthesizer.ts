/**
 * Google Cloud Text-to-Speech Chirp 3 HD (ko-KR) synthesizer.
 *
 * Chirp 3 HD is single-speaker, so the newscast script is synthesized one line
 * at a time — one HTTP request per line, each with the voice that belongs to
 * that line's speaker. The per-line MP3 buffers are returned aligned by index
 * with the input script so the audio merger can build time-synced segments.
 *
 * Endpoint (see BUILD-NEWSCAST-SPEC section 1):
 *   POST https://texttospeech.googleapis.com/v1/text:synthesize?key=<apiKey>
 *   body   { input, voice: { languageCode, name }, audioConfig: { audioEncoding: 'MP3' } }
 *   result { audioContent: <base64 MP3> }
 */

import type {
  ScriptLine,
  SpeakerId,
} from '@audio-underview/newscast-core';
import { redactAndTruncate } from '@audio-underview/newscast-core';

/**
 * Mapping from a speaker id to the ko-KR Chirp 3 HD voice name used for that
 * host. The two speakers must use two distinct voices.
 */
export type SpeakerVoiceMapping = Record<SpeakerId, string>;

/**
 * Default two-voice mapping (BUILD-NEWSCAST-SPEC section 1):
 * - 진행자1 (speaker 1) = ko-KR-Chirp3-HD-Charon (male)
 * - 진행자2 (speaker 2) = ko-KR-Chirp3-HD-Kore (female)
 */
export const DEFAULT_SPEAKER_VOICES: SpeakerVoiceMapping = {
  1: 'ko-KR-Chirp3-HD-Charon',
  2: 'ko-KR-Chirp3-HD-Kore',
};

/** Default language code for synthesis. */
const DEFAULT_LANGUAGE_CODE = 'ko-KR';

/** Chirp 3 HD synthesize endpoint (API key is appended as the `key` query parameter). */
const SYNTHESIZE_ENDPOINT =
  'https://texttospeech.googleapis.com/v1/text:synthesize';

/** Shape of the JSON body returned by the synthesize endpoint. */
interface SynthesizeResponseBody {
  audioContent?: string;
}

export interface SynthesizeLineOptions {
  apiKey: string;
  text: string;
  voiceName: string;
  /** Language code for the voice; defaults to 'ko-KR'. */
  languageCode?: string;
}

/** XML-escape text before embedding it in SSML. */
function escapeForSsml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wrap a plain line in SSML, turning punctuation into explicit pauses so Chirp 3
 * actually "띄어 읽기". Without this a leading interjection like "아, 저도" runs
 * together into "아저도"; a `<break>` after the comma separates them. Ellipses get
 * a longer pause than commas.
 */
function toSsml(text: string): string {
  let body = escapeForSsml(text);
  body = body.replace(/(\.\.\.|…)/g, '<break time="400ms"/>');
  body = body.replace(/,\s*/g, ',<break time="220ms"/> ');
  return `<speak>${body}</speak>`;
}

/**
 * Synthesize ONE script line to MP3 bytes.
 *
 * POSTs to text:synthesize with MP3 output and base64-decodes the returned
 * `audioContent` into a `Uint8Array`. Throws when the request fails or the
 * response carries no audio.
 */
const SYNTHESIS_MAX_ATTEMPTS = 3;
const SYNTHESIS_TIMEOUT_MS = 20_000;

export async function synthesizeLine(
  options: SynthesizeLineOptions,
): Promise<Uint8Array> {
  const {
    apiKey,
    text,
    voiceName,
    languageCode = DEFAULT_LANGUAGE_CODE,
  } = options;

  const requestUrl = `${SYNTHESIZE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const requestBody = JSON.stringify({
    input: { ssml: toSsml(text) },
    voice: { languageCode, name: voiceName },
    // speakingRate 0.95 = 자연스러운 뉴스 대화 속도(로봇처럼 빠르지 않게). Chirp3 HD 지원.
    audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95 },
  });

  // Each call is time-bounded + retried: a single hung/slow/rate-limited TTS
  // request must not freeze the whole pipeline (which was the failure mode for
  // longer scripts). AbortSignal.timeout aborts the fetch; retries cover transient
  // 429/5xx/network/timeout errors.
  let lastError: unknown;
  for (let attempt = 1; attempt <= SYNTHESIS_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
        signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
      });

      if (!response.ok) {
        // The key travels in this endpoint's query string, so a 400/403 body can
        // quote it straight back. Mask BEFORE truncating (a mid-key cut would
        // otherwise leave a usable prefix) — this message is persisted into the
        // job's failure record.
        const detail = redactAndTruncate(await response.text().catch(() => ''));
        throw new Error(
          `Google Text-to-Speech request failed (${response.status} ${response.statusText}): ${detail}`,
        );
      }

      const payload = (await response.json()) as SynthesizeResponseBody;
      if (payload.audioContent === undefined || payload.audioContent.length === 0) {
        throw new Error(
          'Google Text-to-Speech response did not contain audioContent.',
        );
      }

      return decodeBase64ToBytes(payload.audioContent);
    } catch (error) {
      lastError = error;
      if (attempt < SYNTHESIS_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Google Text-to-Speech request failed after retries.');
}

export interface SynthesizeScriptOptions {
  apiKey: string;
  script: ScriptLine[];
  /** Voice per speaker; defaults to DEFAULT_SPEAKER_VOICES. */
  voices?: SpeakerVoiceMapping;
  /**
   * Invoked after each line is synthesized with (completed, total) so the
   * caller can report per-line progress within the TTS stage.
   */
  onLine?: (completed: number, total: number) => void;
}

/** Maximum concurrent TTS requests — bounds wall-clock (avoids exceeding Worker
 * execution limits) while staying under Google TTS per-minute quotas. */
const SYNTHESIS_CONCURRENCY = 6;

/**
 * Synthesize every line of the script, selecting the voice per line via
 * `voices[line.speaker]`. Returns one MP3 buffer per line, aligned by index with
 * `script`. Requests run with bounded concurrency (sequential synthesis of a long
 * script exceeds the Worker execution window); `onLine(completed, total)` fires as
 * each line finishes.
 */
export async function synthesizeScript(
  options: SynthesizeScriptOptions,
): Promise<Uint8Array[]> {
  const { apiKey, script, voices = DEFAULT_SPEAKER_VOICES, onLine } = options;

  const total = script.length;
  const buffers: Uint8Array[] = new Array(total);
  let completed = 0;
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) {
        return;
      }
      const line = script[index];
      const voiceName = voices[line.speaker] ?? DEFAULT_SPEAKER_VOICES[line.speaker];
      buffers[index] = await synthesizeLine({ apiKey, text: line.text, voiceName });
      completed += 1;
      onLine?.(completed, total);
    }
  }

  const workerCount = Math.min(SYNTHESIS_CONCURRENCY, total);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return buffers;
}

/**
 * Decode a base64 string (Google's `audioContent`) into raw MP3 bytes.
 * Uses the platform `atob`, available in Workers, browsers, and Node under the
 * default ESNext + DOM lib set.
 */
function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
