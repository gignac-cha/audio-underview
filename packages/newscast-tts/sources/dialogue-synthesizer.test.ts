import type {
  ProviderRequestSpecification,
  ScriptLine,
} from '@audio-underview/newscast-core';
import { ProviderRequestError } from '@audio-underview/newscast-core';
import {
  DEFAULT_DIALOGUE_STYLE_PROMPT,
  DEFAULT_DIALOGUE_VOICES,
  DIALOGUE_CHUNK_SIZE,
  DIALOGUE_SPEECH_STYLE,
  GEMINI_TTS_MODEL,
  VERBATIM_READING_STYLE_PROMPT,
  VERBATIM_SPEECH_STYLE,
  chunkScriptIntoTurnGroups,
  extractPcmAudio,
  parseSampleRateFromMimeType,
  synthesizeDialogueChunk,
  usesSpeechMetadata,
  wrapPcmToWav,
} from './dialogue-synthesizer.ts';

/** Build a base64 string from raw bytes (mirrors Gemini's inlineData.data field). */
function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * A fake generateContent `Response` carrying inline audio, good enough for
 * `fetch` mocking.
 */
function audioResponse(
  base64: string | undefined,
  mimeType = 'audio/L16;rate=24000',
): Response {
  const inlineData =
    base64 === undefined ? undefined : { data: base64, mimeType };
  return jsonResponse({
    candidates: [{ content: { parts: [{ inlineData }] } }],
  });
}

/** A fake JSON `Response` good enough for `fetch` mocking. */
function jsonResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number },
): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DEFAULT_DIALOGUE_VOICES', () => {
  test('maps the two hosts to two distinct Gemini TTS prebuilt voices', () => {
    expect(DEFAULT_DIALOGUE_VOICES[1]).toBe('Charon');
    expect(DEFAULT_DIALOGUE_VOICES[2]).toBe('Leda');
    expect(DEFAULT_DIALOGUE_VOICES[1]).not.toBe(DEFAULT_DIALOGUE_VOICES[2]);
  });
});

describe('chunkScriptIntoTurnGroups', () => {
  const line = (speaker: 1 | 2, text: string): ScriptLine => ({ speaker, text });

  test('groups turns into chunks of at most the requested size, preserving order', () => {
    const script: ScriptLine[] = Array.from({ length: 19 }, (_unused, index) =>
      line(index % 2 === 0 ? 1 : 2, `줄 ${index}`),
    );

    const chunks = chunkScriptIntoTurnGroups(script);

    expect(chunks).toHaveLength(Math.ceil(19 / DIALOGUE_CHUNK_SIZE));
    expect(chunks[0]).toHaveLength(DIALOGUE_CHUNK_SIZE);
    const flattened = chunks.flat();
    expect(flattened).toHaveLength(19);
    expect(flattened.map((turn) => turn.text)).toEqual(
      script.map((turn) => turn.text),
    );
  });

  test('flushes early when combined dialogue bytes would exceed the limit', () => {
    const huge = '가'.repeat(1_400); // ~4,200 UTF-8 bytes, over the 3,500 cap
    const chunks = chunkScriptIntoTurnGroups([line(1, huge), line(2, huge)]);
    expect(chunks).toHaveLength(2);
  });
});

