const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const DATA_ENCRYPTION_KEY_BYTE_LENGTH = 32;
const INITIALIZATION_VECTOR_BYTE_LENGTH = 12;

export interface EnvelopeBinding {
  userID: string;
  provider: string;
  keyVersion: number;
  createdAt: string;
}

export interface EncryptedEnvelope {
  ciphertext: string;
  initializationVector: string;
  wrappedDataEncryptionKey: string;
  dataEncryptionKeyInitializationVector: string;
}

export interface SealedProviderKey extends EncryptedEnvelope {
  keyVersion: number;
  createdAt: string;
  last4: string;
}

export interface StoredEnvelope extends EncryptedEnvelope {
  provider: string;
  keyVersion: number;
  createdAt: string;
}

export interface WrappedDataEncryptionKey {
  wrappedDataEncryptionKey: string;
  dataEncryptionKeyInitializationVector: string;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * Throws when the text is not valid base64.
 */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Each value becomes `<UTF-8 byte length>:<value>`, joined with `|`, so a
 * separator inside one value can never be mistaken for a field boundary.
 */
export function createAdditionalAuthenticatedData(binding: EnvelopeBinding): Uint8Array<ArrayBuffer> {
  const text = [binding.userID, binding.provider, String(binding.keyVersion), binding.createdAt]
    .map((value) => `${textEncoder.encode(value).byteLength}:${value}`)
    .join('|');
  return textEncoder.encode(text);
}

export function extractLast4(key: string): string {
  return key.slice(-4);
}

async function importKeyEncryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function importDataEncryptionKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function createInitializationVector(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(INITIALIZATION_VECTOR_BYTE_LENGTH));
}

async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  additionalAuthenticatedData: Uint8Array<ArrayBuffer>,
): Promise<{ ciphertext: string; initializationVector: string }> {
  const initializationVector = createInitializationVector();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: initializationVector, additionalData: additionalAuthenticatedData },
    key,
    plaintext,
  );
  return {
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    initializationVector: encodeBase64(initializationVector),
  };
}

async function decrypt(
  key: CryptoKey,
  ciphertext: Uint8Array<ArrayBuffer>,
  initializationVector: Uint8Array<ArrayBuffer>,
  additionalAuthenticatedData: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: initializationVector, additionalData: additionalAuthenticatedData },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

/**
 * Tries each key encryption key in order and returns the raw data encryption
 * key, or null when none of them opens the wrapped key.
 */
async function unwrapDataEncryptionKey(
  envelope: StoredEnvelope,
  additionalAuthenticatedData: Uint8Array<ArrayBuffer>,
  keyEncryptionKeySecrets: readonly string[],
): Promise<Uint8Array<ArrayBuffer> | null> {
  let wrappedDataEncryptionKey: Uint8Array<ArrayBuffer>;
  let dataEncryptionKeyInitializationVector: Uint8Array<ArrayBuffer>;
  try {
    wrappedDataEncryptionKey = decodeBase64(envelope.wrappedDataEncryptionKey);
    dataEncryptionKeyInitializationVector = decodeBase64(envelope.dataEncryptionKeyInitializationVector);
  } catch {
    return null;
  }

  for (const secret of keyEncryptionKeySecrets) {
    try {
      const keyEncryptionKey = await importKeyEncryptionKey(secret);
      return await decrypt(
        keyEncryptionKey,
        wrappedDataEncryptionKey,
        dataEncryptionKeyInitializationVector,
        additionalAuthenticatedData,
      );
    } catch {
      // Try the next key encryption key.
    }
  }
  return null;
}

/**
 * Encrypts the provider key with a fresh data encryption key, then wraps that
 * key with the current (first) key encryption key. Both steps share the AAD.
 */
