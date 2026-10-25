/**
 * The provider transport that spends the key of the USER, through user-vault-worker.
 *
 * Everything this worker does with a user's key is indirect: it asks the vault to CALL a provider.
 * There is no "read the key" call to write, because the vault exposes none — which is what keeps a
 * plaintext credential from ever reaching a `step.do` parameter, a checkpoint, or the Workflows
 * engine's durable storage.
 */

import type {
  LlmProvider,
  ProviderRequestSpecification,
  ProviderTransport,
  ProviderTransportResponse,
} from '@audio-underview/newscast-core';
import { createWorkerLogger } from '@audio-underview/logger';
import type { Environment } from './environment.ts';

const logger = createWorkerLogger({
  defaultContext: { module: 'newscast-worker-user-vault-transport' },
});

const VAULT_ORIGIN = 'https://user-vault.internal';
const PROXY_PATH = '/internal/proxy';
const KEY_STATUS_PATH = '/internal/keys/status';
const INTERNAL_TOKEN_HEADER_NAME = 'x-user-vault-token';

/** One vault response: its HTTP status plus the parsed JSON object body. */
interface VaultCallResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * What one vault round trip actually was. "The vault did not answer this call" is a blip a retry
 * usually fixes, so it is kept apart from every answer the vault gave.
 */
type VaultOutcome =
  | ({ kind: 'answered' } & VaultCallResult)
  | { kind: 'unreachable'; reason: string };

