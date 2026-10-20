import type { Row, SchemaDatabase } from './environment-schema.ts';

const API_ORIGIN = 'https://api.supabase.com';

/** The `message` of an API error body, or the body itself when it has none. */
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string') {
      return (body as { message: string }).message;
    }
  } catch {
    // Not JSON: report the text as it is.
  }
  return text === '' ? response.statusText : text;
}

/**
 * The project's database through the Supabase Management API.
 *
 * SQL runs with `POST /v1/projects/{ref}/database/query` (beta). Migrations
 * are never sent to `POST /v1/projects/{ref}/database/migrations`, which would
 * record them in production's migration history.
 *
 * Error messages name the call, not the URL, so the project ref stays out of the log.
 */
export function createManagementDatabase({
  accessToken,
  projectId,
  fetch = globalThis.fetch,
}: {
  accessToken: string;
  projectId: string;
  fetch?: typeof globalThis.fetch;
}): SchemaDatabase {
  const projectURL = `${API_ORIGIN}/v1/projects/${encodeURIComponent(projectId)}`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  async function call(label: string, path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${projectURL}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new Error(`${label} failed (HTTP ${response.status}): ${await errorMessage(response)}`);
    }
    const text = await response.text();
    return text === '' ? [] : JSON.parse(text);
  }

  return {
    async listProductionMigrationNames() {
      const body = await call('listing production migrations', '/database/migrations', { method: 'GET' });
      if (!Array.isArray(body)) {
        throw new Error('listing production migrations returned something other than a list');
      }
      return body.flatMap((migration: { name?: unknown }) => (typeof migration?.name === 'string' ? [migration.name] : []));
    },

    async query(sql, options) {
      const body = await call(options?.readOnly === true ? 'read-only query' : 'query', '/database/query', {
        method: 'POST',
        body: JSON.stringify({ query: sql, read_only: options?.readOnly === true }),
      });
      return Array.isArray(body) ? (body as Row[]) : [];
    },
  };
}
