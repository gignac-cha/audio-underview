import { describe, expect, it } from 'vitest';
import { decodeJWTPayload, verifyIDToken } from '../sources/id-tokens.ts';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../sources/random.ts';
import { OAuthFlowError } from '../sources/types.ts';

const base64URLEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

describe('random generators', () => {
  it('generates states from the alphanumeric alphabet with the right length', () => {
    const state = generateState();
    expect(state).toHaveLength(32);
    expect(state).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('generates unique values', () => {
    const values = new Set(Array.from({ length: 64 }, () => generateState()));
    expect(values.size).toBe(64);
  });

  it('generates PKCE verifiers from the unreserved alphabet', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('computes the RFC 7636 S256 challenge (known vector)', async () => {
    // RFC 7636 부록 B의 예시 verifier/challenge
    const challenge = await generateCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('ID token verification (JWKS)', () => {
  const createSignedIDToken = async (
    claims: Record<string, unknown>,
  ): Promise<{ idToken: string; jwk: JsonWebKey & { kid: string } }> => {
    const keyPair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const encoder = new TextEncoder();
    const headerPart = base64URLEncode(
      encoder.encode(JSON.stringify({ alg: 'RS256', kid: 'test-key' })),
    );
    const payloadPart = base64URLEncode(encoder.encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keyPair.privateKey,
      encoder.encode(`${headerPart}.${payloadPart}`),
    );
    const jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & {
      kid: string;
    };
    jwk.kid = 'test-key';
    return { idToken: `${headerPart}.${payloadPart}.${base64URLEncode(new Uint8Array(signature))}`, jwk };
  };

  const claims = {
    iss: 'https://accounts.example.com',
    aud: 'client-1',
    sub: 'user-1',
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: 'nonce-1',
  };

  const jwksFetchFor = (jwk: JsonWebKey): typeof fetch =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )) as typeof fetch;

  it('verifies a valid RS256 ID token with nonce', async () => {
    const { idToken, jwk } = await createSignedIDToken(claims);
    const payload = await verifyIDToken(idToken, {
      jwksURL: 'https://accounts.example.com/jwks',
      issuers: ['https://accounts.example.com'],
      audience: 'client-1',
      expectedNonce: 'nonce-1',
      fetchImplementation: jwksFetchFor(jwk),
    });
    expect(payload.sub).toBe('user-1');
  });

  it.each([
    ['issuer mismatch', { issuers: ['https://other.example.com'] }],
    ['audience mismatch', { audience: 'client-2' }],
    ['nonce mismatch', { expectedNonce: 'different-nonce' }],
  ])('rejects on %s', async (_label, overrides) => {
    const { idToken, jwk } = await createSignedIDToken(claims);
    await expect(
      verifyIDToken(idToken, {
        jwksURL: 'https://accounts.example.com/jwks',
        issuers: ['https://accounts.example.com'],
        audience: 'client-1',
        expectedNonce: 'nonce-1',
        fetchImplementation: jwksFetchFor(jwk),
        ...overrides,
      }),
    ).rejects.toThrow(OAuthFlowError);
  });

  it('rejects a token signed by a different key', async () => {
    const { idToken } = await createSignedIDToken(claims);
    const { jwk: otherJWK } = await createSignedIDToken(claims);
    await expect(
      verifyIDToken(idToken, {
        jwksURL: 'https://accounts.example.com/jwks',
        issuers: ['https://accounts.example.com'],
        audience: 'client-1',
        fetchImplementation: jwksFetchFor(otherJWK),
      }),
    ).rejects.toThrow('signature verification failed');
  });

  it('rejects an expired token', async () => {
    const { idToken, jwk } = await createSignedIDToken({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(
      verifyIDToken(idToken, {
        jwksURL: 'https://accounts.example.com/jwks',
        issuers: ['https://accounts.example.com'],
        audience: 'client-1',
        fetchImplementation: jwksFetchFor(jwk),
      }),
    ).rejects.toThrow('expired');
  });

  it('decodes payloads without verification via decodeJWTPayload', async () => {
    const { idToken } = await createSignedIDToken(claims);
    expect(decodeJWTPayload(idToken)?.sub).toBe('user-1');
  });
});
