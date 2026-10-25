import { describe, expect, it } from 'vitest';
import { ProviderRequestError } from '@audio-underview/newscast-script';

import {
  ProviderKeyBlockedError,
  StageFailureError,
  buildFailureDetails,
  classifyJobErrorCode,
} from '../sources/failure-details.ts';

const AT = '2026-07-14T05:00:00.000Z';

describe('buildFailureDetails', () => {
  it('extracts stop_reason from a truncation-tagged script error', () => {
    const error = new Error(
      'generateNewscastScript: failed to parse any script lines from the anthropic/claude-haiku-4-5 ' +
        'response (len=5328) [TRUNCATED: stop_reason=max_tokens — output hit the token cap]. Raw: "..."',
    );
    const failure = buildFailureDetails('script', error, AT);
    expect(failure).toEqual({
      stage: 'script',
      message: error.message,
      stopReason: 'max_tokens',
      at: AT,
    });
  });

  it('extracts a plain stop_reason tag', () => {
    const failure = buildFailureDetails('script', new Error('parse failed [stop_reason=end_turn]. Raw: "x"'), AT);
    expect(failure.stopReason).toBe('end_turn');
  });

  it('carries the failed chunk index from a StageFailureError', () => {
    const error = new StageFailureError('TTS chunk 3/5: Gemini TTS request failed (400)', {
      failedChunk: 2,
    });
    const failure = buildFailureDetails('tts', error, AT);
    expect(failure.failedChunk).toBe(2);
    expect(failure.stage).toBe('tts');
    expect(failure.stopReason).toBeUndefined();
  });

  it('handles plain errors and non-Error throwables', () => {
    expect(buildFailureDetails('merge', new Error('boom'), AT)).toEqual({
      stage: 'merge',
      message: 'boom',
      at: AT,
    });
    expect(buildFailureDetails('merge', 'string throw', AT).message).toBe('string throw');
  });

  // -------------------------------------------------------------------------
  // Sink-side masking (design 2026-08-10-per-user-provider-keys §1.3)
  //
  // This is the LAST place every stage error passes through before it is
  // persisted into the newscast row, so the masking is asserted here rather than only at the
  // individual provider call sites — it is what covers the Lyria throw in
  // workflow.ts and any future call site.
  // -------------------------------------------------------------------------

  it('masks the key an OpenAI 401 body echoes back, keeping the diagnosis', () => {
    const leakedKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789xyz';
    const failure = buildFailureDetails(
      'merge',
      new Error(
        `Transcription request failed: 401 Unauthorized {"error":{"message":"Incorrect API key provided: ${leakedKey}.","code":"invalid_api_key"}}`,
      ),
      AT,
    );
    expect(failure.message).not.toContain(leakedKey);
    expect(failure.message).not.toContain('sk-proj');
    expect(failure.message).toContain('sk-[REDACTED]');
    expect(failure.message).toContain('401 Unauthorized');
    expect(failure.message).toContain('invalid_api_key');
  });

  it('masks the asterisk-masked, organization, and OAuth shapes too', () => {
    const failure = buildFailureDetails(
      'tts',
      new Error(
        'Gemini TTS request failed (403): key sk-***abcd of org-9dF2kQwErTyUiOpA ' +
          '(proj_aBcD1234) with token ya29.a0AfB_byC1234567890 is not permitted',
      ),
      AT,
    );
    expect(failure.message).not.toContain('sk-***abcd');
    expect(failure.message).not.toContain('org-9dF2kQwErTyUiOpA');
    expect(failure.message).not.toContain('proj_aBcD1234');
    expect(failure.message).not.toContain('ya29.a0AfB');
    expect(failure.message).toContain('sk-[REDACTED]');
    expect(failure.message).toContain('org-[REDACTED]');
    expect(failure.message).toContain('proj_[REDACTED]');
    expect(failure.message).toContain('ya29.[REDACTED]');
  });

  it('caps a pathologically long message', () => {
    const failure = buildFailureDetails('script', new Error('x'.repeat(10_000)), AT);
    expect(failure.message.length).toBeLessThan(2_100);
    expect(failure.message.endsWith('… [truncated]')).toBe(true);
  });

  it('still finds the stop reason when the cap clips the message', () => {
    // The truncation hint sits at the front of a parse-failure message and the
    // raw model snippet trails it, so the signal must survive the cap.
    const failure = buildFailureDetails(
      'script',
      new Error(
        `parse failed [TRUNCATED: stop_reason=max_tokens — output hit the token cap]. Raw: "${'가'.repeat(5_000)}"`,
      ),
      AT,
    );
    expect(failure.stopReason).toBe('max_tokens');
    expect(failure.message.endsWith('… [truncated]')).toBe(true);
  });
});

describe('classifyJobErrorCode (design §5.4)', () => {
  it("maps the pipeline's own blocked-credential error to blocked_no_key", () => {
    expect(
      classifyJobErrorCode(
        new ProviderKeyBlockedError('xai', 'no key is registered for this provider.'),
      ),
    ).toBe('blocked_no_key');
  });

  it('maps a raw provider 401/403 to blocked_no_key, and other statuses to the generic bucket', () => {
    // Belt and braces: the code the user sees must not depend on which layer
    // noticed the rejection first.
    expect(classifyJobErrorCode(new ProviderRequestError('OpenAI request failed (401)', 401))).toBe(
      'blocked_no_key',
    );
    expect(classifyJobErrorCode(new ProviderRequestError('failed (403)', 403))).toBe(
      'blocked_no_key',
    );
    // A rate limit and a provider outage are both retryable — the durable step
    // must keep its attempts for them.
    expect(classifyJobErrorCode(new ProviderRequestError('failed (429)', 429))).toBe(
      'pipeline_failed',
    );
    expect(classifyJobErrorCode(new ProviderRequestError('failed (500)', 500))).toBe(
      'pipeline_failed',
    );
  });

  it('sees through the wrapper a stage puts around its failure', () => {
    const wrapped = new StageFailureError('TTS chunk 1/3 failed', {
      cause: new ProviderKeyBlockedError('google', 'the provider rejected the API key (HTTP 401).'),
    });
    expect(classifyJobErrorCode(wrapped)).toBe('blocked_no_key');
  });

  it('never guesses from message text', () => {
    // A parse failure that merely QUOTES a 401 body is not a credential problem;
    // classifying on words instead of types would have made it one.
    expect(
      classifyJobErrorCode(new Error('failed to parse any script lines. Raw: "{"code":401}"')),
    ).toBe('pipeline_failed');
    expect(classifyJobErrorCode('a thrown string')).toBe('pipeline_failed');
    expect(classifyJobErrorCode(undefined)).toBe('pipeline_failed');
  });
});
