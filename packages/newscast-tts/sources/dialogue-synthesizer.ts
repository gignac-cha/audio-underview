/**
 * Gemini Developer API native multi-speaker TTS dialogue synthesizer (ko-KR).
 *
 * This path uses the SAME `GEMINI_API_KEY` already used for script generation —
 * no Vertex / Agent Platform OAuth, no service account, zero console setup. It
 * calls the Gemini Developer API `generateContent` endpoint on
 * `generativelanguage.googleapis.com`, which renders an ORDERED, mixed-speaker
 * dialogue in a SINGLE request and returns raw PCM audio (base64) inline.
 *
 * Confirmed request shape
 * (https://ai.google.dev/gemini-api/docs/generate-content/speech-generation):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/<MODEL>:generateContent
 *   header  x-goog-api-key: <GEMINI_API_KEY>
 *   {
 *     "contents": [{ "parts": [{ "text": "<style directive>\n\nSpeaker1: …\nSpeaker2: …" }] }],
 *     "generationConfig": {
 *       "responseModalities": ["AUDIO"],
 *       "speechConfig": {
 *         "multiSpeakerVoiceConfig": {
 *           "speakerVoiceConfigs": [
 *             { "speaker": "Speaker1", "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Charon" } } },
 *             { "speaker": "Speaker2", "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Leda" } } }
 *           ]
 *         }
 *       }
 *     }
 *   }
 *   result { candidates[0].content.parts[0].inlineData: { data: <base64 PCM>, mimeType: "audio/L16;rate=24000" } }
 *
 * CRITICAL: the transcript text must LITERALLY contain each speaker label
 * (`Speaker1:` / `Speaker2:`), and each `speaker` in `speakerVoiceConfigs` must
 * match a label used in the text. The optional leading style directive is a
 * natural-language instruction the model interprets but does NOT speak.
 *
 * Output is raw signed 16-bit little-endian PCM, mono, at the rate parsed from
 * `inlineData.mimeType` (default 24000 Hz). Callers concatenate the per-chunk PCM
 * and wrap the whole once with {@link wrapPcmToWav} — no ffmpeg.
 *
 * Limits (per docs): 32k-token context window per TTS request; up to 2 speakers;
 * quality can drift past a few minutes, so the chunking helper keeps each request
 * small.
 *
 * GEMINI 3.8 TTS (2026-09-22) takes a different BODY on the same endpoint
 * (verified live 2026-09-29): one part per turn carrying
 * `speech_metadata: { speaker, style }` instead of one `SpeakerN:` transcript,
 * because 3.8 reads every character of the text aloud — a leading directive
 * would be spoken. A 3.8 request without `speech_metadata.speaker` on each part
 * answers 400. Its audio comes back as a complete WAV (`audio/wav`, RIFF
 * header) rather than headerless PCM, so the header is stripped here and callers
 * still receive raw PCM. `speechConfig` is unchanged.
 */

import type {
  AiGatewayConfiguration,
  ProviderTransport,
  ScriptLine,
  SpeakerId,
} from '@audio-underview/newscast-core';
import {
  DEFAULT_TTS_MODEL,
  ProviderRequestError,
  aiGatewayHeaders,
  aiGatewayUrl,
  isProviderCredentialRejection,
  redactAndTruncate,
} from '@audio-underview/newscast-core';
import type { SpeakerVoiceMapping } from './synthesizer.ts';

/**
 * Gemini Developer API TTS model id used when a request names none — the core
 * catalog's default (`TTS_MODELS`), so the web form, the worker and this package
 * agree on one id. Selected via the URL path, NOT the request body.
 */
export const GEMINI_TTS_MODEL = DEFAULT_TTS_MODEL;

/**
 * TTS models that take per-turn `speech_metadata` parts instead of a
 * `SpeakerN:` transcript (see the 3.8 note at the top of this file).
 */
const SPEECH_METADATA_TTS_MODELS: ReadonlySet<string> = new Set([
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
]);

/** Whether `model` needs the per-turn `speech_metadata` request body. */
export function usesSpeechMetadata(model: string): boolean {
  return SPEECH_METADATA_TTS_MODELS.has(model);
}

/**
 * Default two-voice mapping for the dialogue, chosen from the Gemini Developer
 * API prebuilt voices. Mirrors the previous speaker identities so the A/B
 * comparison isolates engine naturalness rather than voice choice:
 * - 진행자1 (speaker 1) = Charon (informative)
 * - 진행자2 (speaker 2) = Leda (youthful)
 * The two speakers must map to two distinct voices.
 */
