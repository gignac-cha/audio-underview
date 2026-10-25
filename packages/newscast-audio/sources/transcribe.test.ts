import type {
  ProviderRequestSpecification,
  ProviderTransport,
} from '@audio-underview/newscast-core';

import { transcribeWords } from './transcribe.ts';

/** A fake `fetch` `Response` good enough for mocking the Whisper endpoint. */
function jsonResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string },
): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  return {
    ok,
    status,
    statusText: init?.statusText ?? (ok ? 'OK' : 'Error'),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** A well-formed Whisper `verbose_json` response with word-level timings (seconds). */
function verboseJsonResponse(
  words: Array<{ word: string; start: number; end: number }>,
): Response {
  return jsonResponse({ words });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('transcribeWords', () => {
  const audio = new Uint8Array([1, 2, 3, 4]);

  test('parses word timings from a verbose_json response, converting seconds to ms', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      verboseJsonResponse([
        { word: '안녕', start: 0, end: 0.5 },
        { word: '하세요', start: 0.5, end: 1.2 },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const words = await transcribeWords(audio, { apiKey: 'k' });

    expect(words).toEqual([
      { text: '안녕', startMs: 0, endMs: 500 },
      { text: '하세요', startMs: 500, endMs: 1_200 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('posts a multipart FormData body without a manually-set Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(verboseJsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await transcribeWords(audio, { apiKey: 'k' });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.body).toBeInstanceOf(FormData);
    // Content-Type must be left for FormData to set its own multipart boundary.
    const headerKeys = Object.keys(requestInit.headers as Record<string, string>).map((key) =>
      key.toLowerCase(),
    );
    expect(headerKeys).not.toContain('content-type');
  });
});

describe('provider error bodies never leak a key (design 2026-08-10 §1.3)', () => {
  const audio = new Uint8Array([1, 2, 3, 4]);
  /** The key an OpenAI 401 body echoes back verbatim. */
  const LEAKED_OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789xyz';
  const OPENAI_401_BODY = `{"error":{"message":"Incorrect API key provided: ${LEAKED_OPENAI_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}`;

  test('masks the 401 body in the thrown message and in the give-up console warning', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(OPENAI_401_BODY, { ok: false, status: 401, statusText: 'Unauthorized' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Never throws by contract: the caller falls back to estimated timings.
    await expect(transcribeWords(audio, { apiKey: 'k' })).resolves.toEqual([]);

    // The bare console.warn bypasses the Logger scrubber, so the masking has to
    // have happened before the text reaches it.
    const warning = warnSpy.mock.calls[0].join(' ');
    expect(warning).not.toContain(LEAKED_OPENAI_KEY);
    expect(warning).not.toContain('sk-proj');
    expect(warning).toContain('sk-[REDACTED]');
    // The diagnosis itself must survive the masking.
    expect(warning).toContain('401 Unauthorized');
    expect(warning).toContain('invalid_api_key');
  });

  test('masks the asterisk-masked, organization, and OAuth shapes as well', async () => {
    const body =
      'key sk-***abcd of org-9dF2kQwErTyUiOpA (proj_aBcD1234) ' +
      'with token ya29.a0AfB_byC1234567890 is not permitted';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(body, { ok: false, status: 403, statusText: 'Forbidden' }));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await transcribeWords(audio, { apiKey: 'k' });

    const warning = warnSpy.mock.calls[0].join(' ');
    expect(warning).not.toContain('sk-***abcd');
    expect(warning).not.toContain('org-9dF2kQwErTyUiOpA');
    expect(warning).not.toContain('proj_aBcD1234');
    expect(warning).not.toContain('ya29.a0AfB');
    expect(warning).toContain('sk-[REDACTED]');
    expect(warning).toContain('org-[REDACTED]');
  });

  test('caps the body so a huge error page cannot flood the log sink', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse('z'.repeat(10_000), { ok: false, status: 502, statusText: 'Bad Gateway' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await transcribeWords(audio, { apiKey: 'k' });

    const warning = warnSpy.mock.calls[0].join(' ');
    expect(warning.length).toBeLessThan(500);
    expect(warning).toContain('… [truncated]');
  });
});

describe('AI Gateway routing (design 2026-07-29-ai-gateway-egress)', () => {
  const audio = new Uint8Array([1, 2, 3, 4]);
  const SAMPLE_GATEWAY = { baseUrl: 'https://gateway.ai.cloudflare.com/v1/acc/gw' };

  test('REGRESSION: with no gateway configured, posts to the direct OpenAI transcription URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(verboseJsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await transcribeWords(audio, { apiKey: 'k' });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((requestInit.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect((requestInit.headers as Record<string, string>)['cf-aig-authorization']).toBeUndefined();
  });

  test('routes through the gateway via openai/audio/transcriptions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(verboseJsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await transcribeWords(audio, { apiKey: 'k', gateway: SAMPLE_GATEWAY });

    const [requestUrl] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/openai/audio/transcriptions',
    );
  });

  test('normalizes a trailing slash on the gateway baseUrl so no // appears in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(verboseJsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await transcribeWords(audio, {
      apiKey: 'k',
      gateway: { baseUrl: 'https://gateway.ai.cloudflare.com/v1/acc/gw/' },
    });

    const [requestUrl] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/openai/audio/transcriptions',
    );
    expect(requestUrl).not.toContain('//openai');
  });

  test('adds cf-aig-authorization only when the gateway carries a token', async () => {
    const withToken = vi.fn().mockResolvedValue(verboseJsonResponse([]));
    vi.stubGlobal('fetch', withToken);
    await transcribeWords(audio, { apiKey: 'k', gateway: { ...SAMPLE_GATEWAY, token: 'gw-token' } });
    expect((withToken.mock.calls[0][1].headers as Record<string, string>)['cf-aig-authorization']).toBe(
      'Bearer gw-token',
    );
    vi.unstubAllGlobals();

    const withoutToken = vi.fn().mockResolvedValue(verboseJsonResponse([]));
    vi.stubGlobal('fetch', withoutToken);
    await transcribeWords(audio, { apiKey: 'k', gateway: SAMPLE_GATEWAY });
    expect(
      (withoutToken.mock.calls[0][1].headers as Record<string, string>)['cf-aig-authorization'],
    ).toBeUndefined();
  });

  test('keeps the Authorization: Bearer header and multipart body unchanged in gateway mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(verboseJsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await transcribeWords(audio, { apiKey: 'secret-key', gateway: SAMPLE_GATEWAY });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect((requestInit.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
    expect(requestInit.body).toBeInstanceOf(FormData);
  });
});

