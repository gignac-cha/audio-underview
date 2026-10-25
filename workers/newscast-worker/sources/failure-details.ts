/**
 * Failure diagnosis for the newscast pipeline: turns a thrown stage error into
 * the persisted {@link JobFailureDetails} record (`details.failure` of the
 * newscast row), so a failure stays queryable after Cloudflare's short
 * console-log retention.
 */

import type {
  JobErrorCode,
  JobFailureDetails,
  LlmProvider,
  NewscastStage,
} from '@audio-underview/newscast-core';
import { redactSecrets, truncateText } from '@audio-underview/newscast-core';
import { isProviderCredentialRejection } from '@audio-underview/newscast-script';

/**
 * A stage error carrying structured failure context that a plain `Error` cannot.
 * Currently: the zero-based TTS chunk index that failed, so the debug panel can
 * say "chunk 3 of 5" instead of leaving the failing chunk a mystery.
 */
export class StageFailureError extends Error {
  failedChunk?: number;

  constructor(
    message: string,
    options?: { failedChunk?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'StageFailureError';
    if (options?.failedChunk !== undefined) {
      this.failedChunk = options.failedChunk;
    }
  }
}

/**
 * The newscast is over because the CREDENTIAL is the problem — the provider refused
 * it (401/403), or there was none to use (per-user-provider-keys design §5.4).
 *
 * Terminal by construction, not by policy: the pipeline turns a credential
 * rejection into this error OUTSIDE the durable step that hit it, so the step's
 * three retries can never fire against a key the provider already rejected. That
 * matters more than the tidy status code — repeatedly re-presenting a bad key is
 * how a user's own provider account gets locked for credential stuffing.
 *
 * The message never carries the provider's body: a 401 body routinely quotes the
 * offending key, and this text is the one the newscast's `error` column shows.
 */
export class ProviderKeyBlockedError extends Error {
  readonly provider: LlmProvider;
  /** The reason WITHOUT the provider prefix, so it can be re-wrapped once. */
  readonly detail: string;

  constructor(provider: LlmProvider, detail: string) {
    super(`${provider}: ${detail}`);
    this.name = 'ProviderKeyBlockedError';
    this.provider = provider;
    this.detail = detail;
  }
}

/**
 * Classify a newscast-ending error into the SAFE, closed {@link JobErrorCode}
 * vocabulary the web branches on — never the provider's own words (design §1.3).
 *
 * Two shapes map to `blocked_no_key`: the pipeline's own
 * {@link ProviderKeyBlockedError}, and a raw 401/403 from the script package that
 * somehow reached the top without being converted (belt and braces — the code the
 * user sees should not depend on which layer noticed first). `cause` chains are
 * walked because a stage wraps its failure (`StageFailureError`) on the way up.
 */
export function classifyJobErrorCode(error: unknown): JobErrorCode {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof ProviderKeyBlockedError || isProviderCredentialRejection(current)) {
      return 'blocked_no_key';
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return 'pipeline_failed';
}

/**
 * Provider stop reasons are embedded in error messages by the script library as
 * `stop_reason=<value>` (e.g. `[TRUNCATED: stop_reason=max_tokens — ...]`).
 * Parsing the message keeps this worker decoupled from each provider's error
 * shape while still surfacing the decisive truncation signal.
 */
const STOP_REASON_PATTERN = /stop_reason=([a-z_]+)/i;

/**
 * Character cap for the persisted failure message. Generous enough to keep the
 * diagnostic anatomy of a parse failure (label + provider/model + stop_reason +
 * a raw model snippet), while bounding what one row can carry into the database —
 * and, from there, into the owner's debug panel.
 */
const FAILURE_MESSAGE_MAXIMUM_LENGTH = 2_000;

/**
 * Build the persisted failure record for a failing stage attempt. Never throws:
 * this runs inside the failure path, where a diagnosis error must not mask the
 * original one.
 *
 * This is the SINK for every stage error, so the masking happens here rather
 * than only at the individual provider call sites: TTS, Lyria (whose throw lives
 * in workflow.ts), Whisper and any future caller are covered by one rule.
 * Masking runs before the cap so a mid-credential cut cannot leave a usable
 * prefix, and the stop reason is parsed from the masked-but-uncapped text so a
 * long message cannot truncate the signal away.
 */
export function buildFailureDetails(
  stage: NewscastStage,
  error: unknown,
  atIso: string,
): JobFailureDetails {
  const redacted = redactSecrets(error instanceof Error ? error.message : String(error));
  const message = truncateText(redacted, FAILURE_MESSAGE_MAXIMUM_LENGTH);
  const failure: JobFailureDetails = { stage, message, at: atIso };

  const stopReason = STOP_REASON_PATTERN.exec(redacted)?.[1];
  if (stopReason !== undefined) {
    failure.stopReason = stopReason.toLowerCase();
  }
  if (error instanceof StageFailureError && error.failedChunk !== undefined) {
    failure.failedChunk = error.failedChunk;
  }
  return failure;
}
