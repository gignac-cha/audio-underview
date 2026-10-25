import type { ScriptLine } from '@audio-underview/newscast-core';
import {
  DEFAULT_SPEAKER_VOICES,
  synthesizeLine,
  synthesizeScript,
} from './synthesizer.ts';

/** Build a base64 string from raw bytes (mirrors Google's audioContent field). */
function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** A fake `Response` good enough for `fetch` mocking. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
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

describe('DEFAULT_SPEAKER_VOICES', () => {
  test('maps the two hosts to two distinct ko-KR Chirp 3 HD voices', () => {
    expect(DEFAULT_SPEAKER_VOICES[1]).toBe('ko-KR-Chirp3-HD-Charon');
    expect(DEFAULT_SPEAKER_VOICES[2]).toBe('ko-KR-Chirp3-HD-Kore');
    expect(DEFAULT_SPEAKER_VOICES[1]).not.toBe(DEFAULT_SPEAKER_VOICES[2]);
  });
});

describe('synthesizeLine', () => {
  test('POSTs to the synthesize endpoint with the API key, ko-KR voice, and MP3 config', async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ audioContent: encodeBytesToBase64(audioBytes) }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await synthesizeLine({
      apiKey: 'secret-key',
      text: '안녕하세요',
      voiceName: 'ko-KR-Chirp3-HD-Charon',
    });

    expect(result).toEqual(audioBytes);

    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(
      'https://texttospeech.googleapis.com/v1/text:synthesize?key=secret-key',
    );
    expect(requestInit.method).toBe('POST');

    const body = JSON.parse(requestInit.body as string);
    expect(body.input.ssml).toBe('<speak>안녕하세요</speak>');
    expect(body.voice.name).toBe('ko-KR-Chirp3-HD-Charon');
    expect(body.voice.languageCode).toBe('ko-KR');
    expect(body.audioConfig.audioEncoding).toBe('MP3');
  });

  test('honours a custom languageCode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ audioContent: encodeBytesToBase64(new Uint8Array([9])) }));
    vi.stubGlobal('fetch', fetchMock);

    await synthesizeLine({
      apiKey: 'k',
      text: 'hi',
      voiceName: 'v',
      languageCode: 'en-US',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.voice.languageCode).toBe('en-US');
  });

  test('throws when the request is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse('quota exceeded', { ok: false, status: 429 })),
    );

    await expect(
      synthesizeLine({ apiKey: 'k', text: 't', voiceName: 'v' }),
    ).rejects.toThrow(/429/);
  });

  test('throws when the response has no audioContent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));

    await expect(
      synthesizeLine({ apiKey: 'k', text: 't', voiceName: 'v' }),
    ).rejects.toThrow(/audioContent/);
  });

  // The key travels in this endpoint's query string, so a rejected request can
  // quote it straight back; the thrown message is persisted into the job's
  // failure record (design 2026-08-10-per-user-provider-keys §1.3).
  test('masks provider credentials quoted back in a failed response body', async () => {
    const leakedKey = 'AIzaSyD-1234567890abcdefgHIJKLmnop';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(`API key not valid: ${leakedKey} (org-9dF2kQwErTyUiOpA)`, {
          ok: false,
          status: 400,
        }),
      ),
    );

    const message = await synthesizeLine({ apiKey: 'k', text: 't', voiceName: 'v' }).then(
      () => {
        throw new Error('expected the synthesis to fail');
      },
      (error: unknown) => (error as Error).message,
    );
    expect(message).not.toContain(leakedKey);
    expect(message).not.toContain('org-9dF2kQwErTyUiOpA');
    expect(message).toContain('AIza[REDACTED]');
    expect(message).toContain('org-[REDACTED]');
    expect(message).toContain('400');
  });

  test('caps a huge error body instead of embedding it whole', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse('z'.repeat(10_000), { ok: false, status: 502 })),
    );

    const message = await synthesizeLine({ apiKey: 'k', text: 't', voiceName: 'v' }).then(
      () => {
        throw new Error('expected the synthesis to fail');
      },
      (error: unknown) => (error as Error).message,
    );
    expect(message.length).toBeLessThan(300);
    expect(message).toContain('… [truncated]');
  });
});

describe('synthesizeScript', () => {
  const script: ScriptLine[] = [
    { speaker: 1, text: '첫 번째 줄' },
    { speaker: 2, text: '두 번째 줄' },
    { speaker: 1, text: '세 번째 줄' },
  ];

  test('synthesizes each line with its speaker voice and returns index-aligned buffers', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse({ audioContent: encodeBytesToBase64(new Uint8Array([7])) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const buffers = await synthesizeScript({ apiKey: 'k', script });

    expect(buffers).toHaveLength(3);
    const usedVoices = fetchMock.mock.calls.map(
      (call) => JSON.parse(call[1].body as string).voice.name,
    );
    expect(usedVoices).toEqual([
      'ko-KR-Chirp3-HD-Charon',
      'ko-KR-Chirp3-HD-Kore',
      'ko-KR-Chirp3-HD-Charon',
    ]);
  });

  test('reports per-line progress via onLine', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ audioContent: encodeBytesToBase64(new Uint8Array([7])) })),
    );

    const progress: Array<[number, number]> = [];
    await synthesizeScript({
      apiKey: 'k',
      script,
      onLine: (completed, total) => progress.push([completed, total]),
    });

    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  test('respects a custom voice mapping', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ audioContent: encodeBytesToBase64(new Uint8Array([7])) }));
    vi.stubGlobal('fetch', fetchMock);

    await synthesizeScript({
      apiKey: 'k',
      script: [{ speaker: 2, text: '테스트' }],
      voices: { 1: 'voice-one', 2: 'voice-two' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.voice.name).toBe('voice-two');
  });
});
