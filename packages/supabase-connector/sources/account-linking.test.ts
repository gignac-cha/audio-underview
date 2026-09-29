import { describe, test, expect, vi } from 'vitest';
import {
  LINK_CODE_LIFETIME_SECONDS,
  LINK_TICKET_LIFETIME_SECONDS,
  accountCacheStorageKey,
  confirmAccountLink,
  consumeLinkCode,
  consumeLinkTicket,
  createLinkTicket,
  forgetAccountUUID,
  linkCodeStorageKey,
  linkProviderAccount,
  linkTicketStorageKey,
  listLinkedAccounts,
  recallAccountUUID,
  rememberAccountUUID,
  resolveLoginAccount,
  stashLinkCode,
  unlinkProviderAccount,
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

const ACCOUNT_UUID = '83156cb5-c92a-4c75-b944-341d2d857bbf';
/** The UUID the removed deterministic fallback used to produce for github:38489680. */
const RETIRED_DETERMINISTIC_UUID = '675595f3-3512-539e-986b-4163018cf30f';

const githubInput = { provider: 'github' as const, identifier: '38489680' };

function respondWith(handler: (query: FakeQuery) => FakeQueryResult | undefined) {
  return createFakeSupabaseClient((query) => handler(query) ?? { data: null, error: null });
}

describe('link tickets', () => {
  test('stores a single-use ticket and its browser nonce for 300 seconds', async () => {
    const memory = createMemoryAccountStateStorage();

    const { ticket, nonce } = await createLinkTicket(memory.storage, ACCOUNT_UUID);

    expect(ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    // The nonce is a second, independent secret — not a copy of the ticket the
    // URL already carries.
    expect(nonce).not.toBe(ticket);
    expect(memory.writes).toEqual([
      {
        key: `link-ticket/${ticket}`,
        value: JSON.stringify({ uuid: ACCOUNT_UUID, nonce }),
        options: { expirationTtl: LINK_TICKET_LIFETIME_SECONDS },
      },
    ]);
    expect(LINK_TICKET_LIFETIME_SECONDS).toBe(300);
  });

  test('redeems a ticket exactly once, nonce included', async () => {
    const memory = createMemoryAccountStateStorage();
    const { ticket, nonce } = await createLinkTicket(memory.storage, ACCOUNT_UUID);

    expect(await consumeLinkTicket(memory.storage, ticket)).toEqual({
      userUUID: ACCOUNT_UUID,
      nonce,
    });
    expect(memory.deletions).toEqual([linkTicketStorageKey(ticket)]);

    // Replay of the same ticket finds nothing.
    expect(await consumeLinkTicket(memory.storage, ticket)).toBeUndefined();
  });

  test('treats an expired or unknown ticket as no ticket', async () => {
    const memory = createMemoryAccountStateStorage();

    expect(await consumeLinkTicket(memory.storage, 'never-issued')).toBeUndefined();
    expect(await consumeLinkTicket(memory.storage, null)).toBeUndefined();
    expect(await consumeLinkTicket(memory.storage, '')).toBeUndefined();
  });

  test('refuses the ticket when single use cannot be guaranteed', async () => {
    const memory = createMemoryAccountStateStorage();
    const { ticket } = await createLinkTicket(memory.storage, ACCOUNT_UUID);

    const storage: AccountStateStorage = {
      get: memory.storage.get,
      put: memory.storage.put,
      delete: async () => {
        throw new Error('KV delete failed');
      },
    };

    expect(await consumeLinkTicket(storage, ticket)).toBeUndefined();
  });

  test('ignores a ticket whose stored value is not the expected shape', async () => {
    const memory = createMemoryAccountStateStorage({
      [linkTicketStorageKey('broken')]: 'not-json',
      [linkTicketStorageKey('empty')]: JSON.stringify({ uuid: '', nonce: 'n' }),
      // A ticket with no nonce cannot bind a browser, so it is not a ticket.
      [linkTicketStorageKey('nonceless')]: JSON.stringify({ uuid: ACCOUNT_UUID }),
    });

    expect(await consumeLinkTicket(memory.storage, 'broken')).toBeUndefined();
    expect(await consumeLinkTicket(memory.storage, 'empty')).toBeUndefined();
    expect(await consumeLinkTicket(memory.storage, 'nonceless')).toBeUndefined();
  });
});

describe('link codes', () => {
  const stashedIdentity = {
    userUUID: ACCOUNT_UUID,
    provider: 'github' as const,
    identifier: '38489680',
    nonce: 'nonce-1',
  };

  test('stashes the provider identity for 120 seconds', async () => {
    const memory = createMemoryAccountStateStorage();

    const linkCode = await stashLinkCode(memory.storage, stashedIdentity);

    expect(linkCode).toMatch(/^[0-9a-f-]{36}$/);
    expect(memory.writes).toEqual([
      {
        key: `link-code/${linkCode}`,
        value: JSON.stringify({
          uuid: ACCOUNT_UUID,
          provider: 'github',
          identifier: '38489680',
          nonce: 'nonce-1',
        }),
        options: { expirationTtl: LINK_CODE_LIFETIME_SECONDS },
      },
    ]);
    expect(LINK_CODE_LIFETIME_SECONDS).toBe(120);
  });

  test('redeems a link code exactly once', async () => {
    const memory = createMemoryAccountStateStorage();
    const linkCode = await stashLinkCode(memory.storage, stashedIdentity);

    expect(await consumeLinkCode(memory.storage, linkCode)).toEqual(stashedIdentity);
    expect(memory.deletions).toEqual([linkCodeStorageKey(linkCode)]);
    expect(await consumeLinkCode(memory.storage, linkCode)).toBeUndefined();
  });

  test('treats an unknown, empty or malformed code as no code', async () => {
    const memory = createMemoryAccountStateStorage({
      [linkCodeStorageKey('broken')]: 'not-json',
      [linkCodeStorageKey('partial')]: JSON.stringify({ uuid: ACCOUNT_UUID, provider: 'github' }),
    });

    expect(await consumeLinkCode(memory.storage, 'never-issued')).toBeUndefined();
    expect(await consumeLinkCode(memory.storage, null)).toBeUndefined();
    expect(await consumeLinkCode(memory.storage, '')).toBeUndefined();
    expect(await consumeLinkCode(memory.storage, 'broken')).toBeUndefined();
    expect(await consumeLinkCode(memory.storage, 'partial')).toBeUndefined();
  });

  test('refuses the code when single use cannot be guaranteed', async () => {
    const memory = createMemoryAccountStateStorage();
    const linkCode = await stashLinkCode(memory.storage, stashedIdentity);

    const storage: AccountStateStorage = {
      get: memory.storage.get,
      put: memory.storage.put,
      delete: async () => {
        throw new Error('KV delete failed');
      },
    };

    expect(await consumeLinkCode(storage, linkCode)).toBeUndefined();
  });
});

describe('account UUID cache', () => {
  test('round-trips through the provider/identifier key', async () => {
    const memory = createMemoryAccountStateStorage();

    await rememberAccountUUID(memory.storage, githubInput, ACCOUNT_UUID);

    expect(accountCacheStorageKey(githubInput)).toBe('account/github/38489680');
    // No TTL — the mapping is immutable for the life of the account.
    expect(memory.writes[0].options).toBeUndefined();
    expect(await recallAccountUUID(memory.storage, githubInput)).toBe(ACCOUNT_UUID);
  });

  test('reports a miss for an unknown account', async () => {
    const memory = createMemoryAccountStateStorage();
    expect(await recallAccountUUID(memory.storage, githubInput)).toBeUndefined();
  });

  test('forgets a mapping so the provider no longer resolves to the account', async () => {
    const memory = createMemoryAccountStateStorage({ 'account/github/38489680': ACCOUNT_UUID });

    await forgetAccountUUID(memory.storage, githubInput);

    expect(memory.deletions).toEqual(['account/github/38489680']);
    expect(await recallAccountUUID(memory.storage, githubInput)).toBeUndefined();
  });
});

describe('resolveLoginAccount', () => {
  test('prefers Supabase and caches what it resolved', async () => {
    const memory = createMemoryAccountStateStorage();
    const { client } = respondWith((query) =>
      query.table === 'accounts' && query.operation === 'select'
        ? { data: { ...githubInput, uuid: ACCOUNT_UUID }, error: null }
        : undefined,
    );

    const resolution = await resolveLoginAccount({
      storage: memory.storage,
      createClient: () => client,
      input: githubInput,
    });

    expect(resolution).toEqual({
      resolved: true,
      userUUID: ACCOUNT_UUID,
      source: 'supabase',
      isNewUser: false,
      isNewAccount: false,
    });
    expect(memory.entries.get('account/github/38489680')).toBe(ACCOUNT_UUID);
  });

  test('falls back to the cache when Supabase is unreachable', async () => {
    const memory = createMemoryAccountStateStorage({ 'account/github/38489680': ACCOUNT_UUID });
    const supabaseErrors: unknown[] = [];
    const { client } = respondWith(() => ({
      data: null,
      error: { code: 'XX000', message: 'error code: 1016' },
    }));

    const resolution = await resolveLoginAccount({
      storage: memory.storage,
      createClient: () => client,
      input: githubInput,
      onSupabaseError: (error) => supabaseErrors.push(error),
    });

    expect(resolution).toEqual({
      resolved: true,
      userUUID: ACCOUNT_UUID,
      source: 'cache',
      isNewUser: false,
      isNewAccount: false,
    });
    expect(supabaseErrors).toHaveLength(1);
  });

  test('fails closed for a brand new account when Supabase is unreachable', async () => {
    const memory = createMemoryAccountStateStorage();
    const { client } = respondWith(() => ({
      data: null,
      error: { code: 'XX000', message: 'error code: 1016' },
    }));

    const resolution = await resolveLoginAccount({
      storage: memory.storage,
      createClient: () => client,
      input: githubInput,
    });

    expect(resolution).toEqual({ resolved: false, reason: 'unavailable' });
    // The deterministic-UUID fallback is gone for good: nothing is invented.
    expect(JSON.stringify(resolution)).not.toContain(RETIRED_DETERMINISTIC_UUID);
    expect(memory.entries.size).toBe(0);
  });

  test('fails closed when the client cannot even be constructed', async () => {
    const memory = createMemoryAccountStateStorage();

    const resolution = await resolveLoginAccount({
      storage: memory.storage,
      createClient: () => {
        throw new Error('SUPABASE_URL is not configured');
      },
      input: githubInput,
    });

    expect(resolution).toEqual({ resolved: false, reason: 'unavailable' });
  });

  test('still logs the user in when the cache write fails', async () => {
    const memory = createMemoryAccountStateStorage();
    const storage: AccountStateStorage = {
      get: memory.storage.get,
      put: async () => {
        throw new Error('KV put failed');
      },
      delete: memory.storage.delete,
    };
    const { client } = respondWith((query) =>
      query.table === 'accounts' && query.operation === 'select'
        ? { data: { ...githubInput, uuid: ACCOUNT_UUID }, error: null }
        : undefined,
    );

    const resolution = await resolveLoginAccount({
      storage,
      createClient: () => client,
      input: githubInput,
    });

    expect(resolution).toMatchObject({ resolved: true, userUUID: ACCOUNT_UUID, source: 'supabase' });
  });
});

describe('linkProviderAccount', () => {
  test('links a provider that is not attached anywhere yet', async () => {
    const { client, queries } = respondWith((query) => {
      if (query.table === 'accounts' && query.operation === 'select') {
        return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      }
      if (query.table === 'users' && query.operation === 'select') {
        return { data: { uuid: ACCOUNT_UUID }, error: null };
      }
      if (query.table === 'accounts' && query.operation === 'insert') {
        return { data: { ...githubInput, uuid: ACCOUNT_UUID }, error: null };
      }
      return undefined;
    });

    expect(await linkProviderAccount(client, ACCOUNT_UUID, githubInput)).toBe('linked');
    expect(queries.some((query) => query.table === 'accounts' && query.operation === 'insert')).toBe(true);
  });

  test('reports already_linked when the provider is attached to the same user', async () => {
    const { client } = respondWith((query) =>
      query.table === 'accounts' && query.operation === 'select'
        ? { data: { ...githubInput, uuid: ACCOUNT_UUID }, error: null }
        : undefined,
    );

    expect(await linkProviderAccount(client, ACCOUNT_UUID, githubInput)).toBe('already_linked');
  });

  test('reports conflict when the provider belongs to a different user', async () => {
    const { client } = respondWith((query) =>
      query.table === 'accounts' && query.operation === 'select'
        ? { data: { ...githubInput, uuid: 'somebody-else' }, error: null }
        : undefined,
    );

    expect(await linkProviderAccount(client, ACCOUNT_UUID, githubInput)).toBe('conflict');
  });

  test('reports conflict when the insert loses a race on the primary key', async () => {
    const { client } = respondWith((query) => {
      if (query.table === 'accounts' && query.operation === 'select') {
        return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      }
      if (query.table === 'users' && query.operation === 'select') {
        return { data: { uuid: ACCOUNT_UUID }, error: null };
      }
      return {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "accounts_pkey"' },
      };
    });

    expect(await linkProviderAccount(client, ACCOUNT_UUID, githubInput)).toBe('conflict');
  });

  test('rethrows failures that are not conflicts', async () => {
    const { client } = respondWith(() => ({
      data: null,
      error: { code: 'XX000', message: 'error code: 1016' },
    }));

    await expect(linkProviderAccount(client, ACCOUNT_UUID, githubInput)).rejects.toThrow('1016');
  });
});

describe('confirmAccountLink', () => {
  const VICTIM_UUID = '11111111-2222-3333-4444-555555555555';

  /**
   * Replays the two halves of a link flow the way the workers do: the SPA mints
   * a ticket (and keeps the nonce in its own sessionStorage), then the OAuth
   * callback redeems that ticket and stashes a link code.
   */
  async function startLinkFlow(
    memory: ReturnType<typeof createMemoryAccountStateStorage>,
    userUUID: string = ACCOUNT_UUID,
  ) {
    const { ticket, nonce } = await createLinkTicket(memory.storage, userUUID);
    const binding = await consumeLinkTicket(memory.storage, ticket);

    const linkCode = await stashLinkCode(memory.storage, {
      userUUID: binding!.userUUID,
      provider: githubInput.provider,
      identifier: githubInput.identifier,
      nonce: binding!.nonce,
    });

    return { nonce, linkCode };
  }

  function supabaseFor(respond: (query: FakeQuery) => FakeQueryResult | undefined) {
    const fake = respondWith(respond);
    let clientRequests = 0;

    return {
      queries: fake.queries,
      countClientRequests: () => clientRequests,
      createClient: () => {
        clientRequests += 1;
        return fake.client;
      },
    };
  }

  const unlinkedProvider = (query: FakeQuery): FakeQueryResult | undefined => {
    if (query.table === 'accounts' && query.operation === 'select') {
      return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    }
    if (query.table === 'users' && query.operation === 'select') {
      return { data: { uuid: ACCOUNT_UUID }, error: null };
    }
    if (query.table === 'accounts' && query.operation === 'insert') {
      return { data: { ...githubInput, uuid: ACCOUNT_UUID }, error: null };
    }
    return undefined;
  };

  test('links when the code, the nonce and the session all line up', async () => {
    const memory = createMemoryAccountStateStorage();
    const { nonce, linkCode } = await startLinkFlow(memory);
    const supabase = supabaseFor(unlinkedProvider);

    const result = await confirmAccountLink(memory.storage, {
      linkCode,
      nonce,
      sub: ACCOUNT_UUID,
      createClient: supabase.createClient,
    });

    expect(result).toEqual({ confirmed: true, outcome: 'linked', provider: 'github' });
    // The link is what fills the Supabase-outage cache; the callback no longer does.
    expect(memory.entries.get(accountCacheStorageKey(githubInput))).toBe(ACCOUNT_UUID);
  });

  test('reports already_linked and conflict from the underlying link', async () => {
    const memory = createMemoryAccountStateStorage();

    const already = await startLinkFlow(memory);
    expect(
      await confirmAccountLink(memory.storage, {
        linkCode: already.linkCode,
        nonce: already.nonce,
        sub: ACCOUNT_UUID,
        createClient: supabaseFor((query) =>
          query.table === 'accounts' && query.operation === 'select'
            ? { data: { ...githubInput, uuid: ACCOUNT_UUID }, error: null }
            : undefined,
        ).createClient,
      }),
    ).toMatchObject({ confirmed: true, outcome: 'already_linked' });

    const conflicting = await startLinkFlow(memory);
    memory.entries.delete(accountCacheStorageKey(githubInput));

    expect(
      await confirmAccountLink(memory.storage, {
        linkCode: conflicting.linkCode,
        nonce: conflicting.nonce,
        sub: ACCOUNT_UUID,
        createClient: supabaseFor((query) =>
          query.table === 'accounts' && query.operation === 'select'
            ? { data: { ...githubInput, uuid: 'somebody-else' }, error: null }
            : undefined,
        ).createClient,
      }),
    ).toMatchObject({ confirmed: true, outcome: 'conflict' });

    // A conflict must not point the outage cache at the wrong account.
    expect(memory.entries.get(accountCacheStorageKey(githubInput))).toBeUndefined();
  });

  test('refuses a confirmation that does not carry the initiating browser nonce', async () => {
    const memory = createMemoryAccountStateStorage();
    const { linkCode } = await startLinkFlow(memory);
    const supabase = supabaseFor(unlinkedProvider);

    const result = await confirmAccountLink(memory.storage, {
      linkCode,
      nonce: crypto.randomUUID(),
      sub: ACCOUNT_UUID,
      createClient: supabase.createClient,
    });

    expect(result).toEqual({ confirmed: false, reason: 'link_binding_failed' });
    // Nothing was linked: Supabase was never even reached for.
    expect(supabase.countClientRequests()).toBe(0);
    expect(supabase.queries).toEqual([]);
  });

  test('refuses a link code confirmed under a different session (reverse direction)', async () => {
    const memory = createMemoryAccountStateStorage();
    const { nonce, linkCode } = await startLinkFlow(memory);
    const supabase = supabaseFor(unlinkedProvider);

    // Attacker's provider identity, victim's session: `sub !== stashed uuid`.
    const result = await confirmAccountLink(memory.storage, {
      linkCode,
      nonce,
      sub: VICTIM_UUID,
      createClient: supabase.createClient,
    });

    expect(result).toEqual({ confirmed: false, reason: 'link_binding_failed' });
    expect(supabase.queries).toEqual([]);
  });

  test('cannot be completed when the two halves live in different browsers (link CSRF)', async () => {
    // The attack: the attacker mints a ticket for THEIR account and calls
    // /authorize server side, then sends the victim the provider URL. The
    // victim's browser finishes the round trip, so the callback stashes the
    // victim's GitHub identity against the attacker's uuid — and hands the
    // link code to the victim's browser, while the nonce stayed with the
    // attacker.
    const memory = createMemoryAccountStateStorage();
    const attacker = await startLinkFlow(memory, ACCOUNT_UUID);
    const supabase = supabaseFor(unlinkedProvider);

    // The victim's browser has the code but never saw the nonce, and its
    // session belongs to the victim.
    const victimAttempt = await confirmAccountLink(memory.storage, {
      linkCode: attacker.linkCode,
      nonce: undefined,
      sub: VICTIM_UUID,
      createClient: supabase.createClient,
    });

    // The attacker has the nonce and the matching session but no link code.
    const attackerAttempt = await confirmAccountLink(memory.storage, {
      linkCode: undefined,
      nonce: attacker.nonce,
      sub: ACCOUNT_UUID,
      createClient: supabase.createClient,
    });

    expect(victimAttempt).toEqual({ confirmed: false, reason: 'link_binding_failed' });
    expect(attackerAttempt).toEqual({ confirmed: false, reason: 'link_code_expired' });
    // Zero links, zero Supabase writes, from either side.
    expect(supabase.queries).toEqual([]);
    expect(memory.entries.get(accountCacheStorageKey(githubInput))).toBeUndefined();
  });

  test('burns the link code even when the binding check fails', async () => {
    const memory = createMemoryAccountStateStorage();
    const { nonce, linkCode } = await startLinkFlow(memory);
    const supabase = supabaseFor(unlinkedProvider);

    await confirmAccountLink(memory.storage, {
      linkCode,
      nonce: 'wrong',
      sub: ACCOUNT_UUID,
      createClient: supabase.createClient,
    });

    // A guessed nonce does not get a second try against the same code.
    expect(
      await confirmAccountLink(memory.storage, {
        linkCode,
        nonce,
        sub: ACCOUNT_UUID,
        createClient: supabase.createClient,
      }),
    ).toEqual({ confirmed: false, reason: 'link_code_expired' });
    expect(supabase.queries).toEqual([]);
  });

  test('reports link_code_expired for a missing, replayed or non-string code', async () => {
    const memory = createMemoryAccountStateStorage();
    const supabase = supabaseFor(unlinkedProvider);

    for (const linkCode of [undefined, null, '', 'never-issued', 42, { code: 'x' }]) {
      expect(
        await confirmAccountLink(memory.storage, {
          linkCode,
          nonce: 'whatever',
          sub: ACCOUNT_UUID,
          createClient: supabase.createClient,
        }),
      ).toEqual({ confirmed: false, reason: 'link_code_expired' });
    }

    expect(supabase.queries).toEqual([]);
  });

  test('propagates a Supabase failure so the caller can answer 503', async () => {
    const memory = createMemoryAccountStateStorage();
    const { nonce, linkCode } = await startLinkFlow(memory);
    const supabase = supabaseFor(() => ({
      data: null,
      error: { code: 'XX000', message: 'error code: 1016' },
    }));

    await expect(
      confirmAccountLink(memory.storage, {
        linkCode,
        nonce,
        sub: ACCOUNT_UUID,
        createClient: supabase.createClient,
      }),
    ).rejects.toThrow('1016');
  });
});

describe('listLinkedAccounts', () => {
  test('returns provider and link time only, oldest first', async () => {
    const { client } = respondWith((query) =>
      query.table === 'accounts'
        ? {
            data: [
              { provider: 'google', identifier: 'google-sub-1', uuid: ACCOUNT_UUID, created_at: '2026-08-01T10:00:00+00:00' },
              { provider: 'github', identifier: '38489680', uuid: ACCOUNT_UUID, created_at: '2026-01-01T00:00:00+00:00' },
            ],
            error: null,
          }
        : undefined,
    );

    const accounts = await listLinkedAccounts(client, ACCOUNT_UUID);

    expect(accounts).toEqual([
      { provider: 'github', linkedAt: '2026-01-01T00:00:00.000Z' },
      { provider: 'google', linkedAt: '2026-08-01T10:00:00.000Z' },
    ]);
    // The provider-side identifier must never leak to the client.
    expect(JSON.stringify(accounts)).not.toContain('38489680');
  });

  test('scopes the query to the given user', async () => {
    const { client, queries } = respondWith((query) =>
      query.table === 'accounts' ? { data: [], error: null } : undefined,
    );

    await listLinkedAccounts(client, ACCOUNT_UUID);

    expect(queries[0].filters).toEqual({ uuid: ACCOUNT_UUID });
  });

  test('keeps an unparseable timestamp instead of inventing one', async () => {
    const { client } = respondWith((query) =>
      query.table === 'accounts'
        ? { data: [{ provider: 'github', identifier: '1', uuid: ACCOUNT_UUID, created_at: 'not-a-date' }], error: null }
        : undefined,
    );

    expect(await listLinkedAccounts(client, ACCOUNT_UUID)).toEqual([
      { provider: 'github', linkedAt: 'not-a-date' },
    ]);
  });

  test('reports a null link time when the column is absent', async () => {
    const { client } = respondWith((query) =>
      query.table === 'accounts'
        ? { data: [{ provider: 'github', identifier: '1', uuid: ACCOUNT_UUID }], error: null }
        : undefined,
    );

    expect(await listLinkedAccounts(client, ACCOUNT_UUID)).toEqual([
      { provider: 'github', linkedAt: null },
    ]);
  });
});

describe('unlinkProviderAccount', () => {
  const twoAccounts = [
    { provider: 'github', identifier: '38489680', uuid: ACCOUNT_UUID, created_at: '2026-01-01T00:00:00Z' },
    { provider: 'google', identifier: 'google-sub-1', uuid: ACCOUNT_UUID, created_at: '2026-08-01T00:00:00Z' },
  ];

  /**
   * `unlinkProviderAccount` reads the account list more than once (its own
   * guard, the connector's guard inside `unlinkAccount`, and the post-delete
   * verification), so tests that care about a row count *changing* underneath
   * the request answer the selects in order; the last entry repeats.
   */
  function accountsResponder(options: {
    selects: unknown[][];
    deleteRows?: unknown[];
    insertError?: unknown;
  }) {
    let selectIndex = 0;

    return (query: FakeQuery): FakeQueryResult | undefined => {
      if (query.table !== 'accounts') {
        return undefined;
      }

      if (query.operation === 'select') {
        const data = options.selects[Math.min(selectIndex, options.selects.length - 1)];
        selectIndex += 1;
        return { data, error: null };
      }

      if (query.operation === 'delete') {
        return { data: options.deleteRows ?? [], error: null };
      }

      if (query.operation === 'insert') {
        return options.insertError
          ? { data: null, error: options.insertError }
          : { data: query.payload, error: null };
      }

      return undefined;
    };
  }

  function unlinkOptions(
    provider: string,
    respond: (query: FakeQuery) => FakeQueryResult | undefined,
    initialEntries: Record<string, string> = { 'account/github/38489680': ACCOUNT_UUID },
  ) {
    const memory = createMemoryAccountStateStorage(initialEntries);
    const fake = respondWith(respond);

    return {
      memory,
      queries: fake.queries,
      options: {
        client: fake.client,
        userUUID: ACCOUNT_UUID,
        provider,
        storage: memory.storage,
      },
    };
  }

  test('removes the requested provider and scopes the delete to the user', async () => {
    const { options, queries } = unlinkOptions(
      'github',
      accountsResponder({ selects: [twoAccounts], deleteRows: [twoAccounts[0]] }),
    );

    expect(await unlinkProviderAccount(options)).toEqual({ removed: true });

    const deletion = queries.find((query) => query.operation === 'delete');
    expect(deletion?.filters).toEqual({
      provider: 'github',
      identifier: '38489680',
      uuid: ACCOUNT_UUID,
    });
  });

  test('drops the cached provider mapping as part of removing the login', async () => {
    const { options, memory } = unlinkOptions(
      'github',
      accountsResponder({ selects: [twoAccounts], deleteRows: [twoAccounts[0]] }),
    );

    await unlinkProviderAccount(options);

    // Without this the disconnected provider still resolves to this account
    // whenever Supabase is unreachable — the removal would revoke nothing.
    expect(memory.entries.get('account/github/38489680')).toBeUndefined();
  });

  test('does not delete the row when the cached mapping cannot be dropped', async () => {
    const { options, memory, queries } = unlinkOptions(
      'github',
      accountsResponder({ selects: [twoAccounts], deleteRows: [twoAccounts[0]] }),
    );

    const failingStorage: AccountStateStorage = {
      get: memory.storage.get,
      put: memory.storage.put,
      delete: async () => {
        throw new Error('KV delete failed');
      },
    };

    await expect(
      unlinkProviderAccount({ ...options, storage: failingStorage }),
    ).rejects.toThrow('KV delete failed');

    // Revoking first means a KV failure leaves the account whole instead of
    // leaving a cached credential that outlives the row.
    expect(queries.some((query) => query.operation === 'delete')).toBe(false);
  });

  test('refuses to remove the last remaining login', async () => {
    const { options, queries, memory } = unlinkOptions(
      'github',
      accountsResponder({ selects: [[twoAccounts[0]]] }),
    );

    expect(await unlinkProviderAccount(options)).toEqual({
      removed: false,
      reason: 'last_account',
    });
    expect(queries.some((query) => query.operation === 'delete')).toBe(false);
    expect(memory.deletions).toEqual([]);
  });

  test('restores the row when a concurrent removal emptied the account', async () => {
    // Two DELETEs for different providers overlap: both read two rows, both
    // pass the guard, and the second one finds the account empty afterwards.
    const { options, queries } = unlinkOptions(
      'github',
      accountsResponder({
        selects: [twoAccounts, twoAccounts, []],
        deleteRows: [twoAccounts[0]],
      }),
    );

    expect(await unlinkProviderAccount(options)).toEqual({
      removed: false,
      reason: 'last_account',
    });

    const restore = queries.find((query) => query.operation === 'insert');
    expect(restore?.payload).toEqual({
      provider: 'github',
      identifier: '38489680',
      uuid: ACCOUNT_UUID,
    });
  });

  test('reports loudly when the account was emptied and cannot be restored', async () => {
    const { options } = unlinkOptions(
      'github',
      accountsResponder({
        selects: [twoAccounts, twoAccounts, []],
        deleteRows: [twoAccounts[0]],
        insertError: { code: 'XX000', message: 'error code: 1016' },
      }),
    );

    await expect(unlinkProviderAccount(options)).rejects.toThrow(ACCOUNT_UUID);
  });

  test('reports account_not_found for a provider that is not linked', async () => {
    const { options, queries, memory } = unlinkOptions(
      'naver',
      accountsResponder({ selects: [twoAccounts] }),
    );

    expect(await unlinkProviderAccount(options)).toEqual({
      removed: false,
      reason: 'account_not_found',
    });
    expect(queries.some((query) => query.operation === 'delete')).toBe(false);
    expect(memory.deletions).toEqual([]);
  });

  test('reports account_not_found when the delete matched no row', async () => {
    const { options } = unlinkOptions(
      'github',
      accountsResponder({ selects: [twoAccounts], deleteRows: [] }),
    );

    expect(await unlinkProviderAccount(options)).toEqual({
      removed: false,
      reason: 'account_not_found',
    });
  });
});
