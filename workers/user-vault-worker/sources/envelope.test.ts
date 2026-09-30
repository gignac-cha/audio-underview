import { describe, expect, it } from 'vitest';
import {
  createAdditionalAuthenticatedData,
  decodeBase64,
  encodeBase64,
  extractLast4,
  openProviderKey,
  rewrapDataEncryptionKey,
  sealProviderKey,
  type EnvelopeBinding,
  type StoredEnvelope,
} from './envelope.ts';

const PLAINTEXT_KEY = 'sk-ant-api03-plaintext-provider-key-0123456789';
const CURRENT_SECRET = 'current-key-encryption-secret';
const PREVIOUS_SECRET = 'previous-key-encryption-secret';

const BINDING: EnvelopeBinding = {
  userID: 'user-1',
  provider: 'anthropic',
  keyVersion: 1,
  createdAt: '2026-09-29T00:00:00.000Z',
};

const textDecoder = new TextDecoder();

async function seal(
  binding: EnvelopeBinding = BINDING,
  secrets: string[] = [CURRENT_SECRET],
  plaintextKey: string = PLAINTEXT_KEY,
): Promise<StoredEnvelope> {
  const sealed = await sealProviderKey({ plaintextKey, binding, keyEncryptionKeySecrets: secrets });
  return {
    provider: binding.provider,
    ciphertext: sealed.ciphertext,
    initializationVector: sealed.initializationVector,
    wrappedDataEncryptionKey: sealed.wrappedDataEncryptionKey,
    dataEncryptionKeyInitializationVector: sealed.dataEncryptionKeyInitializationVector,
    keyVersion: sealed.keyVersion,
    createdAt: sealed.createdAt,
  };
}

function open(envelope: StoredEnvelope, userID: string = BINDING.userID, secrets: string[] = [CURRENT_SECRET]) {
  return openProviderKey({ userID, envelope, keyEncryptionKeySecrets: secrets });
}

describe('createAdditionalAuthenticatedData', () => {
  it('joins <byte length>:<value> for userID, provider, keyVersion and createdAt with |', () => {
    const data = createAdditionalAuthenticatedData({ userID: 'x', provider: 'google', keyVersion: 1, createdAt: 'T' });
    expect(textDecoder.decode(data)).toBe('1:x|6:google|1:1|1:T');
  });

  it('counts multibyte characters by their UTF-8 bytes', () => {
    const data = createAdditionalAuthenticatedData({
      userID: '사용자',
      provider: 'openai',
      keyVersion: 12,
      createdAt: 'é',
    });
    expect(textDecoder.decode(data)).toBe('9:사용자|6:openai|2:12|2:é');
  });

  it('keeps separator tricks apart', () => {
    const first = createAdditionalAuthenticatedData({
      userID: 'x|google|1|T',
      provider: 'google',
      keyVersion: 1,
      createdAt: 'T',
    });
    const second = createAdditionalAuthenticatedData({
      userID: 'x',
      provider: 'google',
      keyVersion: 1,
      createdAt: 'T|google|1|T',
    });
    expect(textDecoder.decode(first)).not.toBe(textDecoder.decode(second));
  });
});

