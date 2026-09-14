import { describe, test, expect, vi } from 'vitest';
import {
  accountRouteRequiresBody,
  handleAccountRoute,
  isAccountRoutePathname,
  type AccountRouteDependencies,
} from './account-routes.ts';
import {
  consumeLinkTicket,
  linkCodeStorageKey,
  linkTicketStorageKey,
  stashLinkCode,
  type AccountStateStorage,
} from './account-linking.ts';
import {
  createFakeSupabaseClient,
  createMemoryAccountStateStorage,
  type FakeQuery,
  type FakeQueryResult,
} from './test-helpers.ts';

vi.mock('@audio-underview/axiom-logger/tracers', () => ({
  traceDatabaseOperation: async (_options: unknown, fn: Function) =>
    fn({
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
      recordException: vi.fn(),
      addEvent: vi.fn(),
    }),
  SpanStatusCode: { OK: 0, ERROR: 2 },
}));

const SESSION_UUID = '83156cb5-c92a-4c75-b944-341d2d857bbf';
const OTHER_UUID = '11111111-2222-3333-4444-555555555555';

const twoAccounts = [
  { provider: 'github', identifier: '38489680', uuid: SESSION_UUID, created_at: '2026-01-01T00:00:00Z' },
  { provider: 'google', identifier: 'google-sub-1', uuid: SESSION_UUID, created_at: '2026-08-01T00:00:00Z' },
];

function sessionVerifier(claims: Record<string, unknown> | null) {
  return async () => claims;
}

function createDependencies(
  overrides: Partial<AccountRouteDependencies> = {},
  respond: (query: FakeQuery) => FakeQueryResult | undefined = () => undefined,
  initialStorageEntries: Record<string, string> = {},
) {
  const memory = createMemoryAccountStateStorage(initialStorageEntries);
  const fake = createFakeSupabaseClient((query) => respond(query) ?? { data: null, error: null });

  const dependencies: AccountRouteDependencies = {
    verifyToken: sessionVerifier({ sub: SESSION_UUID, provider: 'google', iat: 1, exp: 2 }),
    storage: memory.storage,
    createClient: () => fake.client,
    ...overrides,
  };

  return { dependencies, memory, queries: fake.queries };
}

describe('isAccountRoutePathname', () => {
  test('claims only the account management paths', () => {
    expect(isAccountRoutePathname('/accounts')).toBe(true);
    expect(isAccountRoutePathname('/accounts/github')).toBe(true);
    expect(isAccountRoutePathname('/accounts/link-confirm')).toBe(true);
    expect(isAccountRoutePathname('/link-tickets')).toBe(true);

    expect(isAccountRoutePathname('/authorize')).toBe(false);
    expect(isAccountRoutePathname('/callback')).toBe(false);
    expect(isAccountRoutePathname('/health')).toBe(false);
    expect(isAccountRoutePathname('/accountsomething')).toBe(false);
  });
});

describe('accountRouteRequiresBody', () => {
  test('asks for a body only on the confirmation route', () => {
    expect(accountRouteRequiresBody('POST', '/accounts/link-confirm')).toBe(true);
    expect(accountRouteRequiresBody('post', '/accounts/link-confirm')).toBe(true);

    expect(accountRouteRequiresBody('GET', '/accounts/link-confirm')).toBe(false);
    expect(accountRouteRequiresBody('POST', '/link-tickets')).toBe(false);
    expect(accountRouteRequiresBody('DELETE', '/accounts/github')).toBe(false);
  });
});

