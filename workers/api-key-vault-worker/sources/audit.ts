import { redactAndTruncate, type Logger } from '@audio-underview/logger';
import type { ProviderName } from './providers.ts';
import type { UserVaultStorage } from './storage.ts';

export const AUDIT_ACTIONS = ['registered', 'replaced', 'removed', 'used'] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export interface AuditFingerprint {
  ip: string | null;
  userAgent: string | null;
}

export interface HashedAuditFingerprint {
  ipHash: string | null;
  userAgentHash: string | null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Takes only `ip` and `userAgent` from the request body; anything empty or
 * not a string is dropped.
 */
export function extractAuditFingerprint(body: Record<string, unknown>): AuditFingerprint {
  return {
    ip: readNonEmptyString(body.ip),
    userAgent: readNonEmptyString(body.userAgent),
  };
}

/**
 * Hex SHA-256 of `<salt>\n<value>`.
 */
export async function hashAuditValue(salt: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\n${value}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashAuditFingerprint(
  salt: string,
  fingerprint: AuditFingerprint,
): Promise<HashedAuditFingerprint> {
  return {
    ipHash: fingerprint.ip === null ? null : await hashAuditValue(salt, fingerprint.ip),
    userAgentHash: fingerprint.userAgent === null ? null : await hashAuditValue(salt, fingerprint.userAgent),
  };
}

export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactAndTruncate(text);
}

/**
 * Appends one audit event. A failure is logged and swallowed so the key
 * operation that triggered it still completes.
 */
export async function recordAuditEvent(options: {
  storage: UserVaultStorage;
  logger: Logger;
  salt: string;
  provider: ProviderName;
  action: AuditAction;
  fingerprint: AuditFingerprint;
  at?: string;
}): Promise<void> {
  try {
    const hashedFingerprint = await hashAuditFingerprint(options.salt, options.fingerprint);
    await options.storage.appendAuditEvent({
      provider: options.provider,
      action: options.action,
      at: options.at ?? new Date().toISOString(),
      ipHash: hashedFingerprint.ipHash,
      userAgentHash: hashedFingerprint.userAgentHash,
    });
  } catch (error) {
    options.logger.error('Audit event write failed', undefined, {
      function: 'recordAuditEvent',
      metadata: { provider: options.provider, action: options.action, reason: describeError(error) },
    });
  }
}