export const DEFAULT_DIALOGUE_VOICES: SpeakerVoiceMapping = {
  1: 'Charon',
  2: 'Leda',
};

/**
 * Gemini prebuilt voices by gender (per Google Cloud TTS docs' official Gender
 * column). Used to pick a random male+female pair per newscast. Zephyr is
 * officially female but perceptually androgynous, so it's left out of the pool to
 * keep the male/female contrast clear.
 */
export const MALE_DIALOGUE_VOICES: readonly string[] = [
  'Charon', 'Puck', 'Fenrir', 'Orus', 'Iapetus', 'Algieba', 'Algenib', 'Rasalgethi',
  'Achird', 'Alnilam', 'Schedar', 'Enceladus', 'Umbriel', 'Zubenelgenubi', 'Sadachbia', 'Sadaltager',
];
export const FEMALE_DIALOGUE_VOICES: readonly string[] = [
  'Leda', 'Kore', 'Aoede', 'Callirrhoe', 'Autonoe', 'Despina', 'Erinome', 'Laomedeia',
  'Achernar', 'Gacrux', 'Pulcherrima', 'Vindemiatrix', 'Sulafat',
];

/**
 * Pick a random male+female voice pair for the two hosts, randomizing which
 * speaker (1 or 2) gets which gender. Call ONCE per job (e.g. at job creation) and
 * thread the result through as speaker1Voice/speaker2Voice so it stays stable
 * across durable-step retries — do NOT call inside a Workflow step.
 */
export function pickRandomDialogueVoices(): { speaker1Voice: string; speaker2Voice: string } {
  const male = MALE_DIALOGUE_VOICES[Math.floor(Math.random() * MALE_DIALOGUE_VOICES.length)];
  const female = FEMALE_DIALOGUE_VOICES[Math.floor(Math.random() * FEMALE_DIALOGUE_VOICES.length)];
  return Math.random() < 0.5
    ? { speaker1Voice: male, speaker2Voice: female }
    : { speaker1Voice: female, speaker2Voice: male };
}

/**
 * Stable speaker label per speaker id. This exact string is used in BOTH the
 * transcript text (as a `Speaker1:` / `Speaker2:` line prefix) and the
 * `speaker` field of each `speakerVoiceConfig`; the API binds them by name.
 */
const SPEAKER_LABELS: Record<SpeakerId, string> = {
  1: 'Speaker1',
  2: 'Speaker2',
};

/**
 * Default Korean style-steering directive prepended to the transcript. Delivered
 * as the leading instruction line of the `contents` text, it nudges the model
 * toward a lively, natural two-host podcast delivery rather than a flat read.
 * The directive itself is interpreted, not spoken.
 */
export const DEFAULT_DIALOGUE_STYLE_PROMPT =
  '다음은 두 진행자 Speaker1과 Speaker2가 주고받는 한국어 IT 뉴스 팟캐스트 대화입니다. 생기 있고 자연스러운 구어체로, 서로 대화하듯 자연스럽게 읽어 주세요:';

/**
 * Style directive for the "그대로 읽기" (verbatim) newscast (design §3): the user's
 * own text, read out as written.
 *
 * {@link DEFAULT_DIALOGUE_STYLE_PROMPT} cannot be reused for it — that one asserts
 * a two-host CHAT, and a lively conversational register applied to a pasted
 * article (or to a single narrator reading straight through) makes the model
 * improvise the delivery of sentences the user chose deliberately. This directive
 * asks for the opposite: a calm, clear reading with no added performance. It stays
 * a SEPARATE constant rather than replacing the default, because the ordinary
 * LLM-written newscast is still a dialogue.
 *
 * Like every style directive it is interpreted, never spoken, and it works for one
 * speaker and for two — the transcript below it still carries whichever
 * `SpeakerN:` labels the script uses.
 */
export const VERBATIM_READING_STYLE_PROMPT =
  '다음은 한국어 뉴스 낭독 대본입니다. 과장 없이 차분하고 또렷한 낭독체로, 적힌 문장을 그대로 읽어 주세요:';

/**
 * The `speech_metadata.style` a 3.8 TTS model receives on every turn of an
 * ordinary newscast — the counterpart of {@link DEFAULT_DIALOGUE_STYLE_PROMPT}.
 * 3.8 speaks all of its text, so the delivery request cannot be an instruction
 * line; it is a short description of the voice the docs place in `style`.
 */
