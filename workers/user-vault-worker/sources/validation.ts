import type { GatewayOptions } from './environment.ts';
import {
  PROVIDER_DEFINITIONS,
  buildProviderHeaders,
  buildProviderURL,
  type ProviderName,
} from './providers.ts';

export const PROVIDER_KEY_MINIMUM_LENGTH = 16;
export const PROVIDER_KEY_MAXIMUM_LENGTH = 512;
export const VALIDATION_TIMEOUT_MILLISECONDS = 10_000;

export type KeyValidationResult = 'valid' | 'invalid' | 'unavailable';

export interface KeyValidationOutcome {
  result: KeyValidationResult;
  status: number | null;
  failure: unknown;
}

/**
 * 16 to 512 characters, every one of them printable ASCII (0x21 to 0x7E).
 */
export function isWellFormedProviderKey(key: unknown): key is string {
  if (typeof key !== 'string') {
    return false;
  }
  if (key.length < PROVIDER_KEY_MINIMUM_LENGTH || key.length > PROVIDER_KEY_MAXIMUM_LENGTH) {
    return false;
  }
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

export function classifyValidationStatus(status: number): KeyValidationResult {
  if (status >= 200 && status < 300) {
    return 'valid';
  }
  if (status === 400 || status === 401 || status === 403) {
    return 'invalid';
  }
  return 'unavailable';
}

/**
 * Makes the provider's cheapest authenticated call with the key. The key only
 * travels in headers, a redirect is not followed (so it reads as `unavailable`),
 * the response body is read and thrown away, and any network failure or
 * timeout is reported as `unavailable`.
 */
export async function validateProviderKey(
  provider: ProviderName,
  key: string,
  gateway: GatewayOptions | null,
): Promise<KeyValidationOutcome> {
  const validationRequest = PROVIDER_DEFINITIONS[provider].validationRequest;
  const target = buildProviderURL(provider, validationRequest.path, gateway);
  if (!target.ok) {
    return { result: 'unavailable', status: null, failure: new Error(`Validation URL rejected: ${target.error}`) };
  }

  try {
    const response = await fetch(target.url, {
      method: validationRequest.method,
      headers: buildProviderHeaders(provider, key, validationRequest.headers, gateway),
      body: validationRequest.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MILLISECONDS),
    });
    try {
      await response.arrayBuffer();
    } catch {
      // The body is discarded either way; only the status matters.
    }
    return { result: classifyValidationStatus(response.status), status: response.status, failure: null };
  } catch (error) {
    return { result: 'unavailable', status: null, failure: error };
  }
}
