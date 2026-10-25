/**
 * Word-level speech-to-text for the newscast caption-timing pipeline.
 *
 * The merge step already holds the final MP3 bytes in memory. To replace the
 * proportional per-line caption estimate with REAL timings, we transcribe that
 * MP3 and ask for word-level timestamps, then fuzzy-align the transcript to the
 * KNOWN script (see {@link ./align.ts}).
 *
 * MODEL CHOICE (verified against the OpenAI API docs, July 2026): word-level
 * timestamps are ONLY supported by the legacy `whisper-1` model, via
 * `response_format=verbose_json` + `timestamp_granularities[]=word`. The newer
 * `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` models are timing-blind (they
 * accept only `json` / `text` and never emit word or segment timestamps), so
 * `whisper-1` is used here. Its cost is negligible for a few minutes of audio.
 *
 * Runtime: the multipart body is built with the WHATWG `FormData` / `Blob`
 * available in the Cloudflare Workers runtime (nodejs_compat) and in Node — the
 * `Content-Type` boundary is set automatically, so it must NOT be set manually.
 */

import type {
  AiGatewayConfiguration,
  ProviderTransport,
} from '@audio-underview/newscast-core';
import {
  aiGatewayHeaders,
  aiGatewayUrl,
  redactAndTruncate,
} from '@audio-underview/newscast-core';

/** One transcribed word with its timing inside the audio. */
export interface TranscriptWord {
  /** The word text exactly as transcribed. */
  text: string;
  /** Word start offset in milliseconds. */
  startMs: number;
  /** Word end offset in milliseconds. */
  endMs: number;
}

/** Options for {@link transcribeWords}. */
export interface TranscribeOptions {
  /**
   * OpenAI API key (Bearer token), for the DIRECT path. Optional only because
   * {@link transport} replaces it; with neither, there is nothing to authenticate
   * with and the call degrades to no words at all.
   */
  apiKey?: string;
  /**
   * Fulfil the transcription elsewhere (the key vault) instead of holding a key,
   * so a self-funded job's alignment runs on the CALLER's OpenAI key (design
   * §5.2). This one call is why {@link ProviderRequestSpecification} grew a
   * `bodyBase64`: the request is `multipart/form-data` carrying MP3 bytes, and a
   * proxy that spoke only strings could not express it.
   */
  transport?: ProviderTransport;
  /** ISO-639-1 language hint; defaults to Korean (`'ko'`). */
  language?: string;
  /**
   * Optional Cloudflare AI Gateway routing (design 2026-07-29-ai-gateway-egress).
   * When omitted, the request goes straight to OpenAI's own URL — today's
   * behavior, unchanged. The worker builds this from its environment and passes
   * it down; this package never reads the environment itself.
   */
  gateway?: AiGatewayConfiguration;
  /** Optional external abort signal (combined with the per-attempt timeout). */
  signal?: AbortSignal;
}

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Per-attempt request timeout. Whisper word timestamps add some latency. */
const REQUEST_TIMEOUT_MS = 90_000;

/** Total attempts = 1 initial + 2 retries. */
const MAX_ATTEMPTS = 3;

/**
 * Character cap for the give-up console warning. The message already carries a
 * masked, capped provider body; this cap bounds the whole line so a pathological
 * error string cannot flood the log sink.
 */
const GIVING_UP_WARNING_MAXIMUM_LENGTH = 400;

/** The shape of the fields we read from Whisper's `verbose_json` response. */
interface VerboseJsonWord {
  word?: unknown;
  start?: unknown;
  end?: unknown;
}
interface VerboseJsonResponse {
  words?: VerboseJsonWord[];
}

/**
 * Transcribe MP3 audio into word-level timings via OpenAI `whisper-1`.
 *
 * Resilient by design: a 90s per-attempt timeout, up to 2 retries, and — on ANY
 * failure (network error, non-2xx status, malformed body) — an EMPTY array so
 * the caller can fall back to its proportional caption estimate. It never
 * throws.
 *
 * THE VAULT PATH TAKES EXACTLY ONE ATTEMPT. A proxied round trip is bounded by
 * the vault's own timeout rather than this function's, so three of them can
 * outlast the durable merge step that called us — and a step killed mid-flight is
 * retried, which would put a SECOND transcription of the same audio on the user's
 * bill while the first is still running. Alignment failing is harmless (the
 * caller keeps its estimate); paying twice for it is not.
 */