export const DIALOGUE_SPEECH_STYLE = '생기 있고 자연스러운 한국어 IT 뉴스 팟캐스트 진행자의 대화체';

/** The `speech_metadata.style` for a "그대로 읽기" newscast on a 3.8 TTS model. */
export const VERBATIM_SPEECH_STYLE = '과장 없이 차분하고 또렷한 한국어 뉴스 낭독체';

/**
 * Number of dialogue turns synthesized per Gemini TTS request. Kept small so each
 * request stays well within the 32k-token context window and so naturalness does
 * not drift over a long single render (docs recommend splitting long transcripts).
 */
export const DIALOGUE_CHUNK_SIZE = 8;

/**
 * Safety cap on the combined UTF-8 byte size of a chunk's dialogue text. Well
 * under the model's context window; used to flush a chunk early even before
 * {@link DIALOGUE_CHUNK_SIZE} turns accumulate, keeping each render short for
 * consistent quality. Korean glyphs are 3 bytes each in UTF-8.
 */
const MAX_CHUNK_DIALOGUE_BYTES = 3_500;

/** Base URL for the Gemini Developer API `generateContent` endpoint (model appended). */
const GENERATE_CONTENT_ENDPOINT_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

/** PCM audio format constants for the Gemini TTS output (signed 16-bit LE, mono). */
const DEFAULT_SAMPLE_RATE = 24_000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS_PER_SAMPLE = 16;

/** Shape of the JSON body returned by the generateContent endpoint (audio parts). */
interface GenerateContentResponseBody {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
      }>;
    };
  }>;
}

/** Raw synthesized audio for one dialogue chunk. */
export interface DialogueChunkAudio {
  /** Raw signed 16-bit LE PCM bytes, mono (NOT WAV — no header). */
  pcm: Uint8Array;
  /** Sample rate from the WAV header or the response mimeType (default 24000 Hz). */
  sampleRate: number;
}

export interface SynthesizeDialogueChunkOptions {
  /**
   * The Google credential, for the DIRECT path. Optional only because
   * {@link transport} replaces it: exactly one of the two must be present.
   */
  apiKey?: string;
  /**
   * Fulfil the TTS call elsewhere (the key vault) instead of holding a key —
   * the same seam the script package has, added because design §5.2 puts a
   * self-funded newscast's SPEECH on the caller's own Google key too. Speech is
   * the largest single cost in a newscast, so while this call had no way to reach
   * the vault, a job the trial gate had waved through as self-funded still spent
   * the operator's key for all of its audio.
   *
   * With a transport, no credential header is built here at all (the vault
   * injects its own) and no gateway is applied (the fulfiller owns its egress).
   */
  transport?: ProviderTransport;
  /** Ordered dialogue turns (mixed speakers) rendered in ONE request. */
  turns: ScriptLine[];
  /** Gemini TTS model id; defaults to {@link GEMINI_TTS_MODEL}. */
  model?: string;
  /** Prebuilt voice for speaker 1; defaults to DEFAULT_DIALOGUE_VOICES[1]. */
  speaker1Voice?: string;
  /** Prebuilt voice for speaker 2; defaults to DEFAULT_DIALOGUE_VOICES[2]. */
  speaker2Voice?: string;
  /**
   * Natural-language style directive for the legacy transcript models; defaults
   * to DEFAULT_DIALOGUE_STYLE_PROMPT. Ignored by 3.8 models (see `speechStyle`).
   */
  stylePrompt?: string;
  /**
   * `speech_metadata.style` for 3.8 models; defaults to DIALOGUE_SPEECH_STYLE.
   * Ignored by the legacy transcript models (see `stylePrompt`).
   */
  speechStyle?: string;
  /**
   * Optional Cloudflare AI Gateway routing (design 2026-07-29-ai-gateway-egress).
   * When omitted, the request goes straight to the Gemini Developer API's own
   * URL — today's behavior, unchanged. The worker builds this from its
   * environment and passes it down; this package never reads the environment
   * itself.
   */
  gateway?: AiGatewayConfiguration;
}

const SYNTHESIS_MAX_ATTEMPTS = 3;
// A multi-speaker chunk renders several turns of dialogue in a single call, so
// the audio-generation latency is far higher than a one-line request — 20s was
// too short and aborted mid-render. 120s per attempt comfortably covers an
// 8-turn chunk (3 attempts × 120s stays under the 10-minute TTS step timeout).
const SYNTHESIS_TIMEOUT_MS = 120_000;

