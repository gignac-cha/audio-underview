import {
  findAccount,
  findUser,
  getAccountsByUser,
  createUser,
  createAccount,
  handleSocialLogin,
  linkAccount,
  unlinkAccount,
  deleteUser,
} from './accounts.ts';

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

afterEach(() => {
  vi.restoreAllMocks();
});

function createChainableMock(result: { data?: unknown; error?: unknown; count?: number }) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'range', 'order'];
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  // Terminal methods return result
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['select'] = vi.fn().mockImplementation(() => {
    // After select, return object that has both .single() and direct resolution
    return {
      ...chain,
      single: vi.fn().mockResolvedValue(result),
      eq: vi.fn().mockImplementation(() => ({
        ...chain,
        single: vi.fn().mockResolvedValue(result),
        eq: vi.fn().mockImplementation(() => ({
          single: vi.fn().mockResolvedValue(result),
          select: vi.fn().mockResolvedValue(result),
          then: (resolve: Function) => resolve(result),
        })),
        then: (resolve: Function) => resolve(result),
      })),
      then: (resolve: Function) => resolve(result),
    };
  });
  return chain;
}

function createMockClient(tableResults: Record<string, { data?: unknown; error?: unknown }> = {}) {
  // Create a simple proxy-based mock that returns proper chainable methods
  const defaultResult = { data: null, error: null };

  return {
    from: vi.fn((table: string) => {
      const result = tableResults[table] ?? defaultResult;
      const terminalResult = Promise.resolve(result);

      const createChain = (): Record<string, Function> => {
        const self: Record<string, Function> = {};
        for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'single', 'range', 'order']) {
          self[m] = vi.fn().mockReturnValue(self);
        }
        // Make the chain thenable for non-single queries
        (self as any).then = (resolve: Function) => resolve(result);
        // single() resolves the promise
        self.single = vi.fn().mockImplementation(() => terminalResult);
        return self;
      };

      return createChain();
    }),
  } as any;
}