/** One round trip to the vault, classified. */
async function requestVault(
  environment: Environment,
  path: string,
  payload: Record<string, unknown>,
): Promise<VaultOutcome> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof environment.VAULT_INTERNAL_TOKEN === 'string' && environment.VAULT_INTERNAL_TOKEN.length > 0) {
    headers[INTERNAL_TOKEN_HEADER_NAME] = environment.VAULT_INTERNAL_TOKEN;
  }
  try {
    const response = await environment.USER_VAULT.fetch(`${VAULT_ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const parsed: unknown = await response.json().catch(() => null);
    return {
      kind: 'answered',
      status: response.status,
      body:
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
    };
  } catch (error) {
    logger.error('The user vault could not be reached', error, {
      function: 'requestVault',
      metadata: { path },
    });
    return {
      kind: 'unreachable',
      reason: error instanceof Error ? error.name : 'unknown',
    };
  }
}

/**
 * Thrown by the transport when the user HAS NO KEY for this provider — the vault has no key row
 * for it, or one whose envelope no longer opens (`no_key`).
 *
 * The vault reads the key row before it contacts the provider, so this error means nothing was
 * spent. The pipeline ends the newscast as `blocked_no_key` on it (`withResolvedProviderKey` in
 * workflow.ts), except for the Whisper alignment, which simply does not happen without a key.
 *
 * A provider's own 401 is NOT this error, and neither is a vault OUTAGE, which is
 * {@link ProviderKeyVaultUnavailableError} below: a key that exists but could not be reached for
 * five seconds is not a key the user has to register again.
 */
export class UserProviderKeyUnavailableError extends Error {
  readonly provider: LlmProvider;

  constructor(provider: LlmProvider) {
    super(`No user key available for ${provider} (no_key).`);
    this.name = 'UserProviderKeyUnavailableError';
    this.provider = provider;
  }
}

/**
 * Thrown when the vault could not answer for a reason that says NOTHING about whether the user has
 * a key: the service binding threw, the vault refused this worker's token (401) or has no
 * key-encryption key (503), the provider was unreachable from it (502), or it answered something
 * that is not a provider response at all.
 *
 * TRANSIENT, so it must propagate: the durable `step.do` retry is the right handler. Reading it as
 * "no key" would end a newscast permanently as `blocked_no_key` on a brief outage.
 */
export class ProviderKeyVaultUnavailableError extends Error {
  /** The vault-side reason, for logs only — never a provider body. */
  readonly reason: string;

  constructor(provider: LlmProvider, reason: string) {
    super(`The user vault could not fulfil a ${provider} call (${reason}).`);
    this.name = 'ProviderKeyVaultUnavailableError';
    this.reason = reason;
  }
}

/**
 * Ask the vault to perform one provider request with the USER's key.
 *
 * The request is a path plus a body — never a URL and never a credential. The vault picks the
 * origin from its own allowlist, injects the key it decrypts internally, and returns the provider's
 * status and body verbatim.
 *
 * A binary body rides as `bodyBase64` (Whisper's multipart alignment call); the two body forms are
 * mutually exclusive and the vault rejects a request carrying both.
 */
async function proxyProviderRequest(
  environment: Environment,
  userUUID: string,
  provider: LlmProvider,
  request: ProviderRequestSpecification,
): Promise<ProviderTransportResponse> {
  const outcome = await requestVault(environment, PROXY_PATH, {
    userId: userUUID,
    provider,
    path: request.path,
    method: request.method,
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.bodyBase64 !== undefined ? { bodyBase64: request.bodyBase64 } : {}),
    ...(request.headers !== undefined ? { headers: request.headers } : {}),
  });
  if (outcome.kind === 'unreachable') {
    throw new ProviderKeyVaultUnavailableError(provider, outcome.reason);
  }
  if (outcome.body.error === 'no_key') {
    // The ONE answer that is about the user's keys: no row for this provider, or one whose
    // envelope no longer authenticates. Nothing was spent.
    throw new UserProviderKeyUnavailableError(provider);
  }
  const status = outcome.body.status;
  const body = outcome.body.body;
  if (outcome.body.ok !== true || typeof status !== 'number' || typeof body !== 'string') {
    // The vault answered, but not with a provider response: a blocked path, a malformed request,
    // a refused token, a vault with no KEK, or a provider it could not reach — and
    // `provider_unreachable` in particular can arrive AFTER the provider was already called.
    // None of it means the user has no key, so it is thrown as transient and the step retries.
    const error = typeof outcome.body.error === 'string' ? outcome.body.error : 'unknown';
    logger.warn('The user vault could not fulfil a proxied provider call', {
      provider,
      status: outcome.status,
      error,
    }, { function: 'proxyProviderRequest' });
    throw new ProviderKeyVaultUnavailableError(provider, error);
  }
  return { status, body };
}

/**
 * Whether the user has a key registered for this provider, from the vault's key list
 * (`{ keys: [{ provider, configured, last4, validatedAt }] }`).
 *
 * It reads the key rows only: no provider is called and no envelope is opened, so a key whose
 * envelope no longer opens still reads as configured — the proxy answers that one `no_key` later.
 *
 * Throws {@link ProviderKeyVaultUnavailableError} when the vault did not answer with a key list (it
 * could not be reached, refused this worker's token, or has no key-encryption key): none of that
 * says whether the user has the key.
 */
export async function isUserProviderKeyConfigured(
  environment: Environment,
  userUUID: string,
  provider: LlmProvider,
): Promise<boolean> {
  const outcome = await requestVault(environment, KEY_STATUS_PATH, { userId: userUUID });
  if (outcome.kind === 'unreachable') {
    throw new ProviderKeyVaultUnavailableError(provider, outcome.reason);
  }
  const keys = outcome.body.keys;
  if (outcome.status !== 200 || !Array.isArray(keys)) {
    const error = typeof outcome.body.error === 'string' ? outcome.body.error : 'unknown';
    logger.warn('The user vault could not list the keys of a user', {
      provider,
      status: outcome.status,
      error,
    }, { function: 'isUserProviderKeyConfigured' });
    throw new ProviderKeyVaultUnavailableError(provider, error);
  }
  return keys.some((key: unknown) =>
    key !== null &&
    typeof key === 'object' &&
    (key as Record<string, unknown>).provider === provider &&
    (key as Record<string, unknown>).configured === true);
}

/**
 * A {@link ProviderTransport} that spends the user's registered key for one provider. Each call is
 * one vault round trip, so a key registered, replaced or removed mid-run takes effect on the next
 * call.
 */
export function createUserKeyTransport(
  environment: Environment,
  userUUID: string,
  provider: LlmProvider,
): ProviderTransport {
  return (request) => proxyProviderRequest(environment, userUUID, provider, request);
}