/**
 * Split an ordered script into consecutive turn groups for per-chunk synthesis.
 *
 * A new chunk is started when either (a) the current chunk already holds
 * `chunkSize` turns, or (b) adding the next turn would push the chunk's combined
 * dialogue past {@link MAX_CHUNK_DIALOGUE_BYTES}. A single turn larger than the
 * byte budget still forms its own chunk (a speaker turn is never split). Turn
 * order across chunks is preserved, so concatenating the chunk audios reproduces
 * the full script in order.
 */
export function chunkScriptIntoTurnGroups(
  script: ScriptLine[],
  chunkSize: number = DIALOGUE_CHUNK_SIZE,
): ScriptLine[][] {
  const chunks: ScriptLine[][] = [];
  let current: ScriptLine[] = [];
  let currentBytes = 0;

  for (const line of script) {
    const lineBytes = utf8ByteLength(line.text);
    const wouldOverflowBytes =
      current.length > 0 && currentBytes + lineBytes > MAX_CHUNK_DIALOGUE_BYTES;
    const wouldOverflowCount = current.length >= chunkSize;
    if (wouldOverflowCount || wouldOverflowBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += lineBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Build the transcript text for a chunk: the style directive, a blank line, then
 * one `SpeakerN: <text>` line per turn. The literal speaker labels are required —
 * the API binds each label to a voice via `speakerVoiceConfigs`.
 */
function buildTranscript(turns: ScriptLine[], stylePrompt: string): string {
  const dialogue = turns
    .map((line) => `${SPEAKER_LABELS[line.speaker]}: ${line.text}`)
    .join('\n');
  return `${stylePrompt}\n\n${dialogue}`;
}

/**
 * The `contents` of a chunk request for the model family `model` belongs to:
 * one transcript part (directive + `SpeakerN:` lines) for the legacy models, or
 * one part per turn with `speech_metadata` for 3.8. A single-speaker chunk on
 * 3.8 omits `speaker` — it has no multi-speaker config to bind a name to.
 */
function buildContents(
  turns: ScriptLine[],
  model: string,
  stylePrompt: string,
  speechStyle: string,
): Array<Record<string, unknown>> {
  if (!usesSpeechMetadata(model)) {
    return [{ parts: [{ text: buildTranscript(turns, stylePrompt) }] }];
  }
  const isMultiSpeaker = speakersPresent(turns).length > 1;
  return [
    {
      role: 'user',
      parts: turns.map((line) => ({
        text: line.text,
        speech_metadata: isMultiSpeaker
          ? { speaker: SPEAKER_LABELS[line.speaker], style: speechStyle }
          : { style: speechStyle },
      })),
    },
  ];
}

/** Distinct speaker ids present in a chunk, in first-appearance order. */
function speakersPresent(turns: ScriptLine[]): SpeakerId[] {
  const seen = new Set<SpeakerId>();
  const order: SpeakerId[] = [];
  for (const line of turns) {
    if (!seen.has(line.speaker)) {
      seen.add(line.speaker);
      order.push(line.speaker);
    }
  }
  return order;
}

/**
 * Build the `speechConfig` for a chunk, picking the voice-config shape by how many
 * distinct speakers the chunk actually contains.
 *
 * The Gemini multi-speaker config requires EXACTLY two speaker voice configs
 * (`the number of enabled_voices must equal 2`). A chunk with only ONE speaker —
 * a monologue run, or a trailing odd turn left over by {@link chunkScriptIntoTurnGroups}
 * — therefore CANNOT use `multiSpeakerVoiceConfig`; it must fall back to the
 * SINGLE-speaker `voiceConfig` shape bound to that one speaker's voice. With both
 * speakers present we emit the multi-speaker config binding each label to its voice.
 */
function buildSpeechConfig(
  turns: ScriptLine[],
  voiceForSpeaker: Record<SpeakerId, string>,
): Record<string, unknown> {
  const present = speakersPresent(turns);
  if (present.length <= 1) {
    const speaker = present[0] ?? 1;
    return {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: voiceForSpeaker[speaker] },
      },
    };
  }
  return {
    multiSpeakerVoiceConfig: {
      speakerVoiceConfigs: present.map((speaker) => ({
        speaker: SPEAKER_LABELS[speaker],
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceForSpeaker[speaker] } },
      })),
    },
  };
}