describe('findAccount', () => {
  test('returns account when found', async () => {
    const account = { provider: 'google', identifier: 'id-1', uuid: 'uuid-1' };
    const client = createMockClient({ accounts: { data: account, error: null } });

    const result = await findAccount(client, { provider: 'google', identifier: 'id-1' });
    expect(result).toEqual(account);
  });

  test('returns null on PGRST116 (not found)', async () => {
    const client = createMockClient({
      accounts: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await findAccount(client, { provider: 'google', identifier: 'id-1' });
    expect(result).toBeNull();
  });

  test('throws on other errors', async () => {
    const client = createMockClient({
      accounts: { data: null, error: { code: 'OTHER', message: 'db error' } },
    });

    await expect(findAccount(client, { provider: 'google', identifier: 'id-1' })).rejects.toThrow('Failed to find account');
  });
});

describe('findUser', () => {
  test('returns user when found', async () => {
    const user = { uuid: 'uuid-1' };
    const client = createMockClient({ users: { data: user, error: null } });

    const result = await findUser(client, 'uuid-1');
    expect(result).toEqual(user);
  });

  test('returns null on PGRST116', async () => {
    const client = createMockClient({
      users: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await findUser(client, 'uuid-1');
    expect(result).toBeNull();
  });

  test('throws on other errors', async () => {
    const client = createMockClient({
      users: { data: null, error: { code: 'OTHER', message: 'db error' } },
    });

    await expect(findUser(client, 'uuid-1')).rejects.toThrow('Failed to find user');
  });
});

describe('getAccountsByUser', () => {
  test('returns array of accounts', async () => {
    const accounts = [
      { provider: 'google', identifier: 'id-1', uuid: 'uuid-1' },
      { provider: 'github', identifier: 'id-2', uuid: 'uuid-1' },
    ];
    const client = createMockClient({ accounts: { data: accounts, error: null } });

    const result = await getAccountsByUser(client, 'uuid-1');
    expect(result).toEqual(accounts);
  });

  test('returns empty array when no accounts', async () => {
    const client = createMockClient({ accounts: { data: [], error: null } });

    const result = await getAccountsByUser(client, 'uuid-1');
    expect(result).toEqual([]);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      accounts: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(getAccountsByUser(client, 'uuid-1')).rejects.toThrow('Failed to get accounts');
  });
});

describe('createUser', () => {
  test('returns created user', async () => {
    const user = { uuid: 'new-uuid' };
    const client = createMockClient({ users: { data: user, error: null } });

    const result = await createUser(client);
    expect(result).toEqual(user);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      users: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(createUser(client)).rejects.toThrow('Failed to create user');
  });
});

describe('createAccount', () => {
  test('returns created account', async () => {
    const account = { provider: 'google', identifier: 'id-1', uuid: 'uuid-1' };
    const client = createMockClient({ accounts: { data: account, error: null } });

    const result = await createAccount(client, { provider: 'google', identifier: 'id-1', userUUID: 'uuid-1' });
    expect(result).toEqual(account);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      accounts: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(
      createAccount(client, { provider: 'google', identifier: 'id-1', userUUID: 'uuid-1' }),
    ).rejects.toThrow('Failed to create account');
  });
});

describe('handleSocialLogin', () => {
  test('returns existing account if found', async () => {
    const existingAccount = { provider: 'google', identifier: 'id-1', uuid: 'existing-uuid' };
    // findAccount finds it
    const client = createMockClient({ accounts: { data: existingAccount, error: null } });

    const result = await handleSocialLogin(client, { provider: 'google', identifier: 'id-1' });
    expect(result.userUUID).toBe('existing-uuid');
    expect(result.isNewUser).toBe(false);
    expect(result.isNewAccount).toBe(false);
  });

  test('creates new user and account when not found', async () => {
    // We need more nuanced mocking here - first call to accounts returns PGRST116,
    // users insert returns new user, accounts insert returns new account
    const callCount = { accounts: 0, users: 0 };
    const client = {
      from: vi.fn((table: string) => {
        const createChain = (resolveValue: unknown): Record<string, Function> => {
          const self: Record<string, Function> = {};
          for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'range', 'order']) {
            self[m] = vi.fn().mockReturnValue(self);
          }
          (self as any).then = (resolve: Function) => resolve(resolveValue);
          self.single = vi.fn().mockImplementation(() => Promise.resolve(resolveValue));
          return self;
        };

        if (table === 'accounts') {
          callCount.accounts++;
          if (callCount.accounts === 1) {
            // findAccount - not found
            return createChain({ data: null, error: { code: 'PGRST116', message: 'not found' } });
          }
          // createAccount - success
          return createChain({ data: { provider: 'google', identifier: 'id-1', uuid: 'new-uuid' }, error: null });
        }
        if (table === 'users') {
          return createChain({ data: { uuid: 'new-uuid' }, error: null });
        }
        return createChain({ data: null, error: null });
      }),
    } as any;

    const result = await handleSocialLogin(client, { provider: 'google', identifier: 'id-1' });
    expect(result.userUUID).toBe('new-uuid');
    expect(result.isNewUser).toBe(true);
    expect(result.isNewAccount).toBe(true);
  });
});

describe('linkAccount', () => {
  test('returns alreadyLinked when same user has account', async () => {
    const existingAccount = { provider: 'google', identifier: 'id-1', uuid: 'uuid-1' };
    const client = createMockClient({ accounts: { data: existingAccount, error: null } });

    const result = await linkAccount(client, 'uuid-1', { provider: 'google', identifier: 'id-1' });
    expect(result.success).toBe(true);
    expect(result.alreadyLinked).toBe(true);
  });

  test('throws when account linked to different user', async () => {
    const existingAccount = { provider: 'google', identifier: 'id-1', uuid: 'other-uuid' };
    const client = createMockClient({ accounts: { data: existingAccount, error: null } });

    await expect(
      linkAccount(client, 'uuid-1', { provider: 'google', identifier: 'id-1' }),
    ).rejects.toThrow('already linked to another user');
  });

  test('throws when user not found', async () => {
    const callCount = { accounts: 0, users: 0 };
    const client = {
      from: vi.fn((table: string) => {
        const createChain = (resolveValue: unknown): Record<string, Function> => {
          const self: Record<string, Function> = {};
          for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'range', 'order']) {
            self[m] = vi.fn().mockReturnValue(self);
          }
          (self as any).then = (resolve: Function) => resolve(resolveValue);
          self.single = vi.fn().mockImplementation(() => Promise.resolve(resolveValue));
          return self;
        };

        if (table === 'accounts') {
          // findAccount - not found
          return createChain({ data: null, error: { code: 'PGRST116', message: 'not found' } });
        }
        if (table === 'users') {
          // findUser - not found
          return createChain({ data: null, error: { code: 'PGRST116', message: 'not found' } });
        }
        return createChain({ data: null, error: null });
      }),
    } as any;

    await expect(
      linkAccount(client, 'uuid-1', { provider: 'google', identifier: 'id-1' }),
    ).rejects.toThrow('User not found');
  });
});

