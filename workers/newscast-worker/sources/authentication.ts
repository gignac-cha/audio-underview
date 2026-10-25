/**
 * Request authentication for the newscast routes, the way crawler-manager-worker
 * authenticates: the main session JWT (`JWT_SECRET`, HS256) in a Bearer header,
 * whose `sub` is the user's UUID. That UUID is the ONLY accepted source of
 * newscast ownership; nothing in a body or a query names the owner.
 *
 * Two carve-outs, both narrow:
 * - A token that carries a `jid` claim is a media token, never a session, even
 *   when it is signed with `JWT_SECRET`: it may only stream the one newscast it
 *   names, so presenting it as a bearer authorizes nothing.
 * - The owner's audio route alone (`allowQueryToken`) may take its credential from
 *   `?token=`, and what is accepted there is ONLY a media token (see
 *   `media-token.ts`). The route then compares
 *   {@link AuthenticatedUser.mediaNewscastID} with the newscast in its path.
 */

import { verifyJWT } from '@audio-underview/worker-tools';
import { verifyMediaToken } from './media-token.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** A verified caller. */
export interface AuthenticatedUser {
  userUUID: string;
  /**
   * The newscast this credential is scoped to, set ONLY for a media token. A route
   * that accepts media tokens MUST compare it against the newscast in its own
   * path; a session leaves it undefined.
   */
  mediaNewscastID?: string;
}

/** The Bearer credential of a request, or `null` when there is none. */
export function extractBearerToken(request: Request): string | null {
  const authorizationHeader = request.headers.get('Authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }
  return authorizationHeader.slice('Bearer '.length);
}

/** The raw `?token=` value, or `null`. Only ever a MEDIA token — see above. */
export function extractQueryToken(request: Request): string | null {
  const queryToken = new URL(request.url).searchParams.get('token');
  return queryToken !== null && queryToken.length > 0 ? queryToken : null;
}

/**
 * Resolve the caller, or `null` when the request carries no usable credential.
 * `null` is the ONLY failure mode: no reason is reported back to the caller, so a
 * bad token cannot be probed for why it was rejected.
 *
 * The Authorization header wins when both are present: a session is never read
 * from the query string, and a media token is never read from the header.
 */
export async function authenticateRequest(
  request: Request,
  jwtSecret: string,
  options: { allowQueryToken?: boolean } = {},
): Promise<AuthenticatedUser | null> {
  const headerToken = extractBearerToken(request);

  if (headerToken === null) {
    if (options.allowQueryToken !== true) {
      return null;
    }
    const queryToken = extractQueryToken(request);
    if (queryToken === null) {
      return null;
    }
    const media = await verifyMediaToken(queryToken, jwtSecret);
    if (media === null || !isUUID(media.userUUID)) {
      return null;
    }
    return { userUUID: media.userUUID, mediaNewscastID: media.newscastID };
  }

  const payload = await verifyJWT(headerToken, jwtSecret);
  // A token with `jid` is a media token whatever key signed it. It may only stream
  // the newscast it names, so it must not pass as a session on any route.
  if (!payload || payload.jid !== undefined || typeof payload.sub !== 'string' || !isUUID(payload.sub)) {
    return null;
  }
  return { userUUID: payload.sub };
}