// The one binary call in the pipeline, and the reason the proxy contract grew a
// base64 body (design §5.2): a self-funded job aligns its captions on the
// CALLER's OpenAI key, never the operator's.
describe('transport injection (per-user-provider-keys design §5.2)', () => {
  const audio = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  test('hands the multipart body over as base64 with its own boundary content-type', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const seen: ProviderRequestSpecification[] = [];
    const transport: ProviderTransport = async (request) => {
      seen.push(request);
      return {
        status: 200,
        body: JSON.stringify({ words: [{ word: '안녕', start: 0, end: 0.4 }] }),
      };
    };

    const words = await transcribeWords(audio, { transport });

    expect(words).toEqual([{ text: '안녕', startMs: 0, endMs: 400 }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    // A provider-RELATIVE path (the fulfiller owns the origin), no credential,
    // and the boundary the FormData serializer just generated.
    expect(seen[0].path).toBe('v1/audio/transcriptions');
    expect(seen[0].body).toBeUndefined();
    expect(seen[0].headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(JSON.stringify(seen[0])).not.toContain('Authorization');

    // The base64 really is the multipart wire body: it decodes to bytes that
    // carry the same boundary and the whisper-1 form fields.
    const decoded = atob(seen[0].bodyBase64 ?? '');
    const boundary = (seen[0].headers?.['content-type'] ?? '').split('boundary=')[1];
    expect(decoded).toContain(boundary);
    expect(decoded).toContain('whisper-1');
    expect(decoded).toContain('verbose_json');
    expect(decoded).toContain('audio.mp3');
  });

  test('takes exactly ONE attempt so a retried merge step cannot bill the user twice', async () => {
    let attempts = 0;
    const transport: ProviderTransport = async () => {
      attempts += 1;
      return { status: 500, body: 'upstream exploded' };
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Still never throws: the caller keeps its proportional caption estimate.
    await expect(transcribeWords(audio, { transport })).resolves.toEqual([]);
    expect(attempts).toBe(1);
    expect(warnSpy.mock.calls[0].join(' ')).toContain('giving up after 1 attempts');
  });

  test('masks a proxied provider body before it reaches the log sink', async () => {
    const transport: ProviderTransport = async () => ({
      status: 401,
      body: 'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(transcribeWords(audio, { transport })).resolves.toEqual([]);

    const warning = warnSpy.mock.calls[0].join(' ');
    expect(warning).not.toContain('sk-proj');
    expect(warning).toContain('sk-[REDACTED]');
    expect(warning).toContain('401');
  });

  test('with NEITHER a key nor a transport it answers with no words instead of calling out', async () => {
    // The self-funded job whose owner registered no OpenAI key: alignment simply
    // does not happen. What must not happen is a call on somebody else's key.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(transcribeWords(audio, {})).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