describe('unlinkAccount', () => {
  test('throws when only one account remains', async () => {
    const accounts = [{ provider: 'google', identifier: 'id-1', uuid: 'uuid-1' }];
    const client = createMockClient({ accounts: { data: accounts, error: null } });

    await expect(
      unlinkAccount(client, 'uuid-1', { provider: 'google', identifier: 'id-1' }),
    ).rejects.toThrow('Cannot unlink the last account');
  });

  test('throws when account not found for user', async () => {
    const accounts = [
      { provider: 'google', identifier: 'id-1', uuid: 'uuid-1' },
      { provider: 'github', identifier: 'id-2', uuid: 'uuid-1' },
    ];
    const client = createMockClient({ accounts: { data: accounts, error: null } });

    await expect(
      unlinkAccount(client, 'uuid-1', { provider: 'discord', identifier: 'id-3' }),
    ).rejects.toThrow('Account not found');
  });

  test('deletes account when multiple accounts exist', async () => {
    const accounts = [
      { provider: 'google', identifier: 'id-1', uuid: 'uuid-1' },
      { provider: 'github', identifier: 'id-2', uuid: 'uuid-1' },
    ];
    const callCount = { accounts: 0 };
    const client = {
      from: vi.fn((table: string) => {
        const createChain = (resolveValue: unknown): Record<string, Function> => {
          const self: Record<string, Function> = {};
          for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'range', 'order']) {
            self[m] = vi.fn().mockReturnValue(self);
          }
          (self as any).then = (resolve: Function) => resolve(resolveValue);
          self.single = vi.fn().mockImplementation(() => Promise.resolve(resolveValue));
          return self;
        };

        callCount.accounts++;
        if (callCount.accounts === 1) {
          // getAccountsByUser
          return createChain({ data: accounts, error: null });
        }
        // delete
        return createChain({ data: [accounts[0]], error: null });
      }),
    } as any;

    const result = await unlinkAccount(client, 'uuid-1', { provider: 'google', identifier: 'id-1' });
    expect(result).toBe(true);
  });
});

describe('deleteUser', () => {
  test('returns true on successful deletion', async () => {
    const client = createMockClient({ users: { data: [{ uuid: 'uuid-1' }], error: null } });

    const result = await deleteUser(client, 'uuid-1');
    expect(result).toBe(true);
  });

  test('throws when user not found (0 rows)', async () => {
    const client = createMockClient({ users: { data: [], error: null } });

    await expect(deleteUser(client, 'uuid-1')).rejects.toThrow('User not found');
  });

  test('throws on database error', async () => {
    const client = createMockClient({
      users: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(deleteUser(client, 'uuid-1')).rejects.toThrow('Failed to delete user');
  });
});
