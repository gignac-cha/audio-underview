/**
 * Media tokens: the short-lived, newscast-scoped credential an `<audio src>` may
 * carry in its query string.
 *
 * A browser `<audio src>` cannot send an `Authorization` header, so the owner's
 * audio route also reads `?token=` — but ONLY a media token minted by
 * `POST /newscasts/:id/media-token` and bound to THAT newscast. The session
 * credential is never accepted there: it authorizes every route of every worker,
 * and a URL leaks into browser history, `Referer` and invocation logs in a way a
 * header does not.
 *
 * The token is signed with a key DERIVED from `JWT_SECRET`
 * (HMAC-SHA256(JWT_SECRET, "newscast-media-token")), not with `JWT_SECRET` itself,
 * so it can never pass as a session JWT in another worker that verifies sessions
 * with that secret. `authentication.ts` additionally refuses any session token that
 * carries a `jid` claim.
 */

import { signJWT, verifyJWT } from '@audio-underview/worker-tools';

/**
 * Lifetime of a media token. It rides in a URL, where referrers and access logs
 * can copy it, so it stays short — but it must outlive one whole part of a
 * newscast: the web page holds a part's `<audio src>` (token included) for as
 * long as that part plays, because a changed src makes the browser restart the
 * track from 0:00. One hour covers a three-part newscast several times over; the
 * page refreshes the token at half-life, so a URL built at any moment carries at
 * least 30 minutes of validity.
 */
export const MEDIA_TOKEN_TTL_SECONDS = 3600;

/** The message the media token key is derived with. */
const MEDIA_TOKEN_KEY_LABEL = 'newscast-media-token';

/**
 * The secret media tokens are signed and verified with: HMAC-SHA256 keyed with
 * `JWT_SECRET` over {@link MEDIA_TOKEN_KEY_LABEL}, in hex, because `signJWT` and
 * `verifyJWT` take their secret as a string.
 */
async function deriveMediaTokenSecret(jwtSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(MEDIA_TOKEN_KEY_LABEL));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint a media token for one newscast of one user. `expiresIn` is the token's own
 * lifetime, so the client refreshes on the schedule the token actually has.
 */
export async function issueMediaToken(
  userUUID: string,
  newscastID: string,
  jwtSecret: string,
): Promise<{ token: string; expiresIn: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signJWT(
    { sub: userUUID, jid: newscastID, iat: issuedAt, exp: issuedAt + MEDIA_TOKEN_TTL_SECONDS },
    await deriveMediaTokenSecret(jwtSecret),
  );
  return { token, expiresIn: MEDIA_TOKEN_TTL_SECONDS };
}

/**
 * Verify a media token, returning the user AND the newscast it was scoped to.
 * `null` whenever it is not a live media token — including a valid SESSION JWT,
 * which is signed with another key and must never be usable from a URL.
 * The caller checks that the subject is a UUID, as it does for a session.
 */
export async function verifyMediaToken(
  token: string,
  jwtSecret: string,
): Promise<{ userUUID: string; newscastID: string } | null> {
  const payload = await verifyJWT(token, await deriveMediaTokenSecret(jwtSecret));
  if (payload === null) {
    return null;
  }
  const newscastID = typeof payload.jid === 'string' ? payload.jid : '';
  if (newscastID.length === 0) {
    return null;
  }
  return { userUUID: payload.sub, newscastID };
}
