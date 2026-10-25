import { describe, expect, it } from 'vitest';

import type { JobErrorCode, LlmProvider, ProviderTransport } from './index.ts';
import {
  JOB_ERROR_CODES,
  LLM_PROVIDERS,
  PROVIDER_TEXT_MAXIMUM_LENGTH,
  ProviderRequestError,
  isProviderCredentialRejection,
  parseJobErrorCode,
  redactAndTruncate,
  redactSecrets,
  truncateText,
} from './index.ts';

/** The key an OpenAI 401 body echoes back verbatim. */
const LEAKED_OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789xyz';

/** A real OpenAI 401 body: the offending key is quoted inside the JSON. */
const OPENAI_401_BODY = `{"error":{"message":"Incorrect API key provided: ${LEAKED_OPENAI_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}`;

/** A structurally real HS256 JWT — the shape this worker's own session/media tokens have. */
const SESSION_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTUxMTEifQ.' +
  'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('redactSecrets', () => {
  it('masks every provider key prefix', () => {
    expect(redactSecrets(`key=${LEAKED_OPENAI_KEY}`)).toBe('key=sk-[REDACTED]');
    expect(redactSecrets('sk-ant-api03-AAaaBBbbCCcc-99')).toBe('sk-[REDACTED]');
    expect(redactSecrets('AIzaSyD-1234567890abcdefgHIJKLmnop')).toBe('AIza[REDACTED]');
    expect(redactSecrets('xai-abcdef1234567890ABCDEF')).toBe('xai-[REDACTED]');
    // Underscore key shapes: `sk_live_…` and Groq's `gsk_…`.
    expect(redactSecrets('sk_live_51H8xYzAbCdEfGhIj')).toBe('sk_[REDACTED]');
    expect(redactSecrets('gsk_aBcD1234EfGh5678IjKl')).toBe('gsk_[REDACTED]');
  });

  it("masks Google's newer AQ. / IQ. key prefixes, not just AIza (design §3.3)", () => {
    // §3.3 names these as the reason a strict `AIza` FORMAT check would reject
    // real keys. The same fact makes them a masking gap: a Google 400 quotes back
    // whichever shape it was handed, and this deployment's TTS/Lyria/script calls
    // all run on a Google key.
    expect(redactSecrets('AQ.Ab8RN6Jz9QwErTyUiOpAsDfGhJkL')).toBe('AQ.[REDACTED]');
    expect(redactSecrets('IQ.Ab8RN6Jz9QwErTyUiOpAsDfGhJkL')).toBe('IQ.[REDACTED]');
    expect(
      redactSecrets('API key not valid: AQ.Ab8RN6-a_b.c1234 for this project'),
    ).toBe('API key not valid: AQ.[REDACTED] for this project');
    // The dot is INSIDE the credential class, so a multi-segment key is consumed
    // whole rather than leaving its tail in the log.
    expect(redactSecrets('AQ.Ab8RN6.9QwErTyUiOp')).toBe('AQ.[REDACTED]');
  });

  it('leaves ordinary words that merely end in AQ/IQ alone', () => {
    // `\b` is what keeps the rule off prose: there is no boundary inside "FAQ".
    expect(redactSecrets('see the FAQ.Section2 for details')).toBe(
      'see the FAQ.Section2 for details',
    );
  });

  it('masks a three-segment JWT — our own session and media tokens have that shape', () => {
    // A rejected bearer quoted into an auth error used to sail through the
    // scrubber untouched, publishing a LIVE credential of this deployment.
    expect(redactSecrets(`rejected token ${SESSION_JWT}`)).toBe('rejected token eyJ[REDACTED]');
    expect(redactSecrets(SESSION_JWT)).toBe('eyJ[REDACTED]');
  });

  it('masks the whole OpenAI 401 body while the diagnosis survives', () => {
    const masked = redactSecrets(OPENAI_401_BODY);
    expect(masked).not.toContain(LEAKED_OPENAI_KEY);
    expect(masked).not.toContain('sk-proj');
    expect(masked).toContain('sk-[REDACTED]');
    expect(masked).toContain('invalid_api_key');
  });

  it("masks OpenAI's own asterisk-masked key form", () => {
    // The dashboard / some error bodies echo the key already partially hidden.
    // The surviving tail is still a fingerprint, so it must not reach a sink.
    expect(redactSecrets('sk-***abcd')).toBe('sk-[REDACTED]');
    expect(redactSecrets('sk-proj-****************abcd')).toBe('sk-[REDACTED]');
    expect(redactSecrets('sk-••••••••abcd')).toBe('sk-[REDACTED]');
  });

  it('masks organization and project identifiers', () => {
    expect(redactSecrets('org-9dF2kQwErTyUiOpA')).toBe('org-[REDACTED]');
    expect(redactSecrets('proj_9dF2kQwErTyUiOpA')).toBe('proj_[REDACTED]');
    expect(
      redactSecrets('You have insufficient quota in org-9dF2kQwErTyUiOpA (proj_aBcD1234).'),
    ).toBe('You have insufficient quota in org-[REDACTED] (proj_[REDACTED]).');
  });

  it('masks OAuth access tokens now that they travel as credentials', () => {
    expect(redactSecrets('ya29.a0AfB_byC1234567890-_abcdef')).toBe('ya29.[REDACTED]');
    expect(redactSecrets('gho_16C7e42F292c6912E7710c838347Ae178B4a')).toBe('gh_[REDACTED]');
    expect(redactSecrets('ghp_16C7e42F292c6912E7710c838347Ae178B4a')).toBe('gh_[REDACTED]');
    expect(redactSecrets('ghu_16C7e42F292c6912E7710c838347Ae178B4a')).toBe('gh_[REDACTED]');
    expect(redactSecrets('ghs_16C7e42F292c6912E7710c838347Ae178B4a')).toBe('gh_[REDACTED]');
    // ghr_ is the REFRESH token — longer-lived than the access token it renews.
    expect(redactSecrets('ghr_16C7e42F292c6912E7710c838347Ae178B4a')).toBe('gh_[REDACTED]');
  });

  it('collapses a Bearer authorization value into one placeholder', () => {
    expect(redactSecrets(`Authorization: Bearer ${LEAKED_OPENAI_KEY}`)).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redactSecrets('bearer eyJhbGciOiJIUzI1NiJ9.payload.signature')).toBe(
      'Bearer [REDACTED]',
    );
  });

  it('leaves ordinary diagnostic text untouched', () => {
    expect(redactSecrets('invalid_api_key (401)')).toBe('invalid_api_key (401)');
    expect(redactSecrets('stop_reason=max_tokens')).toBe('stop_reason=max_tokens');
    // `\b`-anchored identifier rules must not trip on ordinary prose.
    expect(redactSecrets('after the reorg-chart landed')).toBe('after the reorg-chart landed');
  });

  it('never mutilates a word that merely CONTAINS a credential prefix', () => {
    // Un-anchored, the `sk-` rule matched inside these words and published
    // "task-[REDACTED] scheduling" — masking that eats the diagnosis it exists
    // to protect. Every one of them must survive byte-for-byte.
    expect(redactSecrets('task-force scheduling')).toBe('task-force scheduling');
    expect(redactSecrets('risk-score too high')).toBe('risk-score too high');
    expect(redactSecrets('disk-usage exceeded')).toBe('disk-usage exceeded');
    expect(redactSecrets('desk_assignment pending')).toBe('desk_assignment pending');
  });
});

