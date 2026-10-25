/**
 * Calls the environment variable routes and the provider key routes of user-vault-worker over its
 * service binding. Values travel only in the put request and the resolve response of the environment
 * variables, and provider keys only in the put request; no error carries one.
 */

const VAULT_ORIGIN = 'https://user-vault.internal';
const INTERNAL_TOKEN_HEADER_NAME = 'x-user-vault-token';

export interface EnvironmentVariableSummary {
  name: string;
  created_at: string;
  updated_at: string;
}

export interface StoredEnvironmentVariable extends EnvironmentVariableSummary {
  created: boolean;
}

export const PROVIDER_NAMES = ['anthropic', 'openai', 'google', 'xai'] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === 'string' && (PROVIDER_NAMES as readonly string[]).includes(value);
}

export interface ProviderKeyStatus {
  provider: ProviderName;
  configured: boolean;
  last4: string | null;
  validatedAt: string | null;
}

const PROVIDER_KEY_AUDIT_ACTIONS = ['registered', 'replaced', 'removed', 'used'] as const;

export interface ProviderKeyAuditEvent {
  provider: ProviderName;
  action: (typeof PROVIDER_KEY_AUDIT_ACTIONS)[number];
  at: string;
}

/**
 * What the vault keeps of a request, as a hash, in the audit trail of a key.
 */
export interface ClientFingerprint {
  ip?: string;
  userAgent?: string;
}

/**
 * The vault answered other than 2xx, or could not be reached (status 0).
 */
export class UserVaultError extends Error {
  readonly status: number;
  /** The vault's error code, when it answered one */
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(status === 0 ? 'User vault could not be reached' : `User vault responded ${status}${code === null ? '' : ` ${code}`}`);
    this.name = 'UserVaultError';
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSummary(value: unknown): value is EnvironmentVariableSummary {
  return (
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string'
  );
}

function isProviderKeyStatus(value: unknown): value is ProviderKeyStatus {
  return (
    isPlainObject(value) &&
    isProviderName(value.provider) &&
    typeof value.configured === 'boolean' &&
    (typeof value.last4 === 'string' || value.last4 === null) &&
    (typeof value.validatedAt === 'string' || value.validatedAt === null)
  );
}

function isProviderKeyAuditEvent(value: unknown): value is ProviderKeyAuditEvent {
  return (
    isPlainObject(value) &&
    isProviderName(value.provider) &&
    (PROVIDER_KEY_AUDIT_ACTIONS as readonly unknown[]).includes(value.action) &&
    typeof value.at === 'string'
  );
}

/**
 * The fingerprint fields of a request body, left out when the request had none.
 */
function fingerprintFields(fingerprint: ClientFingerprint): Record<string, string> {
  const fields: Record<string, string> = {};
  if (fingerprint.ip !== undefined) {
    fields.ip = fingerprint.ip;
  }
  if (fingerprint.userAgent !== undefined) {
    fields.userAgent = fingerprint.userAgent;
  }
  return fields;
}

export class UserVaultClient {
  readonly #binding: Fetcher;
  readonly #internalToken: string | undefined;

  constructor(binding: Fetcher, internalToken: string | undefined) {
    this.#binding = binding;
    this.#internalToken = internalToken;
  }

  async #call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (this.#internalToken !== undefined && this.#internalToken.length > 0) {
      headers.set(INTERNAL_TOKEN_HEADER_NAME, this.#internalToken);
    }

    let response: Response;
    try {
      response = await this.#binding.fetch(`${VAULT_ORIGIN}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      throw new UserVaultError(0, null);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const code = isPlainObject(payload) && typeof payload.error === 'string' ? payload.error : null;
      throw new UserVaultError(response.status, code);
    }
    if (!isPlainObject(payload)) {
      throw new UserVaultError(response.status, 'invalid_response');
    }
    return payload;
  }

