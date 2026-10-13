import { verifyJWT } from '@audio-underview/worker-tools';
import type { Environment } from './environment.ts';
import { isUUID } from './identifiers.ts';

/**
 * Verifies the Bearer token of a request.
 *
 * @returns the UUID of the user, or null when the request is not authenticated or the subject is not a UUID
 */
export async function authenticate(request: Request, environment: Environment): Promise<string | null> {
  const authorizationHeader = request.headers.get('Authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }
  const payload = await verifyJWT(authorizationHeader.slice('Bearer '.length), environment.JWT_SECRET);
  if (!payload || typeof payload.sub !== 'string' || !isUUID(payload.sub)) {
    return null;
  }
  return payload.sub;
}