describe('truncateText', () => {
  it('leaves text at or under the cap untouched', () => {
    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('exactlyten', 10)).toBe('exactlyten');
  });

  it('caps longer text and marks the cut', () => {
    expect(truncateText('a'.repeat(30), 10)).toBe(`${'a'.repeat(10)}… [truncated]`);
  });

  it('defaults to the provider-text cap', () => {
    const capped = truncateText('b'.repeat(PROVIDER_TEXT_MAXIMUM_LENGTH + 50));
    expect(capped.startsWith('b'.repeat(PROVIDER_TEXT_MAXIMUM_LENGTH))).toBe(true);
    expect(capped).toBe(`${'b'.repeat(PROVIDER_TEXT_MAXIMUM_LENGTH)}… [truncated]`);
  });
});

describe('LLM_PROVIDERS (per-user-provider-keys design §2)', () => {
  it('carries xAI alongside the original three', () => {
    expect(LLM_PROVIDERS).toEqual(['anthropic', 'openai', 'google', 'xai']);
  });

  it('is assignable to the LlmProvider union it enumerates', () => {
    // A compile-time pin as much as a runtime one: if the union and the list ever
    // disagree, this stops typechecking rather than silently under-listing a
    // provider the worker would then reject as an unknown override.
    const providers: readonly LlmProvider[] = LLM_PROVIDERS;
    expect(providers).toContain('xai');
  });
});