export async function sealProviderKey(options: {
  plaintextKey: string;
  binding: EnvelopeBinding;
  keyEncryptionKeySecrets: readonly string[];
}): Promise<SealedProviderKey> {
  const [currentSecret] = options.keyEncryptionKeySecrets;
  if (currentSecret === undefined) {
    throw new Error('No key encryption key is configured');
  }

  const additionalAuthenticatedData = createAdditionalAuthenticatedData(options.binding);
  const dataEncryptionKeyBytes = crypto.getRandomValues(new Uint8Array(DATA_ENCRYPTION_KEY_BYTE_LENGTH));
  const dataEncryptionKey = await importDataEncryptionKey(dataEncryptionKeyBytes);
  const keyEncryptionKey = await importKeyEncryptionKey(currentSecret);

  const encryptedKey = await encrypt(
    dataEncryptionKey,
    textEncoder.encode(options.plaintextKey),
    additionalAuthenticatedData,
  );
  const wrappedKey = await encrypt(keyEncryptionKey, dataEncryptionKeyBytes, additionalAuthenticatedData);

  return {
    ciphertext: encryptedKey.ciphertext,
    initializationVector: encryptedKey.initializationVector,
    wrappedDataEncryptionKey: wrappedKey.ciphertext,
    dataEncryptionKeyInitializationVector: wrappedKey.initializationVector,
    keyVersion: options.binding.keyVersion,
    createdAt: options.binding.createdAt,
    last4: extractLast4(options.plaintextKey),
  };
}

/**
 * Rebuilds the AAD from the row, unwraps the data encryption key with the
 * first key encryption key that works, then decrypts the provider key.
 * Returns null, never throws, when the row cannot be opened.
 */
export async function openProviderKey(options: {
  userID: string;
  envelope: StoredEnvelope;
  keyEncryptionKeySecrets: readonly string[];
}): Promise<string | null> {
  try {
    const { envelope } = options;
    const additionalAuthenticatedData = createAdditionalAuthenticatedData({
      userID: options.userID,
      provider: envelope.provider,
      keyVersion: envelope.keyVersion,
      createdAt: envelope.createdAt,
    });
    const dataEncryptionKeyBytes = await unwrapDataEncryptionKey(
      envelope,
      additionalAuthenticatedData,
      options.keyEncryptionKeySecrets,
    );
    if (dataEncryptionKeyBytes === null) {
      return null;
    }
    const dataEncryptionKey = await importDataEncryptionKey(dataEncryptionKeyBytes);
    const plaintext = await decrypt(
      dataEncryptionKey,
      decodeBase64(envelope.ciphertext),
      decodeBase64(envelope.initializationVector),
      additionalAuthenticatedData,
    );
    return textDecoder.decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * Re-wraps the data encryption key with the current key encryption key and a
 * new IV. The provider key itself is never decrypted, and the ciphertext, its
 * IV, the key version and the creation time stay as they are.
 */
export async function rewrapDataEncryptionKey(options: {
  userID: string;
  envelope: StoredEnvelope;
  keyEncryptionKeySecrets: readonly string[];
}): Promise<WrappedDataEncryptionKey | null> {
  try {
    const [currentSecret] = options.keyEncryptionKeySecrets;
    if (currentSecret === undefined) {
      return null;
    }
    const { envelope } = options;
    const additionalAuthenticatedData = createAdditionalAuthenticatedData({
      userID: options.userID,
      provider: envelope.provider,
      keyVersion: envelope.keyVersion,
      createdAt: envelope.createdAt,
    });
    const dataEncryptionKeyBytes = await unwrapDataEncryptionKey(
      envelope,
      additionalAuthenticatedData,
      options.keyEncryptionKeySecrets,
    );
    if (dataEncryptionKeyBytes === null) {
      return null;
    }
    const keyEncryptionKey = await importKeyEncryptionKey(currentSecret);
    const wrappedKey = await encrypt(keyEncryptionKey, dataEncryptionKeyBytes, additionalAuthenticatedData);
    return {
      wrappedDataEncryptionKey: wrappedKey.ciphertext,
      dataEncryptionKeyInitializationVector: wrappedKey.initializationVector,
    };
  } catch {
    return null;
  }
}