export async function transcribeWords(
  audio: Uint8Array,
  options: TranscribeOptions,
): Promise<TranscriptWord[]> {
  if (options.transport === undefined && (options.apiKey ?? '').length === 0) {
    // No credential of either kind: there is nothing to call with, and the
    // contract is to answer with no words rather than to throw.
    return [];
  }
  const maximumAttempts = options.transport === undefined ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await requestWords(audio, options);
    } catch (error) {
      const isLastAttempt = attempt === maximumAttempts;
      // External aborts are intentional — stop retrying immediately.
      if (options.signal?.aborted === true || isLastAttempt) {
        if (isLastAttempt) {
          // A bare console.warn bypasses the Logger's scrubber entirely, and the
          // worker logs at 100% head sampling — so mask here, at the last point
          // before the text reaches the sink.
          console.warn(
            redactAndTruncate(
              `transcribeWords: giving up after ${maximumAttempts} attempts: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              GIVING_UP_WARNING_MAXIMUM_LENGTH,
            ),
          );
        }
        return [];
      }
      // Brief linear backoff before the next attempt.
      await delay(attempt * 1_000, options.signal);
    }
  }
  return [];
}

/**
 * Provider-relative path of the transcription endpoint, for the vault path. Never
 * a URL: whoever attaches the credential owns the origin.
 */
const TRANSCRIPTION_PROVIDER_PATH = 'v1/audio/transcriptions';

/** One transcription attempt: build the multipart body, POST, parse words. */
async function requestWords(
  audio: Uint8Array,
  options: TranscribeOptions,
): Promise<TranscriptWord[]> {
  const form = new FormData();
  // Do NOT set Content-Type manually — FormData sets the multipart boundary.
  // Copy into a plain ArrayBuffer-backed view so the Blob part is well-typed: a
  // generic `Uint8Array<ArrayBufferLike>` is not assignable to `BlobPart`.
  const bytes = new Uint8Array(audio);
  form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', options.language ?? 'ko');

  const payload =
    options.transport === undefined
      ? await requestDirectly(form, options)
      : await requestThroughTransport(form, options.transport);
  const rawWords = Array.isArray(payload.words) ? payload.words : [];
  const words: TranscriptWord[] = [];
  for (const entry of rawWords) {
    const text = typeof entry.word === 'string' ? entry.word : '';
    const start = typeof entry.start === 'number' ? entry.start : Number.NaN;
    const end = typeof entry.end === 'number' ? entry.end : Number.NaN;
    if (text.length === 0 || !Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    // Whisper reports seconds; captions are milliseconds.
    words.push({
      text,
      startMs: Math.round(start * 1_000),
      endMs: Math.round(end * 1_000),
    });
  }
  return words;
}

/** The direct path: this process holds the key and calls OpenAI itself. */
async function requestDirectly(
  form: FormData,
  options: TranscribeOptions,
): Promise<VerboseJsonResponse> {
  // AI Gateway egress (design 2026-07-29-ai-gateway-egress §2): the multipart
  // body is untouched (Content-Type stays FormData's own boundary) — only the
  // URL and headers change.
  const requestUrl =
    options.gateway === undefined
      ? TRANSCRIPTION_URL
      : aiGatewayUrl(options.gateway, 'openai/audio/transcriptions');
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey ?? ''}`,
      ...aiGatewayHeaders(options.gateway),
    },
    body: form,
    signal: combineSignals(options.signal),
  });

  if (!response.ok) {
    // Under BYOK a 401 here is routine and OpenAI's body echoes the offending
    // key ("Incorrect API key provided: sk-proj-…"), so the body is masked and
    // capped BEFORE it enters the message — this error is mirrored to the
    // console below and persisted into the job's failure record.
    const detail = redactAndTruncate(await safeReadText(response));
    throw new Error(
      `Transcription request failed: ${response.status} ${response.statusText} ${detail}`.trim(),
    );
  }
  return (await response.json()) as VerboseJsonResponse;
}

/**
 * The vault path: serialize the multipart body to BYTES, hand them over base64 as
 * a credential-free spec, and let the fulfiller attach the caller's key.
 *
 * The `content-type` must travel with it — it carries FormData's own multipart
 * boundary, which is generated here and is unguessable to the fulfiller. This is
 * the one place a spec's `content-type` is load-bearing rather than decorative.
 */
async function requestThroughTransport(
  form: FormData,
  transport: ProviderTransport,
): Promise<VerboseJsonResponse> {
  // `Response` is the platform's own multipart serializer (Workers and Node
  // both), so the wire bytes are byte-identical to what `fetch(body: form)`
  // would have sent — no hand-rolled boundary writer to get wrong.
  const serialized = new Response(form);
  const contentType = serialized.headers.get('content-type');
  const body = new Uint8Array(await serialized.arrayBuffer());
  const response = await transport({
    path: TRANSCRIPTION_PROVIDER_PATH,
    method: 'POST',
    bodyBase64: encodeBytesToBase64(body),
    ...(contentType === null ? {} : { headers: { 'content-type': contentType } }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Transcription request failed: ${response.status} ${redactAndTruncate(response.body)}`.trim(),
    );
  }
  try {
    return JSON.parse(response.body) as VerboseJsonResponse;
  } catch {
    throw new Error('Transcription response was not valid JSON.');
  }
}

/**
 * How many bytes are converted to base64 per `String.fromCharCode` call. A whole
 * MP3 spread over one call blows the argument limit and throws
 * `RangeError: Maximum call stack size exceeded`, so the conversion walks the
 * buffer in slices.
 */
const BASE64_CHUNK_SIZE = 0x8000;

/** base64 for a binary body, chunked so a multi-megabyte MP3 survives it. */
function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

/**
 * Combine the caller's optional abort signal with a fresh 90s timeout signal so
 * either can cancel the request.
 */
function combineSignals(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return external === undefined ? timeout : AbortSignal.any([external, timeout]);
}

/**
 * Read a response body as text without ever throwing (best-effort diagnostics).
 * Deliberately un-truncated: the caller masks first and truncates after, so a
 * cut can never split a credential and leave a usable prefix behind.
 */
async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Resolve after `ms`, or immediately if the external signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