describe('synthesizeDialogueChunk', () => {
  const turns: ScriptLine[] = [
    { speaker: 1, text: '안녕하세요, 오늘 소식입니다.' },
    { speaker: 2, text: '네, 시작해 볼까요?' },
  ];

  test('POSTs one multi-speaker generateContent request and returns raw PCM + rate', async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(audioResponse(encodeBytesToBase64(audioBytes)));
    vi.stubGlobal('fetch', fetchMock);

    const result = await synthesizeDialogueChunk({ apiKey: 'secret-key', turns });

    expect(result.pcm).toEqual(audioBytes);
    expect(result.sampleRate).toBe(24_000);

    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
    );
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers['x-goog-api-key']).toBe('secret-key');

    const body = JSON.parse(requestInit.body as string);
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);

    // The transcript text must literally contain the speaker labels.
    const text = body.contents[0].parts[0].text as string;
    expect(text).toContain('Speaker1: 안녕하세요, 오늘 소식입니다.');
    expect(text).toContain('Speaker2: 네, 시작해 볼까요?');

    const configs =
      body.generationConfig.speechConfig.multiSpeakerVoiceConfig
        .speakerVoiceConfigs;
    expect(configs).toEqual([
      {
        speaker: 'Speaker1',
        voiceConfig: { prebuiltVoiceConfig: { voiceName: DEFAULT_DIALOGUE_VOICES[1] } },
      },
      {
        speaker: 'Speaker2',
        voiceConfig: { prebuiltVoiceConfig: { voiceName: DEFAULT_DIALOGUE_VOICES[2] } },
      },
    ]);
  });

  test('honours custom voices, model, and prompt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([9]))));
    vi.stubGlobal('fetch', fetchMock);

    await synthesizeDialogueChunk({
      apiKey: 'k',
      turns,
      model: 'gemini-2.5-pro-preview-tts',
      speaker1Voice: 'Puck',
      speaker2Voice: 'Kore',
      stylePrompt: '차분하게',
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro-preview-tts:generateContent',
    );
    const body = JSON.parse(requestInit.body as string);
    expect(body.contents[0].parts[0].text).toContain('차분하게');
    expect(
      body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs.map(
        (config: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } }) =>
          config.voiceConfig.prebuiltVoiceConfig.voiceName,
      ),
    ).toEqual(['Puck', 'Kore']);
  });

  test('uses a single-speaker voiceConfig (not multiSpeaker) when only one speaker is present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
    vi.stubGlobal('fetch', fetchMock);

    await synthesizeDialogueChunk({
      apiKey: 'k',
      turns: [{ speaker: 1, text: '혼자 말합니다.' }],
      speaker1Voice: 'Puck',
      speaker2Voice: 'Kore',
    });

    const speechConfig = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      .generationConfig.speechConfig;
    // A single-speaker chunk must NOT use multiSpeakerVoiceConfig — Gemini rejects
    // that with "the number of enabled_voices must equal 2". It must fall back to
    // the single-speaker voiceConfig shape bound to that speaker's voice.
    expect(speechConfig.multiSpeakerVoiceConfig).toBeUndefined();
    expect(speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck');
  });

  describe('VERBATIM_READING_STYLE_PROMPT (verbatim design §3)', () => {
    test('stays a separate directive — the default still presumes a two-host chat', () => {
      // The default must not be repurposed: it asserts a conversation between two
      // hosts, which is exactly wrong for a script the user wrote to be read out.
      expect(VERBATIM_READING_STYLE_PROMPT).not.toBe(DEFAULT_DIALOGUE_STYLE_PROMPT);
      expect(DEFAULT_DIALOGUE_STYLE_PROMPT).toContain('두 진행자');
      expect(VERBATIM_READING_STYLE_PROMPT).toContain('낭독');
    });

    test('leads a single-narrator chunk, which still takes the single-speaker voiceConfig', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
      vi.stubGlobal('fetch', fetchMock);

      // An entirely unprefixed verbatim paste parses to speaker 1 throughout, so
      // the reading directive and the one-voice fallback have to work together.
      await synthesizeDialogueChunk({
        apiKey: 'k',
        turns: [
          { speaker: 1, text: '첫 문장입니다.' },
          { speaker: 1, text: '둘째 문장입니다.' },
        ],
        speaker1Voice: 'Puck',
        speaker2Voice: 'Kore',
        stylePrompt: VERBATIM_READING_STYLE_PROMPT,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const text = body.contents[0].parts[0].text as string;
      expect(text.startsWith(VERBATIM_READING_STYLE_PROMPT)).toBe(true);
      // The user's sentences reach the model unchanged, one labelled line each.
      expect(text).toContain('Speaker1: 첫 문장입니다.');
      expect(text).toContain('Speaker1: 둘째 문장입니다.');
      expect(text).not.toContain('Speaker2:');
      expect(body.generationConfig.speechConfig.multiSpeakerVoiceConfig).toBeUndefined();
      expect(
        body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
      ).toBe('Puck');
    });

    test('reads a two-speaker verbatim chunk with the multi-speaker config', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
      vi.stubGlobal('fetch', fetchMock);

      await synthesizeDialogueChunk({
        apiKey: 'k',
        turns,
        stylePrompt: VERBATIM_READING_STYLE_PROMPT,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      // The synthesis paths themselves are reused unchanged; only the directive
      // above the transcript differs.
      expect(
        body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs,
      ).toHaveLength(2);
      expect(body.contents[0].parts[0].text).toContain(VERBATIM_READING_STYLE_PROMPT);
    });
  });

  test('keeps the multi-speaker config when both speakers are present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
    vi.stubGlobal('fetch', fetchMock);

    await synthesizeDialogueChunk({ apiKey: 'k', turns });

    const speechConfig = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      .generationConfig.speechConfig;
    expect(speechConfig.voiceConfig).toBeUndefined();
    expect(
      speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs,
    ).toHaveLength(2);
  });

  test('parses a non-default sample rate from the response mimeType', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        audioResponse(encodeBytesToBase64(new Uint8Array([1, 2])), 'audio/L16;rate=16000'),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await synthesizeDialogueChunk({ apiKey: 'k', turns });
    expect(result.sampleRate).toBe(16_000);
  });

  test('throws when the request is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse('quota exceeded', { ok: false, status: 429 }),
        ),
    );

    await expect(
      synthesizeDialogueChunk({ apiKey: 'k', turns }),
    ).rejects.toThrow(/429/);
  });

  test('throws when the response has no inline audio data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(audioResponse(undefined)));

    await expect(
      synthesizeDialogueChunk({ apiKey: 'k', turns }),
    ).rejects.toThrow(/inline audio/);
  });

  // The thrown message is persisted into the job's failure record, so a Google
  // body echoing the user's own key must never survive into it
  // (design 2026-08-10-per-user-provider-keys §1.3).
  test('masks provider credentials quoted back in a failed response body', async () => {
    const leakedKey = 'AIzaSyD-1234567890abcdefgHIJKLmnop';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          `API key not valid: ${leakedKey} for org-9dF2kQwErTyUiOpA with token ya29.a0AfB_byC1234567890`,
          { ok: false, status: 400 },
        ),
      ),
    );

    const message = await synthesizeDialogueChunk({ apiKey: 'k', turns }).then(
      () => {
        throw new Error('expected the synthesis to fail');
      },
      (error: unknown) => (error as Error).message,
    );
    expect(message).not.toContain(leakedKey);
    expect(message).not.toContain('org-9dF2kQwErTyUiOpA');
    expect(message).not.toContain('ya29.a0AfB');
    expect(message).toContain('AIza[REDACTED]');
    expect(message).toContain('org-[REDACTED]');
    expect(message).toContain('ya29.[REDACTED]');
    // The status still carries the diagnosis.
    expect(message).toContain('400');
  });

  test('caps a huge error body instead of embedding it whole', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse('z'.repeat(10_000), { ok: false, status: 502 })),
    );

    const message = await synthesizeDialogueChunk({ apiKey: 'k', turns }).then(
      () => {
        throw new Error('expected the synthesis to fail');
      },
      (error: unknown) => (error as Error).message,
    );
    expect(message.length).toBeLessThan(300);
    expect(message).toContain('… [truncated]');
  });

  // The seam design §5.2 needs: a self-funded newscast's SPEECH — its largest
  // single cost — runs on the caller's own Google key, fulfilled inside the vault.
  describe('transport injection (per-user-provider-keys design §5.1/§5.2)', () => {
    /** A transport that records the spec it is handed and replies with audio. */
    function recordingTransport(
      reply: (request: ProviderRequestSpecification) => { status: number; body: string },
    ): { transport: (request: ProviderRequestSpecification) => Promise<{ status: number; body: string }>; seen: ProviderRequestSpecification[] } {
      const seen: ProviderRequestSpecification[] = [];
      return {
        seen,
        transport: async (request) => {
          seen.push(request);
          return reply(request);
        },
      };
    }

    const audioPayload = (base64: string): string =>
      JSON.stringify({
        candidates: [
          { content: { parts: [{ inlineData: { data: base64, mimeType: 'audio/L16;rate=24000' } }] } },
        ],
      });

    test('sends a credential-free, provider-RELATIVE spec and never touches fetch', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const bytes = new Uint8Array([7, 8, 9]);
      const { transport, seen } = recordingTransport(() => ({
        status: 200,
        body: audioPayload(encodeBytesToBase64(bytes)),
      }));

      const result = await synthesizeDialogueChunk({ transport, turns });

      expect(result.pcm).toEqual(bytes);
      expect(result.sampleRate).toBe(24_000);
      // The vault owns the origin AND the credential: no host, no key, no
      // gateway header may ride along in the spec.
      expect(seen).toHaveLength(1);
      expect(seen[0].path).toBe(`v1beta/models/${GEMINI_TTS_MODEL}:generateContent`);
      expect(seen[0].path).not.toContain('://');
      expect(seen[0].headers).toEqual({ 'content-type': 'application/json' });
      expect(JSON.stringify(seen[0])).not.toContain('x-goog-api-key');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('carries the same transcript and speech config as the direct path', async () => {
      const { transport, seen } = recordingTransport(() => ({
        status: 200,
        body: audioPayload(encodeBytesToBase64(new Uint8Array([1]))),
      }));

      await synthesizeDialogueChunk({
        transport,
        turns,
        speaker1Voice: 'Puck',
        speaker2Voice: 'Kore',
      });

      const body = JSON.parse(seen[0].body ?? '{}');
      expect(body.contents[0].parts[0].text).toContain('Speaker1: 안녕하세요, 오늘 소식입니다.');
      expect(
        body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs.map(
          (config: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } }) =>
            config.voiceConfig.prebuiltVoiceConfig.voiceName,
        ),
      ).toEqual(['Puck', 'Kore']);
    });

    test('a REFUSED key is thrown with its status and NOT retried (design §5.4)', async () => {
      let attempts = 0;
      const transport = async (): Promise<{ status: number; body: string }> => {
        attempts += 1;
        return {
          status: 403,
          body: '{"error":{"message":"API key not valid: AIzaSyD-1234567890abcdefg"}}',
        };
      };

      const error = await synthesizeDialogueChunk({ transport, turns }).then(
        () => {
          throw new Error('expected the synthesis to fail');
        },
        (thrown: unknown) => thrown,
      );

      // Re-presenting a rejected key is how the USER's own Google account gets
      // locked for credential stuffing, so the two remaining attempts must not run.
      expect(attempts).toBe(1);
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect((error as ProviderRequestError).status).toBe(403);
      expect((error as Error).message).not.toContain('AIzaSyD-1234567890abcdefg');
      expect((error as Error).message).toContain('AIza[REDACTED]');
    });

    test('a transient status still gets the full retry budget', async () => {
      let attempts = 0;
      const transport = async (): Promise<{ status: number; body: string }> => {
        attempts += 1;
        return attempts < 3
          ? { status: 503, body: 'overloaded' }
          : { status: 200, body: audioPayload(encodeBytesToBase64(new Uint8Array([4]))) };
      };

      const result = await synthesizeDialogueChunk({ transport, turns });
      expect(attempts).toBe(3);
      expect(result.pcm).toEqual(new Uint8Array([4]));
    });

    test('refuses to run with neither a key nor a transport', async () => {
      await expect(synthesizeDialogueChunk({ turns })).rejects.toThrow(/apiKey is required/);
    });

    test('a direct-path refusal also carries its status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse('invalid key', { ok: false, status: 401 })),
      );
      const error = await synthesizeDialogueChunk({ apiKey: 'k', turns }).then(
        () => {
          throw new Error('expected the synthesis to fail');
        },
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect((error as ProviderRequestError).status).toBe(401);
    });
  });

  describe('AI Gateway routing (design 2026-07-29-ai-gateway-egress)', () => {
    const SAMPLE_GATEWAY = { baseUrl: 'https://gateway.ai.cloudflare.com/v1/acc/gw' };

    test('REGRESSION: with no gateway configured, hits the direct URL with no ?key= and the x-goog-api-key header', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
      vi.stubGlobal('fetch', fetchMock);

      await synthesizeDialogueChunk({ apiKey: 'secret-key', turns });

      const [requestUrl, requestInit] = fetchMock.mock.calls[0];
      expect(requestUrl).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
      );
      expect(requestUrl).not.toContain('key=');
      expect(requestInit.headers['x-goog-api-key']).toBe('secret-key');
      expect(requestInit.headers['cf-aig-authorization']).toBeUndefined();
    });

    test('routes through the gateway via google-ai-studio, reusing the model/action suffix', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
      vi.stubGlobal('fetch', fetchMock);

      await synthesizeDialogueChunk({ apiKey: 'k', turns, gateway: SAMPLE_GATEWAY });

      const [requestUrl] = fetchMock.mock.calls[0];
      expect(requestUrl).toBe(
        `https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
      );
    });

    test('normalizes a trailing slash on the gateway baseUrl so no // appears in the URL', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
      vi.stubGlobal('fetch', fetchMock);

      await synthesizeDialogueChunk({
        apiKey: 'k',
        turns,
        gateway: { baseUrl: 'https://gateway.ai.cloudflare.com/v1/acc/gw/' },
      });

      const [requestUrl] = fetchMock.mock.calls[0];
      expect(requestUrl).toBe(
        `https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
      );
      expect(requestUrl).not.toContain('//google-ai-studio');
    });

    test('adds cf-aig-authorization only when the gateway carries a token', async () => {
      const withToken = vi
        .fn()
        .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
      vi.stubGlobal('fetch', withToken);
      await synthesizeDialogueChunk({
        apiKey: 'k',
        turns,
        gateway: { ...SAMPLE_GATEWAY, token: 'gw-token' },
      });
      expect(withToken.mock.calls[0][1].headers['cf-aig-authorization']).toBe(
        'Bearer gw-token',
      );
      vi.unstubAllGlobals();

      const withoutToken = vi
        .fn()
        .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
      vi.stubGlobal('fetch', withoutToken);
      await synthesizeDialogueChunk({ apiKey: 'k', turns, gateway: SAMPLE_GATEWAY });
      expect(withoutToken.mock.calls[0][1].headers['cf-aig-authorization']).toBeUndefined();
    });

    test('Google auth stays on the x-goog-api-key header (no ?key=) in gateway mode too', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
      vi.stubGlobal('fetch', fetchMock);

      await synthesizeDialogueChunk({
        apiKey: 'secret-key',
        turns,
        gateway: SAMPLE_GATEWAY,
      });

      const [requestUrl, requestInit] = fetchMock.mock.calls[0];
      expect(requestUrl).not.toContain('key=');
      expect(requestInit.headers['x-goog-api-key']).toBe('secret-key');
    });
  });
});

