import type { Logger } from '@audio-underview/logger';
import type { Environment } from './environment.ts';
import type { UserVaultStorage } from './storage.ts';

export type RequestBody = Record<string, unknown>;

export interface RouteContext {
  environment: Environment;
  body: RequestBody;
  userID: string;
  storage: UserVaultStorage;
  /** Current first; empty when no key encryption key is configured. Each route checks it when it needs one. */
  keyEncryptionKeySecrets: string[];
  logger: Logger;
}

export type RouteHandler = (context: RouteContext) => Promise<Response>;

export function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The 503 a route answers when it needs a key encryption key and none is configured.
 *
 * @returns the response to send, or null when a key encryption key is configured
 */
export function requireKeyEncryptionKey(context: RouteContext): Response | null {
  if (context.keyEncryptionKeySecrets.length > 0) {
    return null;
  }
  context.logger.error('Key encryption key is not configured', undefined, { function: 'handleRequest' });
  return jsonResponse(503, { error: 'vault_unavailable' });
}
