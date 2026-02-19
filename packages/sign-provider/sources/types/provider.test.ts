import {
  generateState,
  generateNonce,
  generateCodeVerifier,
  generateCodeChallenge,
} from './provider.ts';

describe('generateState', () => {
  test('generates string of default length 32', () => {
    const state = generateState();
    expect(state).toHaveLength(32);
  });

  test('generates string of custom length', () => {
    const state = generateState(16);
    expect(state).toHaveLength(16);
  });

  test('generates unique values', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });

  test('uses only alphanumeric characters', () => {
    const state = generateState(100);
    expect(state).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe('generateNonce', () => {
  test('generates string of default length 32', () => {
    const nonce = generateNonce();
    expect(nonce).toHaveLength(32);
  });

  test('generates unique values', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });
});

describe('generateCodeVerifier', () => {
  test('generates string of default length 64', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(64);
  });

  test('uses only unreserved characters (A-Z, a-z, 0-9, -, ., _, ~)', () => {
    const verifier = generateCodeVerifier(200);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe('generateCodeChallenge', () => {
  test('generates base64url-encoded string', async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);

    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
    expect(challenge).not.toContain('=');
  });

  test('produces deterministic output for same input', async () => {
    const verifier = 'test-verifier-string';
    const a = await generateCodeChallenge(verifier);
    const b = await generateCodeChallenge(verifier);
    expect(a).toBe(b);
  });
});
