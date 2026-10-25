import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Article,
  NewscastPartPlan,
  OrganizedUnit,
} from '@audio-underview/newscast-core';
import {
  LENGTH_PREFERENCE_FACTORS,
  MODELS_BY_PROVIDER,
  NEWSCAST_MODEL_IDS,
  ProviderRequestError,
  containsForbiddenSourceTerm,
  defaultModelForProvider,
  effortsForModel,
  generateNewscastOrganization,
  generateNewscastPartScript,
  generateNewscastScript,
  isProviderCredentialRejection,
  parseOrganizedUnits,
  parseScriptLines,
  planNewscastParts,
  redactProviderText,
} from './index.ts';
import type { ProviderRequestSpecification, ProviderTransport } from './index.ts';

/** A fake Anthropic Messages `Response` good enough for `fetch` mocking. */
function anthropicResponse(text: string, stopReason = 'end_turn'): Response {
  const body = {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 20 },
    stop_reason: stopReason,
  };
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * A `fetch` mock that records every request body (parsed JSON) and always returns
 * `text` as an Anthropic response. Lets a test assert on the EXACT prompt sent to
 * the provider — the only way to check prompt wording without exporting the
 * internal prompt builders.
 */
function capturingAnthropicMock(text: string): {
  mock: ReturnType<typeof vi.fn>;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const mock = vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return anthropicResponse(text);
  });
  return { mock, bodies };
}

/** The Anthropic user-prompt string from a captured request body. */
function userPromptOf(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role: string; content: string }>;
  return messages[0].content;
}

