import {
  PROVIDER_KEY_MAXIMUM_LENGTH,
  PROVIDER_KEY_MINIMUM_LENGTH,
  PROVIDER_NAMES,
  providerKeyAuditListSchema,
  providerKeyStatusListSchema,
  providerKeyStatusSchema,
  validateProviderKey,
} from './provider-keys.ts';

const FORMAT_ERROR = 'A key must be 16 to 512 printable characters without spaces.';

describe('validateProviderKey', () => {
  test.each([
    ['16 characters', 'a'.repeat(16)],
    ['512 characters', 'a'.repeat(512)],
    ['the first and the last printable characters', `!${'a'.repeat(14)}~`],
    ['the punctuation of real keys', 'sk-ant-api03_AbC.dEf/123+456='],
  ])('accepts %s', (_, key) => {
    expect(validateProviderKey(key)).toBeUndefined();
  });

  test.each([
    ['an empty key', ''],
    ['15 characters', 'a'.repeat(15)],
    ['513 characters', 'a'.repeat(513)],
    ['a space', 'sk-ant-api03 abcdefghij'],
    ['a tab', 'sk-ant-api03\tabcdefghij'],
    ['a line break', 'sk-ant-api03\nabcdefghij'],
    ['a character outside ASCII', 'sk-ant-api03-abcdéfghij'],
    ['a control character', 'sk-ant-api03-abc\u007fdefghij'],
  ])('rejects %s', (_, key) => {
    expect(validateProviderKey(key)).toBe(FORMAT_ERROR);
  });

  test('uses the limits of the crawler manager', () => {
    expect(PROVIDER_KEY_MINIMUM_LENGTH).toBe(16);
    expect(PROVIDER_KEY_MAXIMUM_LENGTH).toBe(512);
  });
});

describe('providerKeyStatusListSchema', () => {
  test('lists the four providers in the order of the vault', () => {
    expect(PROVIDER_NAMES).toEqual(['anthropic', 'openai', 'google', 'xai']);
  });

  test('accepts a configured key and a key that is not set', () => {
    const result = providerKeyStatusListSchema.safeParse({
      data: [
        { provider: 'anthropic', configured: true, last4: 'abcd', validated_at: '2026-10-26T00:00:00.000Z' },
        { provider: 'openai', configured: false, last4: null, validated_at: null },
      ],
    });

    expect(result.success).toBe(true);
  });

  test('rejects a provider that is not one of the four', () => {
    const result = providerKeyStatusListSchema.safeParse({
      data: [{ provider: 'mistral', configured: false, last4: null, validated_at: null }],
    });

    expect(result.success).toBe(false);
  });

  test('rejects a body without the data list or with a missing field', () => {
    expect(providerKeyStatusListSchema.safeParse({}).success).toBe(false);
    expect(providerKeyStatusListSchema.safeParse({ keys: [] }).success).toBe(false);
    expect(providerKeyStatusListSchema.safeParse({ data: [{ provider: 'google', configured: true }] }).success).toBe(false);
  });

  test('reads the 200 answer of a PUT', () => {
    const result = providerKeyStatusSchema.safeParse({
      provider: 'google',
      configured: true,
      last4: 'wxyz',
      validated_at: '2026-10-26T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
  });
});

describe('providerKeyAuditListSchema', () => {
  test('accepts the four actions', () => {
    const result = providerKeyAuditListSchema.safeParse({
      data: [
        { provider: 'google', action: 'used', at: '2026-10-26T03:00:00.000Z' },
        { provider: 'google', action: 'replaced', at: '2026-10-26T02:00:00.000Z' },
        { provider: 'openai', action: 'removed', at: '2026-10-26T01:00:00.000Z' },
        { provider: 'openai', action: 'registered', at: '2026-10-26T00:00:00.000Z' },
      ],
    });

    expect(result.success).toBe(true);
  });

  test('accepts an empty history', () => {
    expect(providerKeyAuditListSchema.safeParse({ data: [] }).success).toBe(true);
  });

  test('rejects an action that is not one of the four', () => {
    const result = providerKeyAuditListSchema.safeParse({
      data: [{ provider: 'google', action: 'viewed', at: '2026-10-26T00:00:00.000Z' }],
    });

    expect(result.success).toBe(false);
  });

  test('rejects a body of another shape', () => {
    expect(providerKeyAuditListSchema.safeParse({ events: [] }).success).toBe(false);
  });
});
