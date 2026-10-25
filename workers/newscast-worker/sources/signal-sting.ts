import type { AiGatewayConfiguration } from '@audio-underview/newscast-core';
import {
  ProviderRequestError,
  aiGatewayHeaders,
  aiGatewayUrl,
  redactAndTruncate,
} from '@audio-underview/newscast-core';

/**
 * Per-newscast transition sting — the pure pieces of design §15's Lyria call.
 *
 * A multi-part newscast plays a short signal sound between parts. Rather than a
 * single fixed asset, each newscast gets a FRESH clip generated once at build
 * time via Google's Lyria music model (`lyria-3-clip-preview`), so every
 * broadcast's transition sounds a little different. The prompt below is fixed;
 * the audio varies with Lyria's own generation randomness.
 *
 * This module is deliberately free of the `cloudflare:workers` runtime graph and
 * of any I/O: it only builds the request descriptor, holds the fixed prompt, and
 * walks a response JSON tree for the inline audio. The vault call + R2 write
 * live in `workflow.ts` (the generate-signal step), so everything here stays
 * unit-testable without mocking a Worker environment.
 */

/**
 * Lyria clip model id (design §15). A fixed preview model — the sting is a short
 * generated clip, not a long composition.
 */
export const SIGNAL_STING_MODEL = 'lyria-3-clip-preview';

/**
 * Gemini Developer API `interactions` endpoint used for the Lyria clip request
 * (design §15). Note this is NOT the `models/<id>:generateContent` endpoint the
 * TTS path uses — Lyria clips go through `interactions` with a `{model, input}`
 * body.
 */
export const SIGNAL_STING_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * The fixed sting prompt. A short broadcast transition cue — an ascending
 * three-note bell chime over a warm pad with a reverb tail, purely instrumental
 * so it never competes with speech. Kept constant on purpose: the design wants
 * the SOUND to vary via Lyria's generation randomness, not the wording.
 */
export const SIGNAL_STING_PROMPT =
  'A short broadcast transition sting: a bright, three-note ascending bell chime ' +
  'over a warm synth pad, ending on a gentle reverb tail. Clean and uplifting, ' +
  'instrumental only, no vocals and no drums. About three seconds long.';

/** The request descriptor for the Lyria clip call — a pure value, so tests can assert it. */
export interface SignalStingRequest {
  url: string;
  init: RequestInit;
}

/** Options for {@link buildSignalStingRequest}. */
export interface SignalStingRequestOptions {
  /**
   * Optional Cloudflare AI Gateway routing (design 2026-07-29-ai-gateway-egress
   * §3). Absent (the default) keeps the direct Gemini Developer API URL.
   */
  gateway?: AiGatewayConfiguration;
}

/**
 * Build the Lyria clip request (design §15): POST the fixed prompt to the
 * `interactions` endpoint with the Gemini API key header. Pure — the caller
 * performs the call — so a test can assert the endpoint, header, and body
 * without a live network call. The workflow keeps only the path and the body of
 * it, for the vault to fulfil with the user's key.
 */
export function buildSignalStingRequest(
  apiKey: string,
  options: SignalStingRequestOptions = {},
): SignalStingRequest {
  const { gateway } = options;
  const url =
    gateway === undefined
      ? SIGNAL_STING_ENDPOINT
      // NOTE: the `interactions` path is non-standard for the gateway, so this
      // mapping is unverified (design §2 footnote) — untested against a live
      // gateway. Safe to try regardless: any failure here just skips the
      // (harmless) transition sting, so no special fallback is added.
      : aiGatewayUrl(gateway, 'google-ai-studio/v1beta/interactions');
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Same secret as the TTS path (design §15) — Lyria and Gemini TTS share
        // the one Gemini Developer API key. Unified on x-goog-api-key even
        // direct (design §4), so the gateway and direct paths share one header.
        'x-goog-api-key': apiKey,
        ...aiGatewayHeaders(gateway),
      },
      body: JSON.stringify({
        model: SIGNAL_STING_MODEL,
        input: SIGNAL_STING_PROMPT,
      }),
    },
  };
}

