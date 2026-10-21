import { describe, expect, it } from 'vitest';
import { createManagementDatabase } from './management-api.ts';

const accessToken = 'sbp_secret_token';
const projectId = 'abcdefghijklmnopqrst';

/** A fetch that answers every request with `response` and records the requests. */
function stubFetch(response: () => Response) {
  const requests: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return response();
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe('createManagementDatabase', () => {
  it('lists the names of production migrations', async () => {
    const { fetch, requests } = stubFetch(() => Response.json([{ version: '20261001000000', name: 'create_users' }, { version: '20261002000000' }]));
    const database = createManagementDatabase({ accessToken, projectId, fetch });

    expect(await database.listProductionMigrationNames()).toEqual(['create_users']);
    expect(requests).toEqual([
      {
        url: `https://api.supabase.com/v1/projects/${projectId}/database/migrations`,
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: undefined,
      },
    ]);
  });

  it('runs SQL with the query endpoint, read-only when asked', async () => {
    const { fetch, requests } = stubFetch(() => new Response(JSON.stringify([{ answer: 1 }]), { status: 201 }));
    const database = createManagementDatabase({ accessToken, projectId, fetch });

    expect(await database.query('SELECT 1 AS answer', { readOnly: true })).toEqual([{ answer: 1 }]);
    await database.query('BEGIN; COMMIT;');

    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: `https://api.supabase.com/v1/projects/${projectId}/database/query`, method: 'POST', body: { query: 'SELECT 1 AS answer', read_only: true } },
      { url: `https://api.supabase.com/v1/projects/${projectId}/database/query`, method: 'POST', body: { query: 'BEGIN; COMMIT;', read_only: false } },
    ]);
  });

  it('never posts to the migrations endpoint', async () => {
    const { fetch, requests } = stubFetch(() => Response.json([]));
    const database = createManagementDatabase({ accessToken, projectId, fetch });
    await database.listProductionMigrationNames();
    await database.query('SELECT 1');

    expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/database/migrations'))).toEqual([]);
  });

  it('reports the API error message without the project ref or the token', async () => {
    const { fetch } = stubFetch(() => Response.json({ message: 'Failed to run sql query: ERROR:  42P01: relation "x" does not exist' }, { status: 400 }));
    const database = createManagementDatabase({ accessToken, projectId, fetch });

    const error = await database.query('SELECT * FROM x').catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('query failed (HTTP 400): Failed to run sql query: ERROR:  42P01: relation "x" does not exist');
    expect((error as Error).message).not.toContain(projectId);
    expect((error as Error).message).not.toContain(accessToken);
  });

  it('reports a body that is not JSON as it is', async () => {
    const { fetch } = stubFetch(() => new Response('upstream timeout', { status: 504 }));
    const database = createManagementDatabase({ accessToken, projectId, fetch });

    await expect(database.listProductionMigrationNames()).rejects.toThrow('listing production migrations failed (HTTP 504): upstream timeout');
  });
});