describe('parseJobErrorCode (design §5.4)', () => {
  it('accepts every code in the closed vocabulary', () => {
    for (const code of JOB_ERROR_CODES) {
      expect(parseJobErrorCode(code)).toBe(code);
    }
    expect(JOB_ERROR_CODES).toContain('blocked_no_key');
  });

  it('rejects anything outside it, so a stale stored value degrades instead of leaking a branch', () => {
    // These arrive from a `details` JSON blob written by some other deployment —
    // the web must never receive a code it has no UI for.
    expect(parseJobErrorCode('quota_exhausted')).toBeUndefined();
    expect(parseJobErrorCode('')).toBeUndefined();
    expect(parseJobErrorCode(undefined)).toBeUndefined();
    expect(parseJobErrorCode(null)).toBeUndefined();
    expect(parseJobErrorCode(7)).toBeUndefined();
    expect(parseJobErrorCode({ code: 'blocked_no_key' })).toBeUndefined();
  });

  it('narrows to the JobErrorCode type', () => {
    const parsed: JobErrorCode | undefined = parseJobErrorCode('blocked_no_key');
    expect(parsed).toBe('blocked_no_key');
  });
});

describe('the credential-free provider transport (design §5.1/§5.2)', () => {
  it('classifies only 401/403 as a refused credential', () => {
    expect(isProviderCredentialRejection(new ProviderRequestError('refused', 401))).toBe(true);
    expect(isProviderCredentialRejection(new ProviderRequestError('refused', 403))).toBe(true);
    expect(isProviderCredentialRejection(new ProviderRequestError('overloaded', 529))).toBe(
      false,
    );
    expect(isProviderCredentialRejection(new Error('socket hang up'))).toBe(false);
  });

  it('describes a call with no place to put a credential', async () => {
    // The shape is the point: a spec carries a provider-RELATIVE path and a body,
    // so a package holding one cannot name a host or attach a key. `bodyBase64`
    // is what lets a binary (multipart) call use the same seam.
    const seen: string[] = [];
    const transport: ProviderTransport = async (request) => {
      seen.push(request.path);
      expect(request.bodyBase64).toBe(btoa('binary-ish'));
      expect(JSON.stringify(request)).not.toContain('sk-');
      return { status: 200, body: '{"words":[]}' };
    };

    const response = await transport({
      path: 'v1/audio/transcriptions',
      method: 'POST',
      bodyBase64: btoa('binary-ish'),
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });

    expect(seen).toEqual(['v1/audio/transcriptions']);
    expect(response.status).toBe(200);
  });
});

describe('redactAndTruncate', () => {
  it('masks BEFORE capping so a cut can never leave a usable key prefix', () => {
    // The key straddles the cap: masking it first turns it into a placeholder
    // (which the cut may then clip), whereas capping first would have published
    // `sk-proj-abcdefghij…` verbatim. The space before the key is load-bearing —
    // the `\b`-anchored rules only see a credential that starts a word, which is
    // how every provider body quotes one ("…provided: sk-proj-…").
    const straddling = `${'x'.repeat(PROVIDER_TEXT_MAXIMUM_LENGTH - 11)} ${LEAKED_OPENAI_KEY}`;
    expect(redactAndTruncate(straddling)).not.toContain('sk-proj');

    // Well inside the cap, the placeholder survives intact.
    expect(redactAndTruncate(`quota exceeded for ${LEAKED_OPENAI_KEY}`)).toBe(
      'quota exceeded for sk-[REDACTED]',
    );
  });

  it('caps a long masked body', () => {
    const result = redactAndTruncate('y'.repeat(1_000));
    expect(result.length).toBe(PROVIDER_TEXT_MAXIMUM_LENGTH + '… [truncated]'.length);
  });
});