/**
 * Synthesize ONE ordered, mixed-speaker dialogue chunk to raw PCM bytes via a
 * single Gemini Developer API multi-speaker `generateContent` request — on the
 * caller's own key through a {@link SynthesizeDialogueChunkOptions.transport},
 * or directly with `apiKey`.
 *
 * Only the speakers actually present in the chunk are declared in
 * `speakerVoiceConfigs`, matching the docs' rule that declared speaker names must
 * appear in the transcript. Time-bounded + retried like the legacy path: a
 * hung/rate-limited request (or the occasional TTS `500` documented for these
 * models) must not freeze the pipeline. Throws when the request fails after
 * retries or the response carries no inline audio.
 *
 * A REFUSED CREDENTIAL (401/403) breaks out of the retry loop immediately and is
 * thrown as {@link ProviderRequestError} (design §5.4): re-presenting a rejected
 * key is how a user's own Google account gets locked for credential stuffing, and
 * the status is what lets the pipeline end the job as `blocked_no_key` instead of
 * burning its durable-step retries on a key that will never work.
 */
export async function synthesizeDialogueChunk(
  options: SynthesizeDialogueChunkOptions,
): Promise<DialogueChunkAudio> {
  const {
    apiKey,
    transport,
    turns,
    model = GEMINI_TTS_MODEL,
    speaker1Voice = DEFAULT_DIALOGUE_VOICES[1],
    speaker2Voice = DEFAULT_DIALOGUE_VOICES[2],
    stylePrompt = DEFAULT_DIALOGUE_STYLE_PROMPT,
    speechStyle = DIALOGUE_SPEECH_STYLE,
    gateway,
  } = options;
  if (transport === undefined && (typeof apiKey !== 'string' || apiKey.length === 0)) {
    throw new Error('synthesizeDialogueChunk: apiKey is required.');
  }

  const voiceForSpeaker: Record<SpeakerId, string> = {
    1: speaker1Voice,
    2: speaker2Voice,
  };

  // AI Gateway egress (design 2026-07-29-ai-gateway-egress §2/§4): same
  // model/action suffix as the direct URL, routed through `google-ai-studio`
  // when a gateway is configured. `x-goog-api-key` (not `?key=`) is used in BOTH
  // modes so the key never lands in a URL or access log.
  const modelPath = `v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const requestUrl =
    gateway === undefined
      ? `${GENERATE_CONTENT_ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`
      : aiGatewayUrl(gateway, `google-ai-studio/${modelPath}`);
  const requestBody = JSON.stringify({
    contents: buildContents(turns, model, stylePrompt, speechStyle),
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: buildSpeechConfig(turns, voiceForSpeaker),
    },
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= SYNTHESIS_MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload =
        transport === undefined
          ? await requestDirectly(requestUrl, requestBody, apiKey ?? '', gateway)
          : await requestThroughTransport(transport, modelPath, requestBody);
      const audioPart = payload.candidates?.[0]?.content?.parts?.find(
        (part) => part.inlineData?.data !== undefined,
      );
      const data = audioPart?.inlineData?.data;
      if (data === undefined || data.length === 0) {
        throw new Error(
          'Gemini TTS response did not contain inline audio data.',
        );
      }

      return extractPcmAudio(decodeBase64ToBytes(data), audioPart?.inlineData?.mimeType);
    } catch (error) {
      lastError = error;
      if (isProviderCredentialRejection(error)) {
        // Terminal, not transient: two more attempts would only hammer the
        // account that just refused this key (design §5.4).
        break;
      }
      if (attempt < SYNTHESIS_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Gemini TTS request failed after retries.');
}

/** The direct path: this process holds the key and calls Google itself. */
async function requestDirectly(
  requestUrl: string,
  requestBody: string,
  apiKey: string,
  gateway?: AiGatewayConfiguration,
): Promise<GenerateContentResponseBody> {
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
      ...aiGatewayHeaders(gateway),
    },
    body: requestBody,
    signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Under BYOK a 401/403 here is routine and the Google body can echo the
    // offending key back — mask BEFORE truncating (a mid-key cut would otherwise
    // leave a usable prefix), since this message is persisted into the job's
    // failure record.
    const detail = redactAndTruncate(await response.text().catch(() => ''));
    throw new ProviderRequestError(
      `Gemini TTS request failed (${response.status} ${response.statusText}): ${detail}`,
      response.status,
    );
  }
  return (await response.json()) as GenerateContentResponseBody;
}

/**
 * The vault path: hand over a credential-free SPEC and let the fulfiller attach
 * the caller's key. No `x-goog-api-key`, no gateway headers, and a
 * provider-RELATIVE path — this package must not be able to name a host when
 * somebody else's credential is going to be attached to the request.
 */
async function requestThroughTransport(
  transport: ProviderTransport,
  modelPath: string,
  requestBody: string,
): Promise<GenerateContentResponseBody> {
  const response = await transport({
    path: modelPath,
    method: 'POST',
    body: requestBody,
    headers: { 'content-type': 'application/json' },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new ProviderRequestError(
      `Gemini TTS request failed (${response.status}): ${redactAndTruncate(response.body)}`,
      response.status,
    );
  }
  try {
    return JSON.parse(response.body) as GenerateContentResponseBody;
  } catch {
    throw new Error('Gemini TTS response was not valid JSON.');
  }
}

/** ASCII tag reader for the four-byte RIFF chunk ids. */
function readTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * Normalize one response's audio to raw PCM. The legacy models return headerless
 * PCM with the rate in the mimeType; 3.8 models return a complete WAV, whose
 * `fmt ` chunk holds the rate and whose `data` chunk holds the PCM. The check is
 * on the bytes (a leading `RIFF`…`WAVE`), not on the model id, so a model that
 * switches format still decodes. A RIFF file without a `data` chunk is refused
 * rather than passed through — its header bytes would play as a click.
 */
export function extractPcmAudio(bytes: Uint8Array, mimeType?: string): DialogueChunkAudio {
  const isWav = bytes.length >= 12 && readTag(bytes, 0) === 'RIFF' && readTag(bytes, 8) === 'WAVE';
  if (!isWav) {
    return { pcm: bytes, sampleRate: parseSampleRateFromMimeType(mimeType) };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = readTag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (tag === 'fmt ' && body + 8 <= bytes.length) {
      sampleRate = view.getUint32(body + 4, true);
    } else if (tag === 'data') {
      // A streamed WAV can carry a placeholder size; clamp to the bytes present.
      const end = Math.min(body + size, bytes.length);
      return { pcm: bytes.subarray(body, end), sampleRate };
    }
    // Chunks are word-aligned: an odd size is followed by one pad byte.
    offset = body + size + (size % 2);
  }
  throw new Error('Gemini TTS returned a WAV file with no data chunk.');
}

/**
 * Parse the PCM sample rate from an audio mimeType such as
 * `audio/L16;rate=24000` or `audio/L16;codec=pcm;rate=24000`. Falls back to
 * {@link DEFAULT_SAMPLE_RATE} when the mimeType is absent or has no `rate=`.
 */
export function parseSampleRateFromMimeType(mimeType?: string): number {
  if (mimeType === undefined || mimeType.length === 0) {
    return DEFAULT_SAMPLE_RATE;
  }
  const match = /rate=(\d+)/i.exec(mimeType);
  if (match === null) {
    return DEFAULT_SAMPLE_RATE;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_RATE;
}

/**
 * Wrap raw PCM bytes in a 44-byte canonical RIFF/WAVE header + `data` chunk,
 * producing a self-contained, browser-playable WAV (no ffmpeg). Defaults match
 * Gemini TTS output: 24000 Hz, mono, signed 16-bit little-endian.
 */
export function wrapPcmToWav(
  pcm: Uint8Array,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
  channels: number = AUDIO_CHANNELS,
  bitsPerSample: number = AUDIO_BITS_PER_SAMPLE,
): Uint8Array {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // ChunkSize = 36 + Subchunk2Size
  writeAscii(view, 8, 'WAVE');

  // "fmt " sub-chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size = 16 for PCM
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM, uncompressed)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // "data" sub-chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true); // Subchunk2Size

  const bytes = new Uint8Array(buffer);
  bytes.set(pcm, 44);
  return bytes;
}

/** Write an ASCII string into a DataView byte-by-byte (for 4-char RIFF tags). */
function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

/** UTF-8 byte length of a string (Korean glyphs are 3 bytes each). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Decode a base64 string (Gemini's `inlineData.data`) into raw PCM bytes. Uses
 * the platform `atob`, available in Workers, browsers, and Node under the
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