  async listEnvironmentVariables(userUUID: string): Promise<EnvironmentVariableSummary[]> {
    const payload = await this.#call('/internal/environment-variables/list', { userId: userUUID });
    if (!Array.isArray(payload.variables) || !payload.variables.every(isSummary)) {
      throw new UserVaultError(200, 'invalid_response');
    }
    return payload.variables.map(({ name, created_at, updated_at }) => ({ name, created_at, updated_at }));
  }

  async putEnvironmentVariable(userUUID: string, name: string, value: string): Promise<StoredEnvironmentVariable> {
    const payload = await this.#call('/internal/environment-variables/put', { userId: userUUID, name, value });
    if (!isSummary(payload) || typeof payload.created !== 'boolean') {
      throw new UserVaultError(200, 'invalid_response');
    }
    return { name: payload.name, created_at: payload.created_at, updated_at: payload.updated_at, created: payload.created };
  }

  /**
   * @returns whether a variable was deleted
   */
  async deleteEnvironmentVariable(userUUID: string, name: string): Promise<boolean> {
    const payload = await this.#call('/internal/environment-variables/delete', { userId: userUUID, name });
    if (typeof payload.deleted !== 'boolean') {
      throw new UserVaultError(200, 'invalid_response');
    }
    return payload.deleted;
  }

  /**
   * The names and values of every environment variable of the user.
   */
  async resolveEnvironmentVariables(userUUID: string): Promise<Record<string, string>> {
    const payload = await this.#call('/internal/environment-variables/resolve', { userId: userUUID });
    const variables = payload.variables;
    if (!isPlainObject(variables) || !Object.values(variables).every((value) => typeof value === 'string')) {
      throw new UserVaultError(200, 'invalid_response');
    }
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(variables)) {
      Object.defineProperty(resolved, name, { value, enumerable: true, writable: true, configurable: true });
    }
    return resolved;
  }

  /**
   * Which providers have a key, with the last four characters of it. The vault answers one entry per provider.
   */
  async getProviderKeyStatus(userUUID: string): Promise<ProviderKeyStatus[]> {
    const payload = await this.#call('/internal/keys/status', { userId: userUUID });
    if (!Array.isArray(payload.keys) || !payload.keys.every(isProviderKeyStatus)) {
      throw new UserVaultError(200, 'invalid_response');
    }
    return payload.keys.map(({ provider, configured, last4, validatedAt }) => ({ provider, configured, last4, validatedAt }));
  }

  /**
   * The newest events of the keys of the user, newest first.
   */
  async listProviderKeyAudit(userUUID: string, limit: number): Promise<ProviderKeyAuditEvent[]> {
    const payload = await this.#call('/internal/keys/audit', { userId: userUUID, limit });
    if (!Array.isArray(payload.events) || !payload.events.every(isProviderKeyAuditEvent)) {
      throw new UserVaultError(200, 'invalid_response');
    }
    return payload.events.map(({ provider, action, at }) => ({ provider, action, at }));
  }

  /**
   * The vault checks the key with the provider before it stores the key.
   */
  async putProviderKey(
    userUUID: string,
    provider: ProviderName,
    key: string,
    fingerprint: ClientFingerprint,
  ): Promise<ProviderKeyStatus> {
    const payload = await this.#call('/internal/keys/put', { userId: userUUID, provider, key, ...fingerprintFields(fingerprint) });
    if (!isProviderKeyStatus(payload) || !payload.configured) {
      throw new UserVaultError(200, 'invalid_response');
    }
    return { provider: payload.provider, configured: payload.configured, last4: payload.last4, validatedAt: payload.validatedAt };
  }

  /**
   * @returns whether a key was deleted
   */
  async deleteProviderKey(userUUID: string, provider: ProviderName, fingerprint: ClientFingerprint): Promise<boolean> {
    const payload = await this.#call('/internal/keys/delete', { userId: userUUID, provider, ...fingerprintFields(fingerprint) });
    if (typeof payload.removed !== 'boolean') {
      throw new UserVaultError(200, 'invalid_response');
    }
    return payload.removed;
  }
}
