/**
 * Calls the environment variable routes of user-vault-worker over its service binding.
 * Values travel only in the put request and the resolve response; no error carries one.
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

export class UserVaultClient {
  readonly #binding: Fetcher;
  readonly #internalToken: string | undefined;

  constructor(binding: Fetcher, internalToken: string | undefined) {
    this.#binding = binding;
    this.#internalToken = internalToken;
  }

  async #call(route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (this.#internalToken !== undefined && this.#internalToken.length > 0) {
      headers.set(INTERNAL_TOKEN_HEADER_NAME, this.#internalToken);
    }

    let response: Response;
    try {
      response = await this.#binding.fetch(`${VAULT_ORIGIN}/internal/environment-variables/${route}`, {
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
    const payload = await this.#call('list', { userId: userUUID });
    if (!Array.isArray(payload.variables) || !payload.variables.every(isSummary)) {
      throw new UserVaultError(200, 'invalid_response');
    }
    return payload.variables.map(({ name, created_at, updated_at }) => ({ name, created_at, updated_at }));
  }

  async putEnvironmentVariable(userUUID: string, name: string, value: string): Promise<StoredEnvironmentVariable> {
    const payload = await this.#call('put', { userId: userUUID, name, value });
    if (!isSummary(payload) || typeof payload.created !== 'boolean') {
      throw new UserVaultError(200, 'invalid_response');
    }
    return { name: payload.name, created_at: payload.created_at, updated_at: payload.updated_at, created: payload.created };
  }

  /**
   * @returns whether a variable was deleted
   */
  async deleteEnvironmentVariable(userUUID: string, name: string): Promise<boolean> {
    const payload = await this.#call('delete', { userId: userUUID, name });
    if (typeof payload.deleted !== 'boolean') {
      throw new UserVaultError(200, 'invalid_response');
    }
    return payload.deleted;
  }

  /**
   * The names and values of every environment variable of the user.
   */
  async resolveEnvironmentVariables(userUUID: string): Promise<Record<string, string>> {
    const payload = await this.#call('resolve', { userId: userUUID });
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
}