/** A fake OpenAI Chat Completions `Response` good enough for `fetch` mocking. */
function openaiResponse(text: string): Response {
  const body = {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A fake Gemini generateContent `Response` good enough for `fetch` mocking. */
function geminiResponse(text: string): Response {
  const body = {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  };
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A sample Cloudflare AI Gateway configuration for URL-routing tests. */
const SAMPLE_GATEWAY = { baseUrl: 'https://gateway.ai.cloudflare.com/v1/acc/gw' };

/** A minimal valid `{lines:[]}` Anthropic payload so a part/dialogue call parses. */
const ONE_LINE_RESPONSE = '{ "lines": [ { "speaker": 1, "text": "안녕하세요." } ] }';

/** Build an article whose section lengths are exactly the given char counts. */
function articleWithLengths(
  contentLength: number,
  summaryLength: number,
  reactionsLength: number,
): Article {
  return {
    title: '제목',
    originalUrl: 'https://example.com/article',
    discussionUrl: 'https://example.com/discussion',
    content: 'a'.repeat(contentLength),
    geeknewsSummary: summaryLength > 0 ? 'b'.repeat(summaryLength) : undefined,
    hackerNewsComments: reactionsLength > 0 ? 'c'.repeat(reactionsLength) : undefined,
  };
}

/** A small ordered unit list for planning/part-prompt tests. */
const SAMPLE_UNITS: OrganizedUnit[] = [
  { kind: 'context', headline: '배경 설명', detail: '이 사안의 맥락입니다.', weight: 3 },
  {
    kind: 'fact',
    headline: '핵심 수치 42퍼센트',
    detail: '핵심 사실은 42퍼센트 증가입니다.',
    quotes: ['정확히 42% 늘었다'],
    weight: 5,
  },
  { kind: 'reaction', headline: '독자 반응', detail: '여러 반응이 있었습니다.', weight: 2 },
];

const SAMPLE_ARTICLE: Article = {
  title: '코드베이스를 완전히 이해하지 못해도 괜찮은 이유',
  originalUrl: 'https://example.com/article',
  discussionUrl: 'https://example.com/discussion',
  content: '큰 코드베이스는 누구도 전부 이해할 수 없다.',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('containsForbiddenSourceTerm', () => {
  it('flags Korean and English source/platform names (case-insensitive)', () => {
    expect(containsForbiddenSourceTerm('오늘 긱뉴스에 올라온 소식입니다.')).toBe(true);
    expect(containsForbiddenSourceTerm('This was on GeekNews today.')).toBe(true);
    expect(containsForbiddenSourceTerm('해커뉴스 반응이 뜨겁습니다.')).toBe(true);
    expect(containsForbiddenSourceTerm('a hot thread on Hacker News')).toBe(true);
    expect(containsForbiddenSourceTerm('discussed on HackerNews')).toBe(true);
    expect(containsForbiddenSourceTerm('레딧에서도 화제였죠')).toBe(true);
    expect(containsForbiddenSourceTerm('shared on Reddit')).toBe(true);
  });

  it('flags community/forum/comment words and the source host', () => {
    expect(containsForbiddenSourceTerm('댓글 반응이 좋았어요')).toBe(true);
    expect(containsForbiddenSourceTerm('한 커뮤니티에서요')).toBe(true);
    expect(containsForbiddenSourceTerm('그 포럼 게시판의 게시글')).toBe(true);
    expect(containsForbiddenSourceTerm('출처는 news.hada.io 입니다')).toBe(true);
    expect(containsForbiddenSourceTerm('hada.io 링크')).toBe(true);
  });

  it('flags the standalone hn token but not hn inside a larger word', () => {
    expect(containsForbiddenSourceTerm('그건 hn 에서 봤어요')).toBe(true);
    expect(containsForbiddenSourceTerm('hn에 올라온 글')).toBe(true);
    expect(containsForbiddenSourceTerm('hn의 반응')).toBe(true);
    // No false positives on ordinary words containing "hn".
    expect(containsForbiddenSourceTerm('john described a new algorithm')).toBe(false);
    expect(containsForbiddenSourceTerm('the technology is impressive')).toBe(false);
  });

  it('returns false for clean newscast text', () => {
    expect(
      containsForbiddenSourceTerm(
        '안녕하세요, 오늘은 새로운 인공지능 연구 소식을 전해드립니다. 정말 흥미로운 내용이죠.',
      ),
    ).toBe(false);
  });
});

describe('parseScriptLines', () => {
  it('parses a complete fenced {lines:[]} response', () => {
    const raw =
      '```json\n{\n  "lines": [\n    { "speaker": 1, "text": "안녕하세요." },\n    { "speaker": 2, "text": "반갑습니다." }\n  ]\n}\n```';
    expect(parseScriptLines(raw)).toEqual([
      { speaker: 1, text: '안녕하세요.' },
      { speaker: 2, text: '반갑습니다.' },
    ]);
  });

  it('salvages complete line objects from a truncated (unterminated) JSON response', () => {
    // Mirrors job c3f487b3: a valid start cut off mid-string with no closing
    // quote/brace, no closing `]}` and no closing code fence — exactly what
    // max_tokens truncation produces. The two complete turns must survive; the
    // half-written third turn is dropped rather than failing the whole parse.
    const raw =
      '```json\n{\n  "lines": [\n    { "speaker": 1, "text": "안녕하세요, 여러분." },\n    { "speaker": 2, "text": "네, 시작하죠." },\n    { "speaker": 1, "text": "오늘 주제는 코드 이해입니';
    expect(parseScriptLines(raw)).toEqual([
      { speaker: 1, text: '안녕하세요, 여러분.' },
      { speaker: 2, text: '네, 시작하죠.' },
    ]);
  });

  it('still falls back to speaker-tagged plaintext when there is no JSON', () => {
    const raw = '진행자1: 첫 마디입니다.\n진행자2: 두 번째 마디예요.';
    expect(parseScriptLines(raw)).toEqual([
      { speaker: 1, text: '첫 마디입니다.' },
      { speaker: 2, text: '두 번째 마디예요.' },
    ]);
  });
});

describe('effortsForModel', () => {
  it('caps Gemini models at high and runs the GPT-5.6 family from none to max', () => {
    expect(effortsForModel('google', 'gemini-3.6-flash')).toEqual(['low', 'medium', 'high']);
    expect(effortsForModel('google', 'gemini-3.5-flash')).toEqual(['low', 'medium', 'high']);
    expect(effortsForModel('google', 'gemini-3.5-flash-lite')).toEqual(['low', 'medium', 'high']);
    // 'none' arrived on GPT-5.6 between the 07-27 and 08-13 sweeps and is
    // OpenAI-only — no other provider's ladder starts below 'low'.
    expect(effortsForModel('openai', 'gpt-5.6-sol')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(effortsForModel('openai', 'gpt-5.6-luna')).toEqual(
      effortsForModel('openai', 'gpt-5.6-sol'),
    );
  });

  it("keeps 'none' out of every non-OpenAI ladder", () => {
    // Grok 4.3 documents 'none' too, but the xAI mapping folds it to low for
    // every Grok, so the catalog does not offer it there.
    for (const [provider, models] of Object.entries(MODELS_BY_PROVIDER)) {
      if (provider === 'openai') {
        continue;
      }
      for (const model of models) {
        expect(model.efforts).not.toContain('none');
      }
    }
  });

  it('defaults each provider to its 2026-09-29 current model and keeps the replaced ids as legacy', () => {
    expect(defaultModelForProvider('anthropic')).toBe('claude-opus-5-5');
    expect(defaultModelForProvider('openai')).toBe('gpt-6-sol');
    expect(defaultModelForProvider('google')).toBe('gemini-3.8-flash');
    expect(defaultModelForProvider('xai')).toBe('grok-4.7');
    expect(effortsForModel('anthropic', 'claude-sonnet-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsForModel('openai', 'gpt-6-luna')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    const legacyIds = Object.values(MODELS_BY_PROVIDER)
      .flat()
      .filter((model) => model.legacy === true)
      .map((model) => model.id);
    for (const replaced of ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'grok-4.6']) {
      expect(legacyIds).toContain(replaced);
    }
  });

  it('lists current models before legacy ones and labels every entry with its price', () => {
    for (const models of Object.values(MODELS_BY_PROVIDER)) {
      const firstLegacyIndex = models.findIndex((model) => model.legacy === true);
      const lastCurrentIndex = models.map((model) => model.legacy === true).lastIndexOf(false);
      if (firstLegacyIndex !== -1) {
        expect(lastCurrentIndex).toBeLessThan(firstLegacyIndex);
      }
      for (const model of models) {
        expect(model.label).toMatch(/ · \$[0-9.]+\/\$[0-9.]+/);
        expect(model.label).not.toMatch(/추천|최고 성능|밸런스|저가/);
      }
    }
  });

  it('runs Claude Opus 5 to max effort', () => {
    expect(effortsForModel('anthropic', 'claude-opus-5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('runs the legacy GPT-5.5 id from none to xhigh (no max on that generation)', () => {
    // Re-listed 2026-09-17 as a legacy entry: still served, no shutdown date.
    expect(effortsForModel('openai', 'gpt-5.5')).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(MODELS_BY_PROVIDER.openai.find((model) => model.id === 'gpt-5.5')?.legacy).toBe(true);
  });

  it('offers no effort control for non-reasoning legacy OpenAI models', () => {
    expect(effortsForModel('openai', 'gpt-4.1')).toEqual([]);
    expect(effortsForModel('openai', 'gpt-4o-mini')).toEqual([]);
  });

  it('offers no effort control for Haiku 4.5 (pre-effort-API model)', () => {
    expect(effortsForModel('anthropic', 'claude-haiku-4-5-20251001')).toEqual([]);
  });

  it('falls back to a conservative ladder for unknown model ids', () => {
    expect(effortsForModel('anthropic', 'some-future-model')).toEqual(['low', 'medium', 'high']);
  });

  it('declares efforts on every catalog entry', () => {
    for (const models of Object.values(MODELS_BY_PROVIDER)) {
      for (const model of models) {
        expect(Array.isArray(model.efforts)).toBe(true);
      }
    }
  });
});

describe('generateNewscastScript retry behavior', () => {
  it('throws IMMEDIATELY on a parse failure without an inner retry (single call)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(anthropicResponse('죄송하지만 응답할 수 없습니다.', 'max_tokens'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateNewscastScript({
        provider: 'anthropic',
        apiKey: 'k',
        model: 'claude-haiku-4-5',
        articles: [SAMPLE_ARTICLE],
      }),
    ).rejects.toThrow(/failed to parse.*stop_reason=max_tokens/s);

    // The decisive assertion: retries are delegated to the Workflow step, so the
    // provider must be called exactly ONCE — no inner 3× loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('masks credentials in the parse-failure message AND in its console mirror', async () => {
    // The console.warn here bypasses the Logger scrubber entirely, so the raw
    // model echo has to be masked before it is printed or thrown
    // (design 2026-08-10-per-user-provider-keys §1.3).
    const leakedKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789xyz';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        anthropicResponse(`요청하신 키 ${leakedKey} 는 org-9dF2kQwErTyUiOpA 소속입니다.`),
      ),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const message = await generateNewscastScript({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      articles: [SAMPLE_ARTICLE],
    }).then(
      () => {
        throw new Error('expected the parse to fail');
      },
      (error: unknown) => (error as Error).message,
    );

    expect(message).not.toContain(leakedKey);
    expect(message).not.toContain('org-9dF2kQwErTyUiOpA');
    expect(message).toContain('sk-[REDACTED]');
    expect(message).toContain('org-[REDACTED]');

    const warning = warnSpy.mock.calls[0].join(' ');
    expect(warning).not.toContain(leakedKey);
    expect(warning).toContain('sk-[REDACTED]');
  });

  it('returns the parsed lines from a single successful call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        anthropicResponse(
          '```json\n{ "lines": [ { "speaker": 1, "text": "안녕하세요." }, { "speaker": 2, "text": "반갑습니다." } ] }\n```',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateNewscastScript({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      articles: [SAMPLE_ARTICLE],
    });

    expect(result.lines).toEqual([
      { speaker: 1, text: '안녕하세요.' },
      { speaker: 2, text: '반갑습니다.' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('legacy generateNewscastScript prompt (must not drift)', () => {
  // The dynamic-parts refactor extracted shared prompt helpers, but the LEGACY
  // single-shot prompt must stay byte-for-byte as it was — in particular the fixed
  // "40턴" line and the always-present closing greeting (design §5 / task rule 1).
  it('keeps the fixed 40-turn line and the closing-greeting line, with no per-part wording', async () => {
    const { mock, bodies } = capturingAnthropicMock(ONE_LINE_RESPONSE);
    vi.stubGlobal('fetch', mock);

    await generateNewscastScript({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      articles: [SAMPLE_ARTICLE],
    });
    const prompt = userPromptOf(bodies[0]);

    // The legacy fixed turn line and closing greeting are preserved verbatim.
    expect(prompt).toContain('- 전체 턴(두 진행자가 주고받는 대사)은 40턴 내외로 구성하세요.');
    expect(prompt).toContain('- 마지막에는 방송을 정리하는 짧은 마무리 인사를 넣어 주세요.');
    // Shared blocks still present.
    expect(prompt).toContain('[음성 낭독용 대본 규칙 — 반드시 지킬 것]');
    expect(prompt).toContain('- [매우 중요] 출처·플랫폼·커뮤니티를 절대 언급하지 마세요.');
    // The legacy path must NOT gain any per-part scaffolding.
    expect(prompt).not.toContain('이 파트의 전체 턴은');
    expect(prompt).not.toContain('오프닝 인사');
    expect(prompt).not.toContain('이 파트에서 다룰 재료');
  });
});

describe('parseOrganizedUnits', () => {
  it('parses a well-formed { units: [...] } object', () => {
    const raw =
      '{ "units": [ { "kind": "fact", "headline": "H1", "detail": "D1", "quotes": ["Q1"], "weight": 4 }, { "kind": "context", "headline": "H2", "detail": "D2", "weight": 2 } ] }';
    expect(parseOrganizedUnits(raw)).toEqual([
      { kind: 'fact', headline: 'H1', detail: 'D1', quotes: ['Q1'], weight: 4 },
      { kind: 'context', headline: 'H2', detail: 'D2', weight: 2 },
    ]);
  });

  it('strips markdown code fences before parsing', () => {
    const raw =
      '```json\n{ "units": [ { "kind": "reaction", "headline": "H", "detail": "D", "weight": 3 } ] }\n```';
    expect(parseOrganizedUnits(raw)).toEqual([
      { kind: 'reaction', headline: 'H', detail: 'D', weight: 3 },
    ]);
  });

  it('salvages the JSON object embedded in surrounding prose', () => {
    const raw =
      '정리 결과입니다:\n{ "units": [ { "kind": "fact", "headline": "H", "detail": "D", "weight": 3 } ] }\n이상입니다.';
    expect(parseOrganizedUnits(raw)).toHaveLength(1);
  });

  it('accepts a bare array and applies field defaults, dropping headline-less units', () => {
    const raw = JSON.stringify([
      { kind: 'fact', headline: 'H', detail: 'D' }, // no weight → default 3
      { kind: 'fact', detail: '헤드라인 없음' }, // no headline → dropped
      { kind: 'fact', headline: 'H2', detail: 'D2', quotes: [] }, // empty quotes → omitted
    ]);
    expect(parseOrganizedUnits(raw)).toEqual([
      { kind: 'fact', headline: 'H', detail: 'D', weight: 3 },
      { kind: 'fact', headline: 'H2', detail: 'D2', weight: 3 },
    ]);
  });

  it('clamps field lengths, quote count, and weight to the §4 caps', () => {
    const raw = JSON.stringify({
      units: [
        {
          kind: 'fact',
          headline: 'ㄱ'.repeat(80),
          detail: 'ㄴ'.repeat(300),
          quotes: ['ㄷ'.repeat(150), 'q2', 'q3'],
          weight: 99,
        },
      ],
    });
    const [unit] = parseOrganizedUnits(raw);
    expect(unit.headline).toHaveLength(60);
    expect(unit.detail).toHaveLength(240);
    expect(unit.quotes).toHaveLength(2); // 3 quotes trimmed to 2
    expect(unit.quotes?.[0]).toHaveLength(100);
    expect(unit.weight).toBe(5); // 99 clamped down to 5
  });

  it('clamps a too-low weight up and rounds a fractional weight', () => {
    const raw = JSON.stringify({
      units: [
        { kind: 'fact', headline: 'A', detail: 'D', weight: 0 },
        { kind: 'fact', headline: 'B', detail: 'D', weight: 3.7 },
      ],
    });
    expect(parseOrganizedUnits(raw).map((unit) => unit.weight)).toEqual([1, 4]);
  });

  it('coerces an unknown kind to "context"', () => {
    const raw = JSON.stringify({
      units: [{ kind: 'opinion', headline: 'H', detail: 'D', weight: 2 }],
    });
    expect(parseOrganizedUnits(raw)[0].kind).toBe('context');
  });

  it('caps the unit count at 24', () => {
    const many = Array.from({ length: 30 }, (_value, index) => ({
      kind: 'fact',
      headline: `H${index}`,
      detail: 'D',
      weight: 3,
    }));
    expect(parseOrganizedUnits(JSON.stringify({ units: many }))).toHaveLength(24);
  });

  it('returns [] for a non-JSON / empty response', () => {
    expect(parseOrganizedUnits('죄송하지만 정리할 수 없습니다.')).toEqual([]);
    expect(parseOrganizedUnits('')).toEqual([]);
  });
});

describe('planNewscastParts', () => {
  it('REGRESSION: a ~13,000-char source stays 1 part at a 41-turn target', () => {
    // 8000 + 2500 + 2500 = 13,000 speakable chars (all under the §6 caps) →
    // est 3,170 script chars → 1 part → 41-turn target (the legacy "40턴 내외").
    const plans = planNewscastParts([articleWithLengths(8000, 2500, 2500)], SAMPLE_UNITS);
    expect(plans).toHaveLength(1);
    expect(plans[0].index).toBe(1);
    expect(plans[0].turnTarget).toBe(41);
    // The lone part covers every unit, in order.
    expect(plans[0].unitIndexes).toEqual([0, 1, 2]);
  });

  it('§14 length preset: the SAME 13,000-char source scales short/standard/long within the clamps', () => {
    // est 3,170 script chars. short ×0.6 → round(1902/78)=24 (lower clamp);
    // standard ×1.0 → 41 (the untouched §2 pin); long ×1.4 → round(4439/78)=57
    // clamped to the 56-turn cap. All three stay 1 part — the preset only scales
    // WITHIN the source-supported range, never forcing padding past a clamp.
    const source = [articleWithLengths(8000, 2500, 2500)];
    const short = planNewscastParts(source, SAMPLE_UNITS, {
      lengthFactor: LENGTH_PREFERENCE_FACTORS.short,
    });
    const standard = planNewscastParts(source, SAMPLE_UNITS, {
      lengthFactor: LENGTH_PREFERENCE_FACTORS.standard,
    });
    const long = planNewscastParts(source, SAMPLE_UNITS, {
      lengthFactor: LENGTH_PREFERENCE_FACTORS.long,
    });

    expect(short).toHaveLength(1);
    expect(short[0].turnTarget).toBe(24);
    expect(standard).toHaveLength(1);
    expect(standard[0].turnTarget).toBe(41);
    expect(long).toHaveLength(1);
    expect(long[0].turnTarget).toBe(56);
  });

  it('§14: the standard factor (1.0) is behavior-identical to passing no options', () => {
    // The default-preset path must never diverge from the pre-preset behavior.
    const source = [articleWithLengths(8000, 2500, 2500)];
    expect(planNewscastParts(source, SAMPLE_UNITS, { lengthFactor: 1.0 })).toEqual(
      planNewscastParts(source, SAMPLE_UNITS),
    );
    expect(LENGTH_PREFERENCE_FACTORS).toEqual({ short: 0.6, standard: 1.0, long: 1.4 });
  });

  it('REGRESSION: a ~48,000-char source splits into 3 parts at 50-turn targets', () => {
    // 24000 + 4000 + 20000 = 48,000 speakable chars (each exactly at its §6 cap) →
    // est 11,707 script chars → 3 parts × 50-turn target (the 24-minute ceiling).
    const units: OrganizedUnit[] = Array.from({ length: 9 }, (_value, index) => ({
      kind: 'fact',
      headline: `H${index}`,
      detail: 'D',
      weight: 3,
    }));
    const plans = planNewscastParts([articleWithLengths(24000, 4000, 20000)], units);
    expect(plans).toHaveLength(3);
    expect(plans.map((plan) => plan.turnTarget)).toEqual([50, 50, 50]);
    expect(plans.map((plan) => plan.index)).toEqual([1, 2, 3]);
  });

  it('sizes off the SAME per-article caps the prompt builder applies', () => {
    // A 100,000-char body is capped to 24,000 before sizing (§6 content cap), so
    // est is 24000/4.1 ≈ 5,854 → 2 parts, NOT the 6+ an uncapped body would yield.
    const plans = planNewscastParts([articleWithLengths(100_000, 0, 0)], SAMPLE_UNITS);
    expect(plans).toHaveLength(2);
  });

  it('clamps a tiny source to 1 part and the 24-turn floor', () => {
    // 2050 chars → est 500 → round(500/3900)=0 clamped up to 1 part; round(500/78)=6
    // clamped up to the 24-turn floor.
    const plans = planNewscastParts([articleWithLengths(2050, 0, 0)], SAMPLE_UNITS);
    expect(plans).toHaveLength(1);
    expect(plans[0].turnTarget).toBe(24);
  });

  it('clamps a huge source to the 3-part ceiling and the 56-turn cap', () => {
    // Two maxed articles → 96,000 speakable chars → est ≈ 23,415 → round(6.0)=6
    // clamped down to 3 parts; round(23415/3/78)=100 clamped down to the 56-turn cap.
    const maxed = articleWithLengths(24_000, 4_000, 20_000);
    const units: OrganizedUnit[] = Array.from({ length: 6 }, (_value, index) => ({
      kind: 'fact',
      headline: `H${index}`,
      detail: 'D',
      weight: 3,
    }));
    const plans = planNewscastParts([maxed, maxed], units);
    expect(plans).toHaveLength(3);
    expect(plans.every((plan) => plan.turnTarget === 56)).toBe(true);
  });

  it('preserves unit order and splits equal-weight units evenly (contiguous groups)', () => {
    const units: OrganizedUnit[] = Array.from({ length: 6 }, (_value, index) => ({
      kind: 'fact',
      headline: `H${index}`,
      detail: 'D',
      weight: 3,
    }));
    const plans = planNewscastParts([articleWithLengths(24_000, 4_000, 20_000)], units);
    // 3 contiguous groups of 2, original order preserved, full coverage.
    expect(plans.map((plan) => plan.unitIndexes)).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it('balances by cumulative weight, not by unit count', () => {
    // Weights [5,1,1,1,1,5]: an equal-COUNT split would be 6/2/6 (badly skewed).
    // The cumulative-greedy split isolates each heavy unit → weights 5/4/5.
    const weights = [5, 1, 1, 1, 1, 5];
    const units: OrganizedUnit[] = weights.map((weight, index) => ({
      kind: 'fact',
      headline: `H${index}`,
      detail: 'D',
      weight,
    }));
    const plans = planNewscastParts([articleWithLengths(24_000, 4_000, 20_000)], units);

    // Order preserved and every unit covered exactly once.
    expect(plans.flatMap((plan) => plan.unitIndexes)).toEqual([0, 1, 2, 3, 4, 5]);
    // Every part gets at least one unit; weight spread is small (balanced).
    const groupWeights = plans.map((plan) =>
      plan.unitIndexes.reduce((sum, unitIndex) => sum + units[unitIndex].weight, 0),
    );
    expect(groupWeights).toEqual([5, 4, 5]);
  });
});

describe('generateNewscastPartScript prompt (design §5)', () => {
  const partOptions = {
    provider: 'anthropic' as const,
    apiKey: 'k',
    model: 'claude-haiku-4-5',
    articles: [SAMPLE_ARTICLE],
  };

  it('first part of many: opens with a greeting, does NOT close, reserves later headlines', async () => {
    const { mock, bodies } = capturingAnthropicMock(ONE_LINE_RESPONSE);
    vi.stubGlobal('fetch', mock);

    const plan: NewscastPartPlan = { index: 1, unitIndexes: [0], turnTarget: 50 };
    await generateNewscastPartScript({
      ...partOptions,
      units: SAMPLE_UNITS,
      plan,
      partCount: 3,
      nextHeadlines: ['핵심 수치 42퍼센트'],
    });
    const prompt = userPromptOf(bodies[0]);

    expect(prompt).toContain('총 3개 부분으로 이어지며');
    expect(prompt).toContain('오프닝 인사'); // opening greeting
    expect(prompt).toContain('마무리 인사는 하지 말고'); // non-final: trail off, no close
    expect(prompt).not.toContain('이 방송의 마지막 부분입니다');
    expect(prompt).toContain('뒷부분에서 다룰 몫이니 지금은 다루지 마세요: 핵심 수치 42퍼센트');
    expect(prompt).toContain('이 파트의 전체 턴은 50턴 내외로 구성하세요.');
  });

  it('middle part: no new greeting, no close, and no-repeat / no-poach guards', async () => {
    const { mock, bodies } = capturingAnthropicMock(ONE_LINE_RESPONSE);
    vi.stubGlobal('fetch', mock);

    const plan: NewscastPartPlan = { index: 2, unitIndexes: [1], turnTarget: 50 };
    await generateNewscastPartScript({
      ...partOptions,
      units: SAMPLE_UNITS,
      plan,
      partCount: 3,
      previousHeadlines: ['배경 설명'],
      nextHeadlines: ['독자 반응'],
    });
    const prompt = userPromptOf(bodies[0]);

    expect(prompt).toContain('새로 인사하지 말고');
    expect(prompt).not.toContain('오프닝 인사');
    expect(prompt).toContain('앞부분에서 이미 다뤘으니 반복하지 마세요: 배경 설명');
    expect(prompt).toContain('뒷부분에서 다룰 몫이니 지금은 다루지 마세요: 독자 반응');
    expect(prompt).not.toContain('이 방송의 마지막 부분입니다');
    // The unit coverage block renders this part's unit verbatim (headline + quote).
    expect(prompt).toContain('이 파트에서 다룰 재료');
    expect(prompt).toContain('핵심 수치 42퍼센트');
    expect(prompt).toContain('정확히 42% 늘었다');
  });

  it('last part: no greeting, includes the closing greeting', async () => {
    const { mock, bodies } = capturingAnthropicMock(ONE_LINE_RESPONSE);
    vi.stubGlobal('fetch', mock);

    const plan: NewscastPartPlan = { index: 3, unitIndexes: [2], turnTarget: 50 };
    await generateNewscastPartScript({
      ...partOptions,
      units: SAMPLE_UNITS,
      plan,
      partCount: 3,
      previousHeadlines: ['배경 설명', '핵심 수치 42퍼센트'],
    });
    const prompt = userPromptOf(bodies[0]);

    expect(prompt).not.toContain('오프닝 인사');
    expect(prompt).toContain('이 방송의 마지막 부분입니다');
    expect(prompt).toContain('마무리 인사를 넣어 주세요');
  });

  it('always preserves the shared reading rules and source-anonymity ban', async () => {
    const { mock, bodies } = capturingAnthropicMock(ONE_LINE_RESPONSE);
    vi.stubGlobal('fetch', mock);

    const plan: NewscastPartPlan = { index: 1, unitIndexes: [0, 1, 2], turnTarget: 41 };
    await generateNewscastPartScript({
      ...partOptions,
      units: SAMPLE_UNITS,
      plan,
      partCount: 1,
    });
    const prompt = userPromptOf(bodies[0]);

    expect(prompt).toContain('[음성 낭독용 대본 규칙 — 반드시 지킬 것]');
    expect(prompt).toContain('- [매우 중요] 출처·플랫폼·커뮤니티를 절대 언급하지 마세요.');
    // A lone part (first AND last) both greets and closes, like the legacy shape.
    expect(prompt).toContain('오프닝 인사');
    expect(prompt).toContain('마무리 인사를 넣어 주세요');
  });

  it('§14 length preset: adds a tone hint for short/long and NONE for standard/omitted', async () => {
    const plan: NewscastPartPlan = { index: 1, unitIndexes: [0], turnTarget: 41 };

    // 'short' adds the concise hint.
    {
      const { mock, bodies } = capturingAnthropicMock(ONE_LINE_RESPONSE);
      vi.stubGlobal('fetch', mock);
      await generateNewscastPartScript({
        ...partOptions,
        units: SAMPLE_UNITS,
        plan,
        partCount: 1,
        lengthPreference: 'short',
      });
      const prompt = userPromptOf(bodies[0]);
      expect(prompt).toContain('핵심만 간결히 다루고 곁가지는 생략하세요.');
      expect(prompt).not.toContain('배경 설명과 진행자들의 리액션을 풍부하게 담으세요.');
      vi.unstubAllGlobals();
    }

    // 'long' adds the rich-context hint.
    {
      const { mock, bodies } = capturingAnthropicMock(ONE_LINE_RESPONSE);
      vi.stubGlobal('fetch', mock);
      await generateNewscastPartScript({
        ...partOptions,
        units: SAMPLE_UNITS,
        plan,
        partCount: 1,
        lengthPreference: 'long',
      });
      const prompt = userPromptOf(bodies[0]);
      expect(prompt).toContain('배경 설명과 진행자들의 리액션을 풍부하게 담으세요.');
      expect(prompt).not.toContain('핵심만 간결히 다루고 곁가지는 생략하세요.');
      vi.unstubAllGlobals();
    }

    // 'standard' and omission add NO hint line — the prompt must be identical, so
    // the standard newscast is byte-for-byte what it was before length presets.
    const { mock: standardMock, bodies: standardBodies } =
      capturingAnthropicMock(ONE_LINE_RESPONSE);
    vi.stubGlobal('fetch', standardMock);
    await generateNewscastPartScript({
      ...partOptions,
      units: SAMPLE_UNITS,
      plan,
      partCount: 1,
      lengthPreference: 'standard',
    });
    const standardPrompt = userPromptOf(standardBodies[0]);
    vi.unstubAllGlobals();

    const { mock: omittedMock, bodies: omittedBodies } =
      capturingAnthropicMock(ONE_LINE_RESPONSE);
    vi.stubGlobal('fetch', omittedMock);
    await generateNewscastPartScript({
      ...partOptions,
      units: SAMPLE_UNITS,
      plan,
      partCount: 1,
    });
    const omittedPrompt = userPromptOf(omittedBodies[0]);

    expect(standardPrompt).not.toContain('핵심만 간결히');
    expect(standardPrompt).not.toContain('풍부하게 담으세요');
    expect(standardPrompt).toBe(omittedPrompt);
  });

  it('fallback mode (empty units): omits the coverage block but keeps the dynamic turn target', async () => {
    const { mock, bodies } = capturingAnthropicMock(ONE_LINE_RESPONSE);
    vi.stubGlobal('fetch', mock);

    const plan: NewscastPartPlan = { index: 1, unitIndexes: [], turnTarget: 41 };
    await generateNewscastPartScript({
      ...partOptions,
      units: [],
      plan,
      partCount: 1,
    });
    const prompt = userPromptOf(bodies[0]);

    expect(prompt).not.toContain('이 파트에서 다룰 재료'); // no coverage block
    expect(prompt).toContain('이 파트의 전체 턴은 41턴 내외로 구성하세요.'); // dynamic target kept
    expect(prompt).toContain('[음성 낭독용 대본 규칙 — 반드시 지킬 것]'); // shared rules kept
  });
});

describe('generateNewscastOrganization', () => {
  it('returns parsed units from a single successful call', async () => {
    const { mock, bodies } = capturingAnthropicMock(
      '{ "units": [ { "kind": "fact", "headline": "핵심", "detail": "내용", "weight": 4 } ] }',
    );
    vi.stubGlobal('fetch', mock);

    const result = await generateNewscastOrganization({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      articles: [SAMPLE_ARTICLE],
    });

    expect(result.units).toEqual([
      { kind: 'fact', headline: '핵심', detail: '내용', weight: 4 },
    ]);
    expect(result.model).toBe('claude-haiku-4-5');
    expect(mock).toHaveBeenCalledTimes(1);

    // The organize prompt reuses the source-anonymity ban and asks for the JSON
    // { units: [...] } contract §4 requires.
    const prompt = userPromptOf(bodies[0]);
    expect(prompt).toContain('- [매우 중요] 출처·플랫폼·커뮤니티를 절대 언급하지 마세요.');
    expect(prompt).toContain('"units"');
    expect(prompt).toContain('요약하지 마세요');
  });

  it('throws IMMEDIATELY on a parse failure without an inner retry (single call)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(anthropicResponse('죄송하지만 정리할 수 없습니다.', 'max_tokens'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateNewscastOrganization({
        provider: 'anthropic',
        apiKey: 'k',
        model: 'claude-haiku-4-5',
        articles: [SAMPLE_ARTICLE],
      }),
    ).rejects.toThrow(/failed to parse any organized units.*stop_reason=max_tokens/s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// xAI / Grok (per-user-provider-keys design §2)
// ---------------------------------------------------------------------------

describe('xAI provider wiring', () => {
  it('is in the catalog with a default model, and every entry declares its efforts', () => {
    expect(defaultModelForProvider('xai')).toBe('grok-4.7');
    expect(NEWSCAST_MODEL_IDS.xai).toEqual({ flagship: 'grok-4.7', cheap: 'grok-4.3' });
    expect(MODELS_BY_PROVIDER.xai.map((model) => model.id)).toEqual([
      'grok-4.7',
      'grok-4.3',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-multi-agent-0309',
      'grok-build-0.1',
      'grok-4.6',
      'grok-4.5',
      'grok-4.20-0309-reasoning',
    ]);
    for (const model of MODELS_BY_PROVIDER.xai) {
      expect(Array.isArray(model.efforts)).toBe(true);
    }
  });

  it('offers Grok 4.7/4.6 low..xhigh and Grok 4.5 low..high — xAI has no max rung', () => {
    expect(effortsForModel('xai', 'grok-4.7')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effortsForModel('xai', 'grok-4.6')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effortsForModel('xai', 'grok-4.5')).toEqual(['low', 'medium', 'high']);
    expect(effortsForModel('xai', 'grok-4.3')).toEqual(['low', 'medium', 'high', 'xhigh']);
    // Undocumented / non-reasoning ids advertise NO effort control, because an
    // OpenAI-compatible API rejects an unsupported reasoning parameter outright.
    expect(effortsForModel('xai', 'grok-4.20-0309-non-reasoning')).toEqual([]);
    expect(effortsForModel('xai', 'grok-build-0.1')).toEqual([]);
  });

  it('calls api.x.ai with the OpenAI-compatible body and a Bearer credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openaiResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateNewscastScript({
      provider: 'xai',
      apiKey: 'xai-secret',
      articles: [SAMPLE_ARTICLE],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xai-secret');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // The default model resolves from the catalog, and the shape is OpenAI's —
    // which is the whole reason this provider reuses that call site.
    expect(body.model).toBe('grok-4.7');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(result.model).toBe('grok-4.7');
  });

  it('folds max down to xhigh for Grok, but leaves OpenAI untouched', async () => {
    const xaiMock = vi.fn().mockResolvedValue(openaiResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', xaiMock);
    await generateNewscastScript({
      provider: 'xai',
      apiKey: 'k',
      model: 'grok-4.6',
      effort: 'max',
      articles: [SAMPLE_ARTICLE],
    });
    expect(
      (JSON.parse(xaiMock.mock.calls[0][1].body as string) as { reasoning_effort: string })
        .reasoning_effort,
    ).toBe('xhigh');
    vi.unstubAllGlobals();

    const openaiMock = vi.fn().mockResolvedValue(openaiResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', openaiMock);
    await generateNewscastScript({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5.6-sol',
      effort: 'max',
      articles: [SAMPLE_ARTICLE],
    });
    expect(
      (JSON.parse(openaiMock.mock.calls[0][1].body as string) as { reasoning_effort: string })
        .reasoning_effort,
    ).toBe('max');
  });

  it("passes 'none' through to OpenAI and folds it to the floor everywhere else", async () => {
    // OpenAI is the only provider whose ladder has 'none' (verified live
    // 2026-08-13) — it must pass through unmapped.
    const openaiMock = vi.fn().mockResolvedValue(openaiResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', openaiMock);
    await generateNewscastScript({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      effort: 'none',
      articles: [SAMPLE_ARTICLE],
    });
    expect(
      (JSON.parse(openaiMock.mock.calls[0][1].body as string) as { reasoning_effort: string })
        .reasoning_effort,
    ).toBe('none');
    vi.unstubAllGlobals();

    // Grok cannot disable reasoning — 'none' folds to 'low' instead of 400ing.
    const xaiMock = vi.fn().mockResolvedValue(openaiResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', xaiMock);
    await generateNewscastScript({
      provider: 'xai',
      apiKey: 'k',
      model: 'grok-4.5',
      effort: 'none',
      articles: [SAMPLE_ARTICLE],
    });
    expect(
      (JSON.parse(xaiMock.mock.calls[0][1].body as string) as { reasoning_effort: string })
        .reasoning_effort,
    ).toBe('low');
  });

  it('routes through the AI Gateway as `grok/v1/chat/completions` (keeping xAI\'s own /v1)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openaiResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);
    await generateNewscastScript({
      provider: 'xai',
      apiKey: 'k',
      model: 'grok-4.5',
      articles: [SAMPLE_ARTICLE],
      gateway: SAMPLE_GATEWAY,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/grok/v1/chat/completions',
    );
  });
});

// ---------------------------------------------------------------------------
// Transport injection (design §3.1/§5.1) — the key stays in the vault
// ---------------------------------------------------------------------------

/** A transport that records the spec it was handed and replies with `body`. */
function recordingTransport(body: string, status = 200): {
  transport: ProviderTransport;
  specifications: ProviderRequestSpecification[];
} {
  const specifications: ProviderRequestSpecification[] = [];
  const transport: ProviderTransport = async (request) => {
    specifications.push(request);
    return { status, body };
  };
  return { transport, specifications };
}

describe('provider transport', () => {
  it('builds a credential-free spec per provider and never calls fetch itself', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const anthropic = recordingTransport(
      JSON.stringify({ content: [{ type: 'text', text: ONE_LINE_RESPONSE }] }),
    );
    await generateNewscastScript({
      provider: 'anthropic',
      transport: anthropic.transport,
      model: 'claude-opus-5',
      articles: [SAMPLE_ARTICLE],
    });
    expect(anthropic.specifications[0].path).toBe('v1/messages');
    expect(anthropic.specifications[0].method).toBe('POST');
    // `anthropic-version` is required by the API and is not a credential, so it
    // rides along; the key header must NOT be here — the vault adds it.
    expect(anthropic.specifications[0].headers).toEqual({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });

    const openai = recordingTransport(
      JSON.stringify({ choices: [{ message: { content: ONE_LINE_RESPONSE } }] }),
    );
    await generateNewscastScript({
      provider: 'openai',
      transport: openai.transport,
      model: 'gpt-5.6-sol',
      articles: [SAMPLE_ARTICLE],
    });
    expect(openai.specifications[0].path).toBe('v1/chat/completions');

    const xai = recordingTransport(
      JSON.stringify({ choices: [{ message: { content: ONE_LINE_RESPONSE } }] }),
    );
    await generateNewscastScript({
      provider: 'xai',
      transport: xai.transport,
      model: 'grok-4.5',
      articles: [SAMPLE_ARTICLE],
    });
    // Provider-relative: the ORIGIN is the vault's decision, never a path this
    // package hands over — that is the SSRF boundary the design draws.
    expect(xai.specifications[0].path).toBe('v1/chat/completions');

    const google = recordingTransport(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: ONE_LINE_RESPONSE }] } }] }),
    );
    await generateNewscastScript({
      provider: 'google',
      transport: google.transport,
      model: 'gemini-3.6-flash',
      articles: [SAMPLE_ARTICLE],
    });
    expect(google.specifications[0].path).toBe(
      'v1beta/models/gemini-3.6-flash:generateContent',
    );

    for (const specification of [
      ...anthropic.specifications,
      ...openai.specifications,
      ...xai.specifications,
      ...google.specifications,
    ]) {
      const headerNames = Object.keys(specification.headers ?? {}).map((name) =>
        name.toLowerCase(),
      );
      expect(headerNames).not.toContain('authorization');
      expect(headerNames).not.toContain('x-api-key');
      expect(headerNames).not.toContain('x-goog-api-key');
      expect(JSON.stringify(specification)).not.toContain('Bearer');
    }
    // Nothing went out over the wire from this package.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a transported response exactly like a direct one', async () => {
    const { transport } = recordingTransport(
      JSON.stringify({
        choices: [{ message: { content: ONE_LINE_RESPONSE } }],
        usage: { prompt_tokens: 11, completion_tokens: 22 },
      }),
    );
    const result = await generateNewscastScript({
      provider: 'xai',
      transport,
      model: 'grok-4.5',
      articles: [SAMPLE_ARTICLE],
    });
    expect(result.lines).toEqual([{ speaker: 1, text: '안녕하세요.' }]);
    expect(result.promptTokens).toBe(11);
    expect(result.completionTokens).toBe(22);
  });

  it('still demands a credential when neither a key nor a transport is given', async () => {
    await expect(
      generateNewscastScript({
        provider: 'openai',
        articles: [SAMPLE_ARTICLE],
      }),
    ).rejects.toThrow('generateNewscastScript: apiKey is required.');
  });
});

describe('a refused credential (401/403) is terminal, not retried (design §5.4)', () => {
  it('throws ProviderRequestError carrying the status after exactly ONE provider call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(failedResponse(401, OPENAI_401_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const error = await generateNewscastScript({
      provider: 'openai',
      apiKey: 'sk-bad',
      model: 'gpt-5.6-sol',
      articles: [SAMPLE_ARTICLE],
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as ProviderRequestError).status).toBe(401);
    expect(isProviderCredentialRejection(error)).toBe(true);
    // The bad key is presented ONCE. Re-presenting it is how a user's own
    // provider account gets locked for credential stuffing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // And the key the provider echoed back is masked even here.
    expect((error as Error).message).not.toContain('sk-proj');
  });

  it('classifies a 403 the same way, and a 500 differently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failedResponse(403, 'forbidden')));
    const forbidden = await generateNewscastScript({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-opus-5',
      articles: [SAMPLE_ARTICLE],
    }).catch((thrown: unknown) => thrown);
    expect(isProviderCredentialRejection(forbidden)).toBe(true);
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failedResponse(500, 'boom')));
    const serverError = await generateNewscastScript({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-opus-5',
      articles: [SAMPLE_ARTICLE],
    }).catch((thrown: unknown) => thrown);
    // A 500 IS retryable — the durable step should get its attempts back.
    expect(isProviderCredentialRejection(serverError)).toBe(false);
    expect(serverError).toBeInstanceOf(ProviderRequestError);
  });

  it('reports a rejection relayed through a transport identically', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { transport, specifications } = recordingTransport(OPENAI_401_BODY, 401);

    const error = await generateNewscastPartScript({
      provider: 'xai',
      transport,
      model: 'grok-4.5',
      articles: [SAMPLE_ARTICLE],
      units: [],
      plan: { index: 1, unitIndexes: [], turnTarget: 30 },
      partCount: 1,
    }).catch((thrown: unknown) => thrown);

    expect(isProviderCredentialRejection(error)).toBe(true);
    expect((error as ProviderRequestError).status).toBe(401);
    expect((error as Error).message).toContain('xAI request failed (401)');
    expect((error as Error).message).not.toContain('sk-proj');
    expect(specifications).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AI Gateway routing (design 2026-07-29-ai-gateway-egress)', () => {
  it('REGRESSION: with no gateway configured, every provider keeps its direct URL', async () => {
    // Anthropic
    {
      const fetchMock = vi.fn().mockResolvedValue(anthropicResponse(ONE_LINE_RESPONSE));
      vi.stubGlobal('fetch', fetchMock);
      await generateNewscastScript({
        provider: 'anthropic',
        apiKey: 'k',
        model: 'claude-haiku-4-5',
        articles: [SAMPLE_ARTICLE],
      });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
      vi.unstubAllGlobals();
    }
    // OpenAI
    {
      const fetchMock = vi.fn().mockResolvedValue(openaiResponse(ONE_LINE_RESPONSE));
      vi.stubGlobal('fetch', fetchMock);
      await generateNewscastScript({
        provider: 'openai',
        apiKey: 'k',
        model: 'gpt-5.6-sol',
        articles: [SAMPLE_ARTICLE],
      });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
      vi.unstubAllGlobals();
    }
    // Google — no gateway means no `?key=` query string either (§4: the x-goog-api-key
    // header is used in both modes).
    {
      const fetchMock = vi.fn().mockResolvedValue(geminiResponse(ONE_LINE_RESPONSE));
      vi.stubGlobal('fetch', fetchMock);
      await generateNewscastScript({
        provider: 'google',
        apiKey: 'secret-key',
        model: 'gemini-3.6-flash',
        articles: [SAMPLE_ARTICLE],
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      );
      expect(url).not.toContain('key=');
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
      vi.unstubAllGlobals();
    }
  });

  it('Anthropic: routes through the gateway keeping its own /v1 suffix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    await generateNewscastScript({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      articles: [SAMPLE_ARTICLE],
      gateway: SAMPLE_GATEWAY,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/messages',
    );
  });

  it('OpenAI: routes through the gateway DROPPING its own /v1 (the gateway base already ends in /v1)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(openaiResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    await generateNewscastScript({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5.6-sol',
      articles: [SAMPLE_ARTICLE],
      gateway: SAMPLE_GATEWAY,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/openai/chat/completions',
    );
  });

  it('Google: routes through the gateway via google-ai-studio, with no key= and the x-goog-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    await generateNewscastScript({
      provider: 'google',
      apiKey: 'secret-key',
      model: 'gemini-3.6-flash',
      articles: [SAMPLE_ARTICLE],
      gateway: SAMPLE_GATEWAY,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent',
    );
    expect(url).not.toContain('key=');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
  });

  it('normalizes a trailing slash on the gateway baseUrl so no // appears in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicResponse(ONE_LINE_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    await generateNewscastScript({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      articles: [SAMPLE_ARTICLE],
      gateway: { baseUrl: 'https://gateway.ai.cloudflare.com/v1/acc/gw/' },
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/messages');
    expect(url).not.toContain('//anthropic');
  });

  it('adds cf-aig-authorization only when the gateway carries a token', async () => {
    // With a token.
    {
      const fetchMock = vi.fn().mockResolvedValue(anthropicResponse(ONE_LINE_RESPONSE));
      vi.stubGlobal('fetch', fetchMock);
      await generateNewscastScript({
        provider: 'anthropic',
        apiKey: 'k',
        model: 'claude-haiku-4-5',
        articles: [SAMPLE_ARTICLE],
        gateway: { ...SAMPLE_GATEWAY, token: 'gw-token' },
      });
      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>)['cf-aig-authorization']).toBe(
        'Bearer gw-token',
      );
      vi.unstubAllGlobals();
    }
    // Without a token (gateway configured, but open).
    {
      const fetchMock = vi.fn().mockResolvedValue(anthropicResponse(ONE_LINE_RESPONSE));
      vi.stubGlobal('fetch', fetchMock);
      await generateNewscastScript({
        provider: 'anthropic',
        apiKey: 'k',
        model: 'claude-haiku-4-5',
        articles: [SAMPLE_ARTICLE],
        gateway: SAMPLE_GATEWAY,
      });
      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>)['cf-aig-authorization']).toBeUndefined();
    }
  });

  it('threads gateway through generateNewscastPartScript and generateNewscastOrganization too', async () => {
    // Part script.
    {
      const fetchMock = vi.fn().mockResolvedValue(anthropicResponse(ONE_LINE_RESPONSE));
      vi.stubGlobal('fetch', fetchMock);
      const plan: NewscastPartPlan = { index: 1, unitIndexes: [], turnTarget: 41 };
      await generateNewscastPartScript({
        provider: 'anthropic',
        apiKey: 'k',
        model: 'claude-haiku-4-5',
        articles: [SAMPLE_ARTICLE],
        units: [],
        plan,
        partCount: 1,
        gateway: SAMPLE_GATEWAY,
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/messages',
      );
      vi.unstubAllGlobals();
    }
    // Organization.
    {
      const fetchMock = vi.fn().mockResolvedValue(
        anthropicResponse('{ "units": [ { "kind": "fact", "headline": "H", "detail": "D", "weight": 3 } ] }'),
      );
      vi.stubGlobal('fetch', fetchMock);
      await generateNewscastOrganization({
        provider: 'anthropic',
        apiKey: 'k',
        model: 'claude-haiku-4-5',
        articles: [SAMPLE_ARTICLE],
        gateway: SAMPLE_GATEWAY,
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/messages',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Provider error redaction (design 2026-08-10-per-user-provider-keys §1.3)
// ---------------------------------------------------------------------------

/** A failed provider `Response` whose body and headers a test fully controls. */
function failedResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: new Headers(headers),
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  } as unknown as Response;
}

/** The real shape OpenAI returns on a bad key — it echoes the key back. */
const LEAKED_OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789xyz';
const OPENAI_401_BODY = JSON.stringify({
  error: {
    message: `Incorrect API key provided: ${LEAKED_OPENAI_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
});

/** Run a generation that is guaranteed to fail, and return the thrown message. */
async function messageFromFailedCall(
  provider: 'anthropic' | 'openai' | 'google',
  response: Response,
): Promise<string> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const model =
    provider === 'anthropic'
      ? 'claude-haiku-4-5'
      : provider === 'openai'
        ? 'gpt-5.6-sol'
        : 'gemini-3.5-flash';
  try {
    await generateNewscastScript({
      provider,
      apiKey: 'k',
      model,
      articles: [SAMPLE_ARTICLE],
    });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the provider call to fail');
}

describe('redactProviderText', () => {
  it('masks every provider key prefix', () => {
    expect(redactProviderText(`key=${LEAKED_OPENAI_KEY}`)).toBe('key=sk-[REDACTED]');
    expect(redactProviderText('sk-ant-api03-AAaaBBbbCCcc-99')).toBe('sk-[REDACTED]');
    expect(redactProviderText('AIzaSyD-1234567890abcdefgHIJKLmnop')).toBe('AIza[REDACTED]');
    expect(redactProviderText('xai-abcdef1234567890ABCDEF')).toBe('xai-[REDACTED]');
  });

  it('collapses a Bearer authorization value into one placeholder', () => {
    expect(redactProviderText(`Authorization: Bearer ${LEAKED_OPENAI_KEY}`)).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redactProviderText('bearer eyJhbGciOiJIUzI1NiJ9.payload.signature')).toBe(
      'Bearer [REDACTED]',
    );
  });

  it('masks the shapes providers really echo back', () => {
    // OpenAI's own asterisk-masked form, the organization / project identifiers
    // that travel with a key, and OAuth access tokens.
    expect(redactProviderText('sk-***abcd')).toBe('sk-[REDACTED]');
    expect(redactProviderText('org-9dF2kQwErTyUiOpA')).toBe('org-[REDACTED]');
    expect(redactProviderText('proj_9dF2kQwErTyUiOpA')).toBe('proj_[REDACTED]');
    expect(redactProviderText('ya29.a0AfB_byC1234567890-_abcdef')).toBe('ya29.[REDACTED]');
    expect(redactProviderText('gho_16C7e42F292c6912E7710c838347Ae178B4a')).toBe('gh_[REDACTED]');
  });

  it('leaves ordinary diagnostic text untouched', () => {
    expect(redactProviderText('invalid_api_key (401)')).toBe('invalid_api_key (401)');
    expect(redactProviderText('after the reorg-chart landed')).toBe('after the reorg-chart landed');
  });
});

describe('provider error bodies never leak an API key', () => {
  it('masks the key OpenAI echoes in its 401 body, keeping status and request-id', async () => {
    const message = await messageFromFailedCall(
      'openai',
      failedResponse(401, OPENAI_401_BODY, { 'x-request-id': 'req_abc123' }),
    );

    expect(message).not.toContain(LEAKED_OPENAI_KEY);
    expect(message).not.toContain('sk-proj');
    expect(message).toContain('sk-[REDACTED]');
    // Diagnostics that must survive redaction.
    expect(message).toContain('OpenAI request failed (401)');
    expect(message).toContain('[request-id: req_abc123]');
    expect(message).toContain('invalid_request_error');
  });

  it('masks an Anthropic key and keeps the request-id header', async () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'invalid x-api-key sk-ant-api03-ZZzz9900-Aa',
      },
    });
    const message = await messageFromFailedCall(
      'anthropic',
      failedResponse(401, body, { 'request-id': 'req_anthropic_9' }),
    );

    expect(message).not.toContain('sk-ant-api03-ZZzz9900-Aa');
    expect(message).toContain('sk-[REDACTED]');
    expect(message).toContain('Anthropic request failed (401)');
    expect(message).toContain('[request-id: req_anthropic_9]');
  });

  it('masks a Google key echoed in a Gemini 400 body', async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid: AIzaSyD-1234567890abcdefgHIJKLmnop',
        status: 'INVALID_ARGUMENT',
      },
    });
    const message = await messageFromFailedCall('google', failedResponse(400, body));

    expect(message).not.toContain('AIzaSyD-1234567890abcdefgHIJKLmnop');
    expect(message).toContain('AIza[REDACTED]');
    expect(message).toContain('Gemini request failed (400)');
  });

  it('truncates the body to 200 characters plus a truncation marker', async () => {
    const message = await messageFromFailedCall('openai', failedResponse(500, 'x'.repeat(2000)));

    const bodyPart = message.slice(message.indexOf('): ') + '): '.length);
    expect(bodyPart.endsWith('… [truncated]')).toBe(true);
    expect(bodyPart.length).toBe(200 + '… [truncated]'.length);
    expect(message).toContain('OpenAI request failed (500)');
  });

  it('reports an empty body instead of a dangling separator', async () => {
    const message = await messageFromFailedCall('openai', failedResponse(503, '   '));
    expect(message).toBe('OpenAI request failed (503): <empty response body>');
  });
});
