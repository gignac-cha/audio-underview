import { describe, expect, it } from 'vitest';
import { isUUID, signJWT, verifyJWT } from '../sources/jwt.ts';

const SECRET = 'test-secret';
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const createPayload = (overrides: Record<string, unknown> = {}) => ({
  sub: '00000000-0000-4000-8000-000000000001',
  iat: nowSeconds(),
  exp: nowSeconds() + 3600,
  ...overrides,
});

describe('signJWT / verifyJWT', () => {
  it('round-trips a payload with custom claims', async () => {
    const token = await signJWT(createPayload({ role: 'tester' }), SECRET);
    const verified = await verifyJWT(token, SECRET);
    expect(verified?.sub).toBe('00000000-0000-4000-8000-000000000001');
    expect(verified?.role).toBe('tester');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signJWT(createPayload(), 'another-secret');
    expect(await verifyJWT(token, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signJWT(createPayload({ exp: nowSeconds() - 10 }), SECRET);
    expect(await verifyJWT(token, SECRET)).toBeNull();
  });

  it('rejects a malformed token', async () => {
    expect(await verifyJWT('not-a-jwt', SECRET)).toBeNull();
    expect(await verifyJWT('a.b', SECRET)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signJWT(createPayload(), SECRET);
    const [headerPart, payloadPart, signaturePart] = token.split('.') as [string, string, string];
    const decoded = JSON.parse(atob(payloadPart.replaceAll('-', '+').replaceAll('_', '/'))) as {
      sub: string;
    };
    decoded.sub = '00000000-0000-4000-8000-00000000dead';
    const tampered = btoa(JSON.stringify(decoded))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    expect(await verifyJWT(`${headerPart}.${tampered}.${signaturePart}`, SECRET)).toBeNull();
  });

  it('rejects a payload without a string sub', async () => {
    const token = await signJWT(createPayload({ sub: 123 } as never), SECRET);
    expect(await verifyJWT(token, SECRET)).toBeNull();
  });

  it('enforces issuer and audience when requested', async () => {
    const token = await signJWT(
      createPayload({ iss: 'audio-underview-authentication', aud: 'audio-underview-api' }),
      SECRET,
    );
    expect(
      await verifyJWT(token, SECRET, {
        issuer: 'audio-underview-authentication',
        audience: 'audio-underview-api',
      }),
    ).not.toBeNull();
    expect(await verifyJWT(token, SECRET, { issuer: 'someone-else' })).toBeNull();
    expect(await verifyJWT(token, SECRET, { audience: 'other-api' })).toBeNull();
  });
});

describe('isUUID', () => {
  it('accepts canonical UUIDs (대소문자 무관)', () => {
    expect(isUUID('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUUID('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(isUUID('not-a-uuid')).toBe(false);
    expect(isUUID('00000000-0000-4000-8000-0000000000')).toBe(false);
  });
});