describe('routing', () => {
  test('falls through for paths it does not own', async () => {
    const { dependencies } = createDependencies();

    expect(
      await handleAccountRoute(
        { method: 'GET', pathname: '/health', authorizationHeader: null },
        dependencies,
      ),
    ).toBeUndefined();
  });

  test('answers 405 for the wrong method on an owned path', async () => {
    const { dependencies } = createDependencies();

    const linkTickets = await handleAccountRoute(
      { method: 'GET', pathname: '/link-tickets', authorizationHeader: 'Bearer token' },
      dependencies,
    );
    const accounts = await handleAccountRoute(
      { method: 'POST', pathname: '/accounts', authorizationHeader: 'Bearer token' },
      dependencies,
    );
    const singleAccount = await handleAccountRoute(
      { method: 'GET', pathname: '/accounts/github', authorizationHeader: 'Bearer token' },
      dependencies,
    );
    // Must not fall through to "unlink the provider named link-confirm".
    const linkConfirm = await handleAccountRoute(
      { method: 'DELETE', pathname: '/accounts/link-confirm', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(linkTickets?.status).toBe(405);
    expect(accounts?.status).toBe(405);
    expect(singleAccount?.status).toBe(405);
    expect(linkConfirm?.status).toBe(405);
  });
});

describe('authentication', () => {
  test('answers 503 on every route when no signing secret is configured', async () => {
    const { dependencies } = createDependencies({ verifyToken: undefined });

    for (const request of [
      { method: 'POST', pathname: '/link-tickets', authorizationHeader: 'Bearer token' },
      { method: 'POST', pathname: '/accounts/link-confirm', authorizationHeader: 'Bearer token' },
      { method: 'GET', pathname: '/accounts', authorizationHeader: 'Bearer token' },
      { method: 'DELETE', pathname: '/accounts/github', authorizationHeader: 'Bearer token' },
    ]) {
      const result = await handleAccountRoute(request, dependencies);
      expect(result?.status).toBe(503);
      expect(result?.body).toMatchObject({ error: 'session_tokens_unavailable' });
    }
  });

  test('answers 401 without a bearer token', async () => {
    const { dependencies } = createDependencies();

    const result = await handleAccountRoute(
      { method: 'GET', pathname: '/accounts', authorizationHeader: null },
      dependencies,
    );

    expect(result?.status).toBe(401);
    expect(result?.body).toMatchObject({ error: 'unauthorized' });
  });

  test('answers 401 when the token does not verify', async () => {
    const { dependencies } = createDependencies({ verifyToken: sessionVerifier(null) });

    const result = await handleAccountRoute(
      { method: 'GET', pathname: '/accounts', authorizationHeader: 'Bearer forged' },
      dependencies,
    );

    expect(result?.status).toBe(401);
  });

  test('answers 401 for a media token (jid claim)', async () => {
    const { dependencies } = createDependencies({
      verifyToken: sessionVerifier({ sub: SESSION_UUID, jid: 'job-1', iat: 1, exp: 2 }),
    });

    const result = await handleAccountRoute(
      { method: 'POST', pathname: '/link-tickets', authorizationHeader: 'Bearer media' },
      dependencies,
    );

    expect(result?.status).toBe(401);
  });
});

describe('POST /link-tickets', () => {
  test('mints a ticket bound to the verified sub, with a nonce for the browser', async () => {
    const { dependencies, memory } = createDependencies();

    const result = await handleAccountRoute(
      { method: 'POST', pathname: '/link-tickets', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(result?.status).toBe(200);
    const { ticket, nonce } = result?.body as { ticket: string; nonce: string };
    expect(ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(nonce).not.toBe(ticket);
    expect(memory.entries.get(linkTicketStorageKey(ticket))).toBe(
      JSON.stringify({ uuid: SESSION_UUID, nonce }),
    );
  });

  test('ignores any uuid the caller supplies in the path or query (IDOR)', async () => {
    const { dependencies, memory } = createDependencies();

    const result = await handleAccountRoute(
      {
        method: 'POST',
        pathname: '/link-tickets',
        authorizationHeader: 'Bearer token',
      },
      dependencies,
    );

    const ticket = (result?.body as { ticket: string }).ticket;
    expect(memory.entries.get(linkTicketStorageKey(ticket))).not.toContain(OTHER_UUID);
  });
});

describe('POST /accounts/link-confirm', () => {
  const githubIdentity = { provider: 'github' as const, identifier: '38489680' };

  /** Runs a whole link flow up to (but not including) the confirmation. */
  async function startLinkFlow(
    dependencies: AccountRouteDependencies,
    storage: AccountStateStorage,
    userUUID: string = SESSION_UUID,
  ) {
    const ticketResult = await handleAccountRoute(
      { method: 'POST', pathname: '/link-tickets', authorizationHeader: 'Bearer token' },
      { ...dependencies, verifyToken: sessionVerifier({ sub: userUUID, iat: 1, exp: 2 }) },
    );

    const { ticket, nonce } = ticketResult?.body as { ticket: string; nonce: string };
    const binding = await consumeLinkTicket(storage, ticket);

    // What the OAuth callback does: stash, never link.
    const linkCode = await stashLinkCode(storage, {
      userUUID: binding!.userUUID,
      ...githubIdentity,
      nonce: binding!.nonce,
    });

    return { nonce, linkCode };
  }

  function confirm(
    dependencies: AccountRouteDependencies,
    body: unknown,
    authorizationHeader: string | null = 'Bearer token',
  ) {
    return handleAccountRoute(
      { method: 'POST', pathname: '/accounts/link-confirm', authorizationHeader, body },
      dependencies,
    );
  }

  const unlinkedProvider = (query: FakeQuery): FakeQueryResult | undefined => {
    if (query.table === 'accounts' && query.operation === 'select') {
      return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    }
    if (query.table === 'users' && query.operation === 'select') {
      return { data: { uuid: SESSION_UUID }, error: null };
    }
    if (query.table === 'accounts' && query.operation === 'insert') {
      return { data: { ...githubIdentity, uuid: SESSION_UUID }, error: null };
    }
    return undefined;
  };

  test('links when the nonce and the link code arrive together with the session', async () => {
    const { dependencies, memory } = createDependencies({}, unlinkedProvider);
    const { nonce, linkCode } = await startLinkFlow(dependencies, memory.storage);

    const result = await confirm(dependencies, { link_code: linkCode, nonce });

    expect(result?.status).toBe(200);
    expect(result?.body).toEqual({ result: 'linked' });
    expect(memory.entries.get(linkCodeStorageKey(linkCode))).toBeUndefined();
  });

  test('answers 200 already_linked when the provider is on this account already', async () => {
    const { dependencies, memory } = createDependencies({}, (query) =>
      query.table === 'accounts' && query.operation === 'select'
        ? { data: { ...githubIdentity, uuid: SESSION_UUID }, error: null }
        : undefined,
    );
    const { nonce, linkCode } = await startLinkFlow(dependencies, memory.storage);

    const result = await confirm(dependencies, { link_code: linkCode, nonce });

    expect(result?.status).toBe(200);
    expect(result?.body).toEqual({ result: 'already_linked' });
  });

  test('answers 409 when the provider belongs to somebody else', async () => {
    const { dependencies, memory } = createDependencies({}, (query) =>
      query.table === 'accounts' && query.operation === 'select'
        ? { data: { ...githubIdentity, uuid: OTHER_UUID }, error: null }
        : undefined,
    );
    const { nonce, linkCode } = await startLinkFlow(dependencies, memory.storage);

    const result = await confirm(dependencies, { link_code: linkCode, nonce });

    expect(result?.status).toBe(409);
    expect(result?.body).toEqual({ result: 'conflict' });
  });

  test('answers 403 without the initiating browser nonce', async () => {
    const { dependencies, memory, queries } = createDependencies({}, unlinkedProvider);
    const { linkCode } = await startLinkFlow(dependencies, memory.storage);

    const missing = await confirm(dependencies, { link_code: linkCode });

    expect(missing?.status).toBe(403);
    expect(missing?.body).toMatchObject({ error: 'link_binding_failed' });
    expect(queries).toEqual([]);
  });

  test('answers 403 when the session is not the account the ticket was minted for', async () => {
    const { dependencies, memory, queries } = createDependencies({}, unlinkedProvider);
    // The flow was started by somebody else, so the stash names their uuid.
    const { nonce, linkCode } = await startLinkFlow(dependencies, memory.storage, OTHER_UUID);

    const result = await confirm(dependencies, { link_code: linkCode, nonce });

    expect(result?.status).toBe(403);
    expect(result?.body).toMatchObject({ error: 'link_binding_failed' });
    expect(queries).toEqual([]);
  });

  test('cannot be completed across two browsers (link CSRF)', async () => {
    // Attacker starts the flow (their session, their nonce) and calls
    // /authorize server side; the victim's browser finishes the round trip and
    // receives the link code. Neither side ends up holding all three secrets.
    const { dependencies, memory, queries } = createDependencies({}, unlinkedProvider);
    const attacker = await startLinkFlow(dependencies, memory.storage, SESSION_UUID);

    const victim = createDependencies(
      { verifyToken: sessionVerifier({ sub: OTHER_UUID, iat: 1, exp: 2 }), storage: memory.storage },
      unlinkedProvider,
    );

    // Victim's browser: has the code, never saw the nonce.
    const victimAttempt = await confirm(victim.dependencies, { link_code: attacker.linkCode });
    // Attacker: has the nonce and the right session, but no code.
    const attackerAttempt = await confirm(dependencies, { nonce: attacker.nonce });

    expect(victimAttempt?.status).toBe(403);
    expect(attackerAttempt?.status).toBe(410);
    // Neither side wrote anything: the victim's GitHub account stays unlinked.
    expect(queries).toEqual([]);
    expect(victim.queries).toEqual([]);
  });

  test('answers 410 for a missing, unknown or replayed code', async () => {
    const { dependencies, memory } = createDependencies({}, unlinkedProvider);
    const { nonce, linkCode } = await startLinkFlow(dependencies, memory.storage);

    expect((await confirm(dependencies, { link_code: linkCode, nonce }))?.status).toBe(200);

    for (const body of [
      { link_code: linkCode, nonce },
      { link_code: 'never-issued', nonce },
      { nonce },
      {},
      undefined,
      'not-an-object',
    ]) {
      const result = await confirm(dependencies, body);
      expect(result?.status).toBe(410);
      expect(result?.body).toMatchObject({ error: 'link_code_expired' });
    }
  });

  test('answers 401 without a session token, before the code is consumed', async () => {
    const { dependencies, memory } = createDependencies({}, unlinkedProvider);
    const { nonce, linkCode } = await startLinkFlow(dependencies, memory.storage);

    const result = await confirm(dependencies, { link_code: linkCode, nonce }, null);

    expect(result?.status).toBe(401);
    // An unauthenticated request must not be able to burn somebody's code.
    expect(memory.entries.get(linkCodeStorageKey(linkCode))).toBeDefined();
  });

  test('answers 503 when Supabase is unreachable', async () => {
    const { dependencies, memory } = createDependencies({}, () => ({
      data: null,
      error: { code: 'XX000', message: 'error code: 1016' },
    }));
    const { nonce, linkCode } = await startLinkFlow(dependencies, memory.storage);

    const result = await confirm(dependencies, { link_code: linkCode, nonce });

    expect(result?.status).toBe(503);
    expect(result?.body).toMatchObject({ error: 'accounts_unavailable' });
  });
});

describe('GET /accounts', () => {
  test('lists providers without exposing the provider-side identifier', async () => {
    const { dependencies, queries } = createDependencies({}, (query) =>
      query.table === 'accounts' ? { data: twoAccounts, error: null } : undefined,
    );

    const result = await handleAccountRoute(
      { method: 'GET', pathname: '/accounts', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(result?.status).toBe(200);
    expect(result?.body).toEqual({
      accounts: [
        { provider: 'github', linkedAt: '2026-01-01T00:00:00.000Z' },
        { provider: 'google', linkedAt: '2026-08-01T00:00:00.000Z' },
      ],
    });
    expect(JSON.stringify(result?.body)).not.toContain('38489680');
    expect(queries[0].filters).toEqual({ uuid: SESSION_UUID });
  });

  test('reads the user id from the token, never from the request (IDOR)', async () => {
    const { dependencies, queries } = createDependencies({}, (query) =>
      query.table === 'accounts' ? { data: [], error: null } : undefined,
    );

    await handleAccountRoute(
      {
        method: 'GET',
        pathname: '/accounts',
        authorizationHeader: 'Bearer token',
      },
      dependencies,
    );

    expect(queries[0].filters.uuid).toBe(SESSION_UUID);
    expect(queries[0].filters.uuid).not.toBe(OTHER_UUID);
  });

  test('answers 503 when Supabase is unreachable — the cache is never used here', async () => {
    const errors: unknown[] = [];
    const { dependencies } = createDependencies({ onError: (error) => errors.push(error) }, () => ({
      data: null,
      error: { code: 'XX000', message: 'error code: 1016' },
    }));

    const result = await handleAccountRoute(
      { method: 'GET', pathname: '/accounts', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(result?.status).toBe(503);
    expect(result?.body).toMatchObject({ error: 'accounts_unavailable' });
    expect(errors).toHaveLength(1);
  });
});

describe('DELETE /accounts/{provider}', () => {
  test('removes a provider when another login remains', async () => {
    const { dependencies, queries } = createDependencies({}, (query) => {
      if (query.table === 'accounts' && query.operation === 'select') {
        return { data: twoAccounts, error: null };
      }
      if (query.table === 'accounts' && query.operation === 'delete') {
        return { data: [twoAccounts[0]], error: null };
      }
      return undefined;
    });

    const result = await handleAccountRoute(
      { method: 'DELETE', pathname: '/accounts/github', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(result?.status).toBe(200);
    expect(result?.body).toEqual({ removed: true });
    expect(queries.find((query) => query.operation === 'delete')?.filters).toEqual({
      provider: 'github',
      identifier: '38489680',
      uuid: SESSION_UUID,
    });
  });

  test('revokes the cached provider mapping along with the row', async () => {
    const { dependencies, memory } = createDependencies(
      {},
      (query) => {
        if (query.table === 'accounts' && query.operation === 'select') {
          return { data: twoAccounts, error: null };
        }
        if (query.table === 'accounts' && query.operation === 'delete') {
          return { data: [twoAccounts[0]], error: null };
        }
        return undefined;
      },
      { 'account/github/38489680': SESSION_UUID },
    );

    const result = await handleAccountRoute(
      { method: 'DELETE', pathname: '/accounts/github', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(result?.status).toBe(200);
    expect(memory.entries.get('account/github/38489680')).toBeUndefined();
  });

  test('answers 400 last_account when a concurrent removal emptied the account', async () => {
    let selectCount = 0;
    const { dependencies } = createDependencies({}, (query) => {
      if (query.table !== 'accounts') {
        return undefined;
      }
      if (query.operation === 'select') {
        selectCount += 1;
        // The third read is the post-delete verification: by then the racing
        // request has removed the other provider.
        return { data: selectCount >= 3 ? [] : twoAccounts, error: null };
      }
      if (query.operation === 'delete') {
        return { data: [twoAccounts[0]], error: null };
      }
      return { data: query.payload, error: null };
    });

    const result = await handleAccountRoute(
      { method: 'DELETE', pathname: '/accounts/github', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    // Losing that race must not leave the user with zero ways to sign in.
    expect(result?.status).toBe(400);
    expect(result?.body).toMatchObject({ error: 'last_account' });
  });

  test('answers 400 last_account when only one login remains', async () => {
    const { dependencies, queries } = createDependencies({}, (query) =>
      query.table === 'accounts' && query.operation === 'select'
        ? { data: [twoAccounts[0]], error: null }
        : undefined,
    );

    const result = await handleAccountRoute(
      { method: 'DELETE', pathname: '/accounts/github', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(result?.status).toBe(400);
    expect(result?.body).toMatchObject({ error: 'last_account' });
    expect(queries.some((query) => query.operation === 'delete')).toBe(false);
  });

  test('answers 404 for a provider that is not linked', async () => {
    const { dependencies } = createDependencies({}, (query) =>
      query.table === 'accounts' && query.operation === 'select'
        ? { data: twoAccounts, error: null }
        : undefined,
    );

    const result = await handleAccountRoute(
      { method: 'DELETE', pathname: '/accounts/naver', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(result?.status).toBe(404);
    expect(result?.body).toMatchObject({ error: 'account_not_found' });
  });

  test('never deletes another user rows even when the path is manipulated', async () => {
    const { dependencies, queries } = createDependencies({}, (query) => {
      if (query.table === 'accounts' && query.operation === 'select') {
        return { data: twoAccounts, error: null };
      }
      return { data: [twoAccounts[1]], error: null };
    });

    await handleAccountRoute(
      {
        method: 'DELETE',
        pathname: `/accounts/google`,
        authorizationHeader: 'Bearer token',
      },
      dependencies,
    );

    for (const query of queries) {
      if (query.filters.uuid !== undefined) {
        expect(query.filters.uuid).toBe(SESSION_UUID);
      }
    }
  });

  test('decodes a percent-encoded provider segment', async () => {
    const { dependencies } = createDependencies({}, (query) =>
      query.table === 'accounts' && query.operation === 'select'
        ? { data: twoAccounts, error: null }
        : { data: [twoAccounts[0]], error: null },
    );

    const result = await handleAccountRoute(
      { method: 'DELETE', pathname: '/accounts/git%68ub', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(result?.status).toBe(200);
  });

  test('answers 503 when Supabase is unreachable', async () => {
    const { dependencies } = createDependencies({}, () => ({
      data: null,
      error: { code: 'XX000', message: 'error code: 1016' },
    }));

    const result = await handleAccountRoute(
      { method: 'DELETE', pathname: '/accounts/github', authorizationHeader: 'Bearer token' },
      dependencies,
    );

    expect(result?.status).toBe(503);
    expect(result?.body).toMatchObject({ error: 'accounts_unavailable' });
  });
});
