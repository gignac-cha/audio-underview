export interface Environment {
  DB: D1Database;
  PROVIDER_KEY_KEK?: string;
  PROVIDER_KEY_KEK_PREVIOUS?: string;
  PROVIDER_KEY_KEK_VERSION?: string;
  VAULT_INTERNAL_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  AUDIT_HASH_SALT?: string;
}

export interface GatewayOptions {
  baseURL: string;
  token: string | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Secrets of the key encryption keys, current first. Encryption uses the
 * first entry; decryption tries every entry in order.
 */
export function readKeyEncryptionKeySecrets(environment: Environment): string[] {
  const current = environment.PROVIDER_KEY_KEK;
  if (!isNonEmptyString(current)) {
    return [];
  }
  const previous = environment.PROVIDER_KEY_KEK_PREVIOUS;
  if (isNonEmptyString(previous) && previous !== current) {
    return [current, previous];
  }
  return [current];
}

/**
 * Generation number written on new rows; anything that is not a positive integer reads as 1.
 */
export function readKeyEncryptionKeyVersion(environment: Environment): number {
  const value = environment.PROVIDER_KEY_KEK_VERSION;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return 1;
  }
  const version = Number(value.trim());
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

export function readInternalToken(environment: Environment): string | null {
  const token = environment.VAULT_INTERNAL_TOKEN;
  return isNonEmptyString(token) ? token : null;
}

/**
 * The gateway is used only when the vault's own AI_GATEWAY_BASE_URL is set.
 * The gateway token is attached only to gateway calls, so it never reaches a provider directly.
 */
export function readGatewayOptions(environment: Environment): GatewayOptions | null {
  const baseURL = environment.AI_GATEWAY_BASE_URL?.trim() ?? '';
  if (baseURL.length === 0) {
    return null;
  }
  const token = environment.AI_GATEWAY_TOKEN;
  return { baseURL, token: isNonEmptyString(token) ? token : null };
}

export function readAuditHashSalt(environment: Environment): string {
  return environment.AUDIT_HASH_SALT ?? '';
}
