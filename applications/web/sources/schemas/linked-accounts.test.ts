import { describe, test, expect } from 'vitest';
import { linkedAccountsResponseSchema } from './linked-accounts.ts';

describe('linkedAccountsResponseSchema', () => {
  test('accepts ISO 8601 link dates and a null link date', () => {
    const result = linkedAccountsResponseSchema.safeParse({
      accounts: [
        { provider: 'github', linkedAt: '2026-01-01T00:00:00.000Z' },
        { provider: 'google', linkedAt: '2026-08-01T09:00:00+09:00' },
        { provider: 'kakao', linkedAt: null },
      ],
    });

    expect(result.success).toBe(true);
  });

  test('accepts an empty list', () => {
    expect(linkedAccountsResponseSchema.safeParse({ accounts: [] }).success).toBe(true);
  });

  test('rejects a provider that is not an OAuth provider ID', () => {
    const result = linkedAccountsResponseSchema.safeParse({
      accounts: [{ provider: 'myspace', linkedAt: null }],
    });

    expect(result.success).toBe(false);
  });

  test('rejects a link date that is not ISO 8601', () => {
    const result = linkedAccountsResponseSchema.safeParse({
      accounts: [{ provider: 'github', linkedAt: 'not-a-date' }],
    });

    expect(result.success).toBe(false);
  });

  test('rejects a body without the accounts list', () => {
    expect(linkedAccountsResponseSchema.safeParse({}).success).toBe(false);
    expect(linkedAccountsResponseSchema.safeParse({ accounts: [{ provider: 'github' }] }).success).toBe(false);
  });
});