describe('parseSampleRateFromMimeType', () => {
  test('parses the rate parameter, defaulting to 24000', () => {
    expect(parseSampleRateFromMimeType('audio/L16;rate=24000')).toBe(24_000);
    expect(parseSampleRateFromMimeType('audio/L16;codec=pcm;rate=48000')).toBe(48_000);
    expect(parseSampleRateFromMimeType(undefined)).toBe(24_000);
    expect(parseSampleRateFromMimeType('audio/L16')).toBe(24_000);
  });
});

describe('wrapPcmToWav', () => {
  test('prepends a valid 44-byte RIFF/WAVE header describing the PCM', () => {
    const pcm = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    const wav = wrapPcmToWav(pcm, 24_000, 1, 16);

    expect(wav).toHaveLength(44 + pcm.length);

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (offset: number, length: number): string =>
      String.fromCharCode(
        ...Array.from({ length }, (_unused, i) => view.getUint8(offset + i)),
      );

    expect(ascii(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + pcm.length); // ChunkSize
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // Subchunk1Size (PCM)
    expect(view.getUint16(20, true)).toBe(1); // AudioFormat = PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(24_000); // sampleRate
    expect(view.getUint32(28, true)).toBe(24_000 * 1 * 2); // byteRate
    expect(view.getUint16(32, true)).toBe(2); // blockAlign
    expect(view.getUint16(34, true)).toBe(16); // bitsPerSample
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(pcm.length); // Subchunk2Size

    // The raw PCM follows the header verbatim.
    expect(wav.slice(44)).toEqual(pcm);
  });
});

describe('Gemini 3.8 TTS request and response shape (verified live 2026-09-29)', () => {
  const turns: ScriptLine[] = [
    { speaker: 1, text: '안녕하세요, 오늘 소식입니다.' },
    { speaker: 2, text: '네, 시작해 볼까요?' },
  ];

  test('only the 3.8 models take speech_metadata parts', () => {
    expect(usesSpeechMetadata('gemini-3.8-flash-tts')).toBe(true);
    expect(usesSpeechMetadata('gemini-3.8-flash-lite-tts')).toBe(true);
    expect(usesSpeechMetadata(GEMINI_TTS_MODEL)).toBe(false);
    expect(usesSpeechMetadata('gemini-3.1-flash-tts-preview')).toBe(false);
  });

  test('sends one part per turn with speaker + style metadata and no spoken directive', async () => {
    const pcm = new Uint8Array([7, 8, 9, 10]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(audioResponse(encodeBytesToBase64(wrapPcmToWav(pcm, 24_000)), 'audio/wav'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await synthesizeDialogueChunk({ apiKey: 'k', turns, model: 'gemini-3.8-flash-tts' });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent',
    );
    const body = JSON.parse(requestInit.body as string);
    // 3.8 answers 400 unless every part names its speaker in speech_metadata.
    expect(body.contents[0].parts).toEqual([
      { text: '안녕하세요, 오늘 소식입니다.', speech_metadata: { speaker: 'Speaker1', style: DIALOGUE_SPEECH_STYLE } },
      { text: '네, 시작해 볼까요?', speech_metadata: { speaker: 'Speaker2', style: DIALOGUE_SPEECH_STYLE } },
    ]);
    // 3.8 speaks every character of its text, so no directive line may ride along.
    expect(JSON.stringify(body.contents)).not.toContain(DEFAULT_DIALOGUE_STYLE_PROMPT);
    expect(body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs).toHaveLength(2);
    // The WAV header is stripped: callers concatenate raw PCM.
    expect(result.pcm).toEqual(pcm);
    expect(result.sampleRate).toBe(24_000);
  });

  test('a single-speaker 3.8 chunk carries style only and the caller-chosen speech style', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(audioResponse(encodeBytesToBase64(wrapPcmToWav(new Uint8Array([1, 2]))), 'audio/wav'));
    vi.stubGlobal('fetch', fetchMock);

    await synthesizeDialogueChunk({
      apiKey: 'k',
      turns: [{ speaker: 1, text: '혼자 읽습니다.' }],
      model: 'gemini-3.8-flash-lite-tts',
      speechStyle: VERBATIM_SPEECH_STYLE,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.contents[0].parts).toEqual([
      { text: '혼자 읽습니다.', speech_metadata: { style: VERBATIM_SPEECH_STYLE } },
    ]);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      DEFAULT_DIALOGUE_VOICES[1],
    );
  });

  test('the legacy models keep the single SpeakerN transcript part', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(audioResponse(encodeBytesToBase64(new Uint8Array([1]))));
    vi.stubGlobal('fetch', fetchMock);

    await synthesizeDialogueChunk({ apiKey: 'k', turns, model: 'gemini-3.1-flash-tts-preview' });

    const parts = JSON.parse(fetchMock.mock.calls[0][1].body as string).contents[0].parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].speech_metadata).toBeUndefined();
    expect(parts[0].text).toContain('Speaker2: 네, 시작해 볼까요?');
  });
});

describe('extractPcmAudio', () => {
  test('passes headerless PCM through with the mimeType rate', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(extractPcmAudio(bytes, 'audio/l16; rate=24000; channels=1')).toEqual({
      pcm: bytes,
      sampleRate: 24_000,
    });
  });

  test('reads the rate from the fmt chunk and skips chunks before data, including odd padding', () => {
    const pcm = new Uint8Array([5, 6, 7, 8]);
    const plain = wrapPcmToWav(pcm, 22_050);
    // Insert a 3-byte LIST chunk (+1 pad byte) between fmt and data.
    const extra = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 0xaa, 0xbb, 0xcc, 0]);
    const wav = new Uint8Array(plain.length + extra.length);
    wav.set(plain.subarray(0, 36), 0);
    wav.set(extra, 36);
    wav.set(plain.subarray(36), 36 + extra.length);

    expect(extractPcmAudio(wav, 'audio/wav')).toEqual({ pcm, sampleRate: 22_050 });
  });

  test('refuses a WAV file that has no data chunk', () => {
    const headerOnly = wrapPcmToWav(new Uint8Array(0)).subarray(0, 36);
    expect(() => extractPcmAudio(headerOnly, 'audio/wav')).toThrow(/no data chunk/);
  });
});
