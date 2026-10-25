import { describe, expect, it } from 'vitest';
import { signJWT, verifyJWT } from '@audio-underview/worker-tools';
import { authenticateRequest } from '../sources/authentication.ts';
import { MEDIA_TOKEN_TTL_SECONDS, issueMediaToken, verifyMediaToken } from '../sources/media-token.ts';

const JWT_SECRET = 'fake-jwt-secret-for-authentication-tests';
const USER = '11111111-1111-4111-8111-111111111111';
const NEWSCAST = '22222222-2222-4222-8222-222222222222';

async function signed(claims: Record<string, unknown>, secret = JWT_SECRET): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJWT({ sub: USER, iat: now, exp: now + 3600, ...claims } as Parameters<typeof signJWT>[0], secret);
}

function bearerRequest(token: string | null, query = ''): Request {
  return new Request(`https://newscast-worker.example.com/newscasts/${NEWSCAST}/audio${query}`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
}

/** HMAC-SHA256(JWT_SECRET, "newscast-media-token") in hex, computed here on its own */
async function expectedMediaTokenSecret(): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode('newscast-media-token'));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('authenticateRequest — the session', () => {
  it('accepts a main session JWT and answers its subject', async () => {
    expect(await authenticateRequest(bearerRequest(await signed({})), JWT_SECRET)).toEqual({ userUUID: USER });
  });

  it('answers null without an Authorization header, or with one that is not Bearer', async () => {
    expect(await authenticateRequest(bearerRequest(null), JWT_SECRET)).toBeNull();
    const basic = new Request('https://newscast-worker.example.com/newscasts', { headers: { Authorization: 'Basic abc' } });
    expect(await authenticateRequest(basic, JWT_SECRET)).toBeNull();
  });

  it('refuses a JWT signed with another secret, an expired one, and one whose subject is not a UUID', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await authenticateRequest(bearerRequest(await signed({}, 'another-fake-secret')), JWT_SECRET)).toBeNull();
    expect(await authenticateRequest(bearerRequest(await signed({ iat: now - 7200, exp: now - 3600 })), JWT_SECRET)).toBeNull();
    expect(await authenticateRequest(bearerRequest(await signed({ sub: 'google:1234' })), JWT_SECRET)).toBeNull();
  });

  it('refuses a token that carries a jid claim, even signed with JWT_SECRET', async () => {
    expect(await authenticateRequest(bearerRequest(await signed({ jid: NEWSCAST })), JWT_SECRET)).toBeNull();
  });

  it('refuses a media token presented as a bearer', async () => {
    const { token } = await issueMediaToken(USER, NEWSCAST, JWT_SECRET);
    expect(await authenticateRequest(bearerRequest(token), JWT_SECRET, { allowQueryToken: true })).toBeNull();
  });
});

describe('authenticateRequest — ?token=', () => {
  it('accepts a media token from the query only where the route allows it', async () => {
    const { token } = await issueMediaToken(USER, NEWSCAST, JWT_SECRET);
    const request = bearerRequest(null, `?token=${encodeURIComponent(token)}`);

    expect(await authenticateRequest(request, JWT_SECRET, { allowQueryToken: true })).toEqual({
      userUUID: USER,
      mediaNewscastID: NEWSCAST,
    });
    expect(await authenticateRequest(request, JWT_SECRET)).toBeNull();
  });

  it('refuses a session JWT in the query', async () => {
    const request = bearerRequest(null, `?token=${encodeURIComponent(await signed({}))}`);
    expect(await authenticateRequest(request, JWT_SECRET, { allowQueryToken: true })).toBeNull();
  });

  it('reads the header, not the query, when both are present', async () => {
    const { token } = await issueMediaToken(USER, NEWSCAST, JWT_SECRET);
    const request = bearerRequest(await signed({}), `?token=${encodeURIComponent(token)}`);
    expect(await authenticateRequest(request, JWT_SECRET, { allowQueryToken: true })).toEqual({ userUUID: USER });
  });
});

describe('media tokens', () => {
  it('carries { sub, jid, iat, exp = iat + 3600 } and reports its lifetime', async () => {
    const { token, expiresIn } = await issueMediaToken(USER, NEWSCAST, JWT_SECRET);
    const payload = await verifyJWT(token, await expectedMediaTokenSecret());

    expect(expiresIn).toBe(MEDIA_TOKEN_TTL_SECONDS);
    expect(MEDIA_TOKEN_TTL_SECONDS).toBe(3600);
    expect(payload).not.toBeNull();
    expect(Object.keys(payload ?? {}).sort()).toEqual(['exp', 'iat', 'jid', 'sub']);
    expect(payload?.sub).toBe(USER);
    expect(payload?.jid).toBe(NEWSCAST);
    expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(3600);
  });

  it('is signed with the derived key, so JWT_SECRET does not verify it', async () => {
    const { token } = await issueMediaToken(USER, NEWSCAST, JWT_SECRET);
    expect(await verifyJWT(token, JWT_SECRET)).toBeNull();
  });

  it('verifies only with the JWT_SECRET it was derived from, and only with a jid', async () => {
    const { token } = await issueMediaToken(USER, NEWSCAST, JWT_SECRET);
    expect(await verifyMediaToken(token, JWT_SECRET)).toEqual({ userUUID: USER, newscastID: NEWSCAST });
    expect(await verifyMediaToken(token, 'another-fake-secret')).toBeNull();

    const withoutJID = await signed({}, await expectedMediaTokenSecret());
    expect(await verifyMediaToken(withoutJID, JWT_SECRET)).toBeNull();
  });
});