describe('sealProviderKey and openProviderKey', () => {
  it('round-trips the original key', async () => {
    const envelope = await seal();
    await expect(open(envelope)).resolves.toBe(PLAINTEXT_KEY);
  });

  it('keeps the plaintext key out of every stored field', async () => {
    const sealed = await sealProviderKey({
      plaintextKey: PLAINTEXT_KEY,
      binding: BINDING,
      keyEncryptionKeySecrets: [CURRENT_SECRET],
    });
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(PLAINTEXT_KEY);
    expect(serialized).not.toContain(encodeBase64(new TextEncoder().encode(PLAINTEXT_KEY)));
    for (const field of [
      sealed.ciphertext,
      sealed.initializationVector,
      sealed.wrappedDataEncryptionKey,
      sealed.dataEncryptionKeyInitializationVector,
    ]) {
      expect(textDecoder.decode(decodeBase64(field))).not.toContain(PLAINTEXT_KEY);
    }
  });

  it('does not open a row with the wrapped data encryption key of another envelope', async () => {
    const first = await seal();
    const second = await seal();
    const swapped: StoredEnvelope = {
      ...first,
      wrappedDataEncryptionKey: second.wrappedDataEncryptionKey,
      dataEncryptionKeyInitializationVector: second.dataEncryptionKeyInitializationVector,
    };
    await expect(open(swapped)).resolves.toBeNull();
  });

  it('uses a new IV every time, and different IVs for the key and the wrapped data encryption key', async () => {
    const first = await seal();
    const second = await seal();
    expect(first.initializationVector).not.toBe(second.initializationVector);
    expect(first.dataEncryptionKeyInitializationVector).not.toBe(second.dataEncryptionKeyInitializationVector);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.initializationVector).not.toBe(first.dataEncryptionKeyInitializationVector);
    expect(decodeBase64(first.initializationVector)).toHaveLength(12);
    expect(decodeBase64(first.dataEncryptionKeyInitializationVector)).toHaveLength(12);
  });

  it('returns null for a row moved to another user', async () => {
    const envelope = await seal();
    await expect(open(envelope, 'user-2')).resolves.toBeNull();
  });

  it('returns null for a row whose provider was changed', async () => {
    const envelope = await seal();
    await expect(open({ ...envelope, provider: 'openai' })).resolves.toBeNull();
  });

  it('returns null for a row moved by shifting the separator boundary', async () => {
    const envelope = await seal({ userID: 'x|google|1|T', provider: 'google', keyVersion: 1, createdAt: 'T' });
    await expect(open(envelope, 'x|google|1|T')).resolves.toBe(PLAINTEXT_KEY);
    await expect(open({ ...envelope, createdAt: 'T|google|1|T' }, 'x')).resolves.toBeNull();
  });

  it('returns null for a row whose key_version was edited', async () => {
    const envelope = await seal();
    await expect(open({ ...envelope, keyVersion: 2 })).resolves.toBeNull();
  });

  it('returns null for a row whose created_at was edited', async () => {
    const envelope = await seal();
    await expect(open({ ...envelope, createdAt: '2026-09-30T00:00:00.000Z' })).resolves.toBeNull();
  });

  it('opens an old row while the previous key encryption key is in the list', async () => {
    const envelope = await seal(BINDING, [PREVIOUS_SECRET]);
    await expect(open(envelope, BINDING.userID, [CURRENT_SECRET, PREVIOUS_SECRET])).resolves.toBe(PLAINTEXT_KEY);
    await expect(open(envelope, BINDING.userID, [CURRENT_SECRET])).resolves.toBeNull();
  });

  it('returns null for a row no key encryption key opens', async () => {
    const envelope = await seal(BINDING, ['unknown-secret']);
    await expect(open(envelope, BINDING.userID, [CURRENT_SECRET, PREVIOUS_SECRET])).resolves.toBeNull();
  });

  it('returns null for broken base64', async () => {
    const envelope = await seal();
    await expect(open({ ...envelope, ciphertext: '%%% not base64 %%%' })).resolves.toBeNull();
    await expect(open({ ...envelope, initializationVector: '***' })).resolves.toBeNull();
    await expect(open({ ...envelope, wrappedDataEncryptionKey: '!!!' })).resolves.toBeNull();
    await expect(open({ ...envelope, dataEncryptionKeyInitializationVector: '###' })).resolves.toBeNull();
  });

  it('takes the last four characters of the plaintext key as last4', async () => {
    const sealed = await sealProviderKey({
      plaintextKey: PLAINTEXT_KEY,
      binding: BINDING,
      keyEncryptionKeySecrets: [CURRENT_SECRET],
    });
    expect(sealed.last4).toBe('6789');
    expect(sealed.last4).toHaveLength(4);
    expect(extractLast4('xai-abcdef1234567890ABCDEF')).toBe('CDEF');
  });

  it('carries keyVersion and createdAt from the binding', async () => {
    const sealed = await sealProviderKey({
      plaintextKey: PLAINTEXT_KEY,
      binding: { ...BINDING, keyVersion: 3 },
      keyEncryptionKeySecrets: [CURRENT_SECRET],
    });
    expect(sealed.keyVersion).toBe(3);
    expect(sealed.createdAt).toBe(BINDING.createdAt);
  });
});

describe('rewrapDataEncryptionKey', () => {
  it('re-wraps with the current key encryption key so only the new one is needed afterwards', async () => {
    const envelope = await seal(BINDING, [PREVIOUS_SECRET]);
    const replacement = await rewrapDataEncryptionKey({
      userID: BINDING.userID,
      envelope,
      keyEncryptionKeySecrets: [CURRENT_SECRET, PREVIOUS_SECRET],
    });
    expect(replacement).not.toBeNull();
    const rewrapped: StoredEnvelope = { ...envelope, ...replacement };

    expect(rewrapped.ciphertext).toBe(envelope.ciphertext);
    expect(rewrapped.initializationVector).toBe(envelope.initializationVector);
    expect(rewrapped.keyVersion).toBe(envelope.keyVersion);
    expect(rewrapped.createdAt).toBe(envelope.createdAt);
    expect(rewrapped.wrappedDataEncryptionKey).not.toBe(envelope.wrappedDataEncryptionKey);
    expect(rewrapped.dataEncryptionKeyInitializationVector).not.toBe(envelope.dataEncryptionKeyInitializationVector);

    await expect(open(rewrapped, BINDING.userID, [CURRENT_SECRET])).resolves.toBe(PLAINTEXT_KEY);
    await expect(open(rewrapped, BINDING.userID, [PREVIOUS_SECRET])).resolves.toBeNull();
  });

  it('returns null for a row it cannot open', async () => {
    const envelope = await seal(BINDING, ['unknown-secret']);
    await expect(
      rewrapDataEncryptionKey({ userID: BINDING.userID, envelope, keyEncryptionKeySecrets: [CURRENT_SECRET] }),
    ).resolves.toBeNull();
  });

  it('does not rewrap a row moved to another user', async () => {
    const envelope = await seal();
    await expect(
      rewrapDataEncryptionKey({ userID: 'user-2', envelope, keyEncryptionKeySecrets: [CURRENT_SECRET] }),
    ).resolves.toBeNull();
  });

  it('returns null for broken base64', async () => {
    const envelope = await seal();
    await expect(
      rewrapDataEncryptionKey({
        userID: BINDING.userID,
        envelope: { ...envelope, wrappedDataEncryptionKey: '@@@' },
        keyEncryptionKeySecrets: [CURRENT_SECRET],
      }),
    ).resolves.toBeNull();
  });
});