/**
 * Turn one Lyria answer into its parsed payload, or into the error the pipeline
 * can act on.
 *
 * Shared so every path obeys design §5.4 identically: a non-2xx becomes a
 * {@link ProviderRequestError} carrying the STATUS, which is what lets 401/403 be
 * recognized as a refused credential and end the step after ONE attempt. Without
 * the status the sting's two retries re-presented a rejected key to Google twice
 * more — the credential-stuffing pattern that gets a user's own account locked,
 * spent on the least important call in the pipeline.
 *
 * The body is masked and capped before it enters the message: Cloudflare
 * Workflows persists a failing step's message in its own engine storage, which no
 * sink of ours can reach back into, and a Lyria 401 body quotes the key it just
 * rejected.
 */
export function readSignalStingResponse(
  status: number,
  body: string,
  statusText?: string,
): unknown {
  if (status < 200 || status >= 300) {
    const label = statusText === undefined ? `${status}` : `${status} ${statusText}`;
    throw new ProviderRequestError(
      `Lyria signal request failed (${label}): ${redactAndTruncate(body)}`,
      status,
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('Lyria signal response was not valid JSON.');
  }
}

/**
 * The Lyria response shape is not a locked contract, so rather than hard-code a
 * path we walk the whole JSON tree for the first inline audio `data` field
 * (design §15). A field named `data` counts as the audio payload when it is a
 * non-empty string AND its object either carries an audio-looking mime type
 * (`mimeType` / `mime_type` / `contentType` starting with `audio`) or carries no
 * mime hint at all — a `data` explicitly typed as something non-audio (e.g.
 * `text/...`) is skipped so we never mistake metadata for the clip.
 */
function isAudioMimeType(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().startsWith('audio');
}

/** A `data`-bearing object's mime hint, or undefined when it declares none. */
function mimeHintOf(record: Record<string, unknown>): unknown {
  if ('mimeType' in record) {
    return record.mimeType;
  }
  if ('mime_type' in record) {
    return record.mime_type;
  }
  if ('contentType' in record) {
    return record.contentType;
  }
  return undefined;
}

/**
 * Walk a Lyria response payload (design §15) and return the base64 audio `data`
 * string, or `null` when the tree carries no inline audio. Depth-first,
 * order-preserving, so the first plausible audio field wins.
 *
 * Pure and I/O-free: `workflow.ts` decodes the returned base64 into bytes and
 * stores them in R2. Returning the base64 STRING (not decoded bytes) keeps this
 * function purely about tree-shape and leaves base64 decoding to
 * {@link decodeSignalAudioBytes}, so each concern is tested in isolation.
 */
export function extractSignalAudio(payload: unknown): string | null {
  // Arrays: search each element in order.
  if (Array.isArray(payload)) {
    for (const element of payload) {
      const found = extractSignalAudio(element);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;

  // This object itself may be the audio node: a non-empty string `data` whose
  // mime hint (when present) is audio.
  const data = record.data;
  if (typeof data === 'string' && data.length > 0) {
    const mimeHint = mimeHintOf(record);
    if (mimeHint === undefined || isAudioMimeType(mimeHint)) {
      return data;
    }
  }

  // Otherwise recurse into the object's values (skip the `data` we just rejected
  // as non-audio — it is a leaf string, so recursion would no-op anyway).
  for (const value of Object.values(record)) {
    const found = extractSignalAudio(value);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * Decode a base64 audio string (the `data` field extracted by
 * {@link extractSignalAudio}) into raw bytes for the R2 write. Uses the platform
 * `atob`, available in Workers, browsers, and Node — the same approach the TTS
 * package uses for Gemini's inline audio.
 */
export function decodeSignalAudioBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
