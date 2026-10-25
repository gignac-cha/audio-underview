import { describe, expect, it } from 'vitest';
import { ProviderRequestError } from '@audio-underview/newscast-core';

import {
  SIGNAL_STING_ENDPOINT,
  SIGNAL_STING_MODEL,
  SIGNAL_STING_PROMPT,
  buildSignalStingRequest,
  decodeSignalAudioBytes,
  extractSignalAudio,
  readSignalStingResponse,
} from '../sources/signal-sting.ts';
import { isProviderCredentialRejection } from '@audio-underview/newscast-script';

/** Base64 of the bytes [65, 66, 67] ("ABC") — a stand-in for the clip payload. */
const AUDIO_BASE64 = 'QUJD';

describe('buildSignalStingRequest (design §15)', () => {
  it('POSTs the fixed prompt to the interactions endpoint with the Gemini key header', () => {
    const { url, init } = buildSignalStingRequest('secret-key');
    expect(url).toBe(SIGNAL_STING_ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('secret-key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: SIGNAL_STING_MODEL, input: SIGNAL_STING_PROMPT });
  });

  it('uses the Lyria clip model, not the TTS generateContent endpoint', () => {
    expect(SIGNAL_STING_MODEL).toBe('lyria-3-clip-preview');
    expect(SIGNAL_STING_ENDPOINT).toContain('/interactions');
  });
});

describe('readSignalStingResponse (design §5.4)', () => {
  it('parses a 2xx body into the payload the audio walker reads', () => {
    expect(readSignalStingResponse(200, JSON.stringify({ data: AUDIO_BASE64 }))).toEqual({
      data: AUDIO_BASE64,
    });
  });

  it('turns a REFUSED credential into a status-carrying error, from either path', () => {
    // The sting has two retries. Without the status, a 401 read as an ordinary
    // failure and the user's own Google key was presented to Google twice more —
    // the credential-stuffing pattern §5.4 exists to prevent — over a sound the
    // newscast does not need.
    for (const status of [401, 403]) {
      const error = (() => {
        try {
          readSignalStingResponse(status, '{"error":"invalid key"}');
          return null;
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect((error as ProviderRequestError).status).toBe(status);
      expect(isProviderCredentialRejection(error)).toBe(true);
    }
  });

  it('masks a provider body that quotes the key it rejected', () => {
    const leaked = 'AIzaSyD-1234567890abcdefgHIJKLmnop';
    const message = (() => {
      try {
        readSignalStingResponse(400, `API key not valid: ${leaked}`, 'Bad Request');
        return '';
      } catch (thrown) {
        return (thrown as Error).message;
      }
    })();
    expect(message).not.toContain(leaked);
    expect(message).toContain('AIza[REDACTED]');
    expect(message).toContain('400 Bad Request');
  });

  it('reports a transient status as a NON-credential failure so the retry still applies', () => {
    const error = (() => {
      try {
        readSignalStingResponse(503, 'overloaded');
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(isProviderCredentialRejection(error)).toBe(false);
  });

  it('rejects a 2xx body that is not JSON', () => {
    expect(() => readSignalStingResponse(200, '<html>nope</html>')).toThrow(/not valid JSON/);
  });
});

describe('buildSignalStingRequest gateway routing (design 2026-07-29-ai-gateway-egress)', () => {
  it('keeps the direct Gemini URL and no cf-aig-authorization header when no gateway is configured', () => {
    const { url, init } = buildSignalStingRequest('secret-key');
    expect(url).toBe(SIGNAL_STING_ENDPOINT);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('secret-key');
    expect(headers['cf-aig-authorization']).toBeUndefined();
  });

  it('routes through the gateway with the google-ai-studio/v1beta/interactions suffix when configured', () => {
    const { url } = buildSignalStingRequest('secret-key', {
      gateway: { baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw' },
    });
    expect(url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/interactions',
    );
  });

  it('keeps x-goog-api-key auth through the gateway and adds cf-aig-authorization only when a token is set', () => {
    const { init: withoutToken } = buildSignalStingRequest('secret-key', {
      gateway: { baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw' },
    });
    const headersWithoutToken = withoutToken.headers as Record<string, string>;
    expect(headersWithoutToken['x-goog-api-key']).toBe('secret-key');
    expect(headersWithoutToken['cf-aig-authorization']).toBeUndefined();

    const { init: withToken } = buildSignalStingRequest('secret-key', {
      gateway: { baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw', token: 'gw-token' },
    });
    const headersWithToken = withToken.headers as Record<string, string>;
    expect(headersWithToken['x-goog-api-key']).toBe('secret-key');
    expect(headersWithToken['cf-aig-authorization']).toBe('Bearer gw-token');
  });
});

describe('extractSignalAudio (design §15)', () => {
  it('returns the base64 `data` field from a valid audio payload', () => {
    const payload = { output: { audio: { data: AUDIO_BASE64, mimeType: 'audio/mp3' } } };
    expect(extractSignalAudio(payload)).toBe(AUDIO_BASE64);
  });

  it('finds the `data` field however deeply it is nested, through arrays', () => {
    // A Gemini generateContent-style tree: the audio sits under
    // candidates[].content.parts[].inlineData.data.
    const nested = {
      candidates: [
        { content: { parts: [{ text: '...' }, { inlineData: { data: AUDIO_BASE64, mimeType: 'audio/mpeg' } }] } },
      ],
    };
    expect(extractSignalAudio(nested)).toBe(AUDIO_BASE64);
  });

  it('accepts a bare `data` string with no mime hint at all', () => {
    expect(extractSignalAudio({ result: { clip: { data: AUDIO_BASE64 } } })).toBe(
      AUDIO_BASE64,
    );
  });

  it('returns null when the tree carries no inline audio', () => {
    expect(extractSignalAudio({ status: 'ok', output: {} })).toBeNull();
    expect(extractSignalAudio(null)).toBeNull();
    expect(extractSignalAudio('just a string')).toBeNull();
    expect(extractSignalAudio([])).toBeNull();
  });

  it('skips a `data` field explicitly typed as non-audio (metadata, not the clip)', () => {
    const payload = { meta: { data: 'eyJhIjoxfQ==', mimeType: 'application/json' } };
    expect(extractSignalAudio(payload)).toBeNull();
  });

  it('ignores an empty `data` string', () => {
    expect(extractSignalAudio({ audio: { data: '', mimeType: 'audio/mp3' } })).toBeNull();
  });
});

describe('decodeSignalAudioBytes', () => {
  it('base64-decodes the extracted `data` into raw bytes', () => {
    expect(Array.from(decodeSignalAudioBytes(AUDIO_BASE64))).toEqual([65, 66, 67]);
  });
});
