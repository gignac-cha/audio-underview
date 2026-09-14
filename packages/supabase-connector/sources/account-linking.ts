import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, ProviderType, SocialLoginInput } from './types/index.ts';
import {
  createAccount,
  getAccountsByUser,
  handleSocialLogin,
  linkAccount,
  unlinkAccount,
} from './accounts.ts';

type SupabaseClientType = SupabaseClient<Database>;

/**
 * The subset of a Cloudflare KV namespace this module needs. Declaring it
 * structurally keeps the connector runtime-agnostic (and unit-testable in plain
 * Node) while still accepting a real `KVNamespace` binding from the workers.
 */
export interface AccountStateStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Linking is deliberately a two-secret handshake (§3 of the account-linking
 * plan), because `/authorize` is a plain cookie-less GET that an attacker can
 * call server side with their own ticket and then hand the resulting provider
 * URL to a victim. If the callback linked straight away, whichever provider
 * account finished that round trip would land on the attacker's account.
 *
 * So the two halves of the flow are kept in different places and only a browser
 * holding both can finish it:
 *
 * - `nonce` — handed to the browser that STARTED the link (in the
 *   `POST /link-tickets` response body, kept in `sessionStorage`, never in a
 *   URL). It is also copied into the ticket so the callback can carry it
 *   forward without ever revealing it.
 * - `link_code` — handed to the browser that COMPLETED the OAuth round trip, in
 *   the callback's redirect URL.
 *
 * `confirmAccountLink` demands both plus the session JWT of the account the
 * ticket was minted for. In the attack the two browsers are different, so
 * neither side holds all three and no link happens.
 */

/** Link tickets are single-use and short-lived (§3 of the account-linking plan). */
export const LINK_TICKET_LIFETIME_SECONDS = 300;

/**
 * A link code only has to survive one redirect back into the application, so it
 * expires far faster than the ticket that produced it.
 */
export const LINK_CODE_LIFETIME_SECONDS = 120;

export function linkTicketStorageKey(ticket: string): string {
  return `link-ticket/${ticket}`;
}

export function linkCodeStorageKey(linkCode: string): string {
  return `link-code/${linkCode}`;
}

export function accountCacheStorageKey(input: SocialLoginInput): string {
  return `account/${input.provider}/${input.identifier}`;
}

export interface LinkTicket {
  /** Opaque value to pass as `link_ticket` on the `/authorize` navigation. */
  ticket: string;
  /** Browser-side secret; must stay out of every URL. */
  nonce: string;
}

export interface LinkTicketBinding {
  userUUID: string;
  nonce: string;
}

/**
 * Mints a single-use link ticket plus the browser secret that will have to come
 * back with the confirmation.
 *
 * The ticket stands in for the session JWT during a top-level browser
 * navigation (a navigation cannot carry an Authorization header, and putting
 * the JWT in the URL would leak it into logs and history). The ticket alone
 * proves nothing about *which* browser completes the flow, which is what the
 * nonce is for.
 *
 * @param storage - OAuth state KV namespace
 * @param userUUID - Account UUID taken from the verified session `sub`
 * @returns Ticket for the URL and nonce for the caller's `sessionStorage`
 */
export async function createLinkTicket(
  storage: AccountStateStorage,
  userUUID: string,
): Promise<LinkTicket> {
  const ticket = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  await storage.put(
    linkTicketStorageKey(ticket),
    JSON.stringify({ uuid: userUUID, nonce }),
    { expirationTtl: LINK_TICKET_LIFETIME_SECONDS },
  );

  return { ticket, nonce };
}

/**
 * Redeems a link ticket. The ticket is deleted on read, so a replay of the same
 * ticket resolves to undefined. A failed delete is treated as a failed redeem
 * (fail closed) rather than handing out a ticket that would stay valid.
 *
 * @param storage - OAuth state KV namespace
 * @param ticket - Ticket from the `link_ticket` parameter
 * @returns Account UUID and nonce the ticket was minted with, or undefined
 */
export async function consumeLinkTicket(
  storage: AccountStateStorage,
  ticket: string | null | undefined,
): Promise<LinkTicketBinding | undefined> {
  const stored = await consumeStoredValue(storage, ticket, linkTicketStorageKey);
  if (stored === undefined) {
    return undefined;
  }

  const uuid = readNonEmptyString(stored, 'uuid');
  const nonce = readNonEmptyString(stored, 'nonce');

  // A ticket without a nonce cannot bind a browser, so it is not a ticket.
  return uuid && nonce ? { userUUID: uuid, nonce } : undefined;
}

export interface StashedProviderIdentity {
  /** Account UUID the ticket was minted for — never taken from the request. */
  userUUID: string;
  provider: ProviderType;
  identifier: string;
  nonce: string;
}

/**
 * Parks the provider identity a callback just proved, WITHOUT linking it.
 *
 * This is the whole point of the confirm step: the callback knows which
 * provider account finished the round trip, but not whether the browser it is
 * answering is the one that started the flow. It therefore only stashes what it
 * learned and lets {@link confirmAccountLink} decide.
 *
 * @param storage - OAuth state KV namespace
 * @param identity - Ticket owner, provider identity and the ticket's nonce
 * @returns Link code to hand to the browser as `link_code`
 */
export async function stashLinkCode(
  storage: AccountStateStorage,
  identity: StashedProviderIdentity,
): Promise<string> {
  const linkCode = crypto.randomUUID();

  await storage.put(
    linkCodeStorageKey(linkCode),
    JSON.stringify({
      uuid: identity.userUUID,
      provider: identity.provider,
      identifier: identity.identifier,
      nonce: identity.nonce,
    }),
    { expirationTtl: LINK_CODE_LIFETIME_SECONDS },
  );

  return linkCode;
}

/**
 * Redeems a link code. Single use with the same fail-closed delete as tickets.
 *
 * @param storage - OAuth state KV namespace
 * @param linkCode - Code from the `link_code` parameter
 * @returns Stashed provider identity, or undefined when absent/expired/replayed
 */
export async function consumeLinkCode(
  storage: AccountStateStorage,
  linkCode: string | null | undefined,
): Promise<StashedProviderIdentity | undefined> {
  const stored = await consumeStoredValue(storage, linkCode, linkCodeStorageKey);
  if (stored === undefined) {
    return undefined;
  }

  const uuid = readNonEmptyString(stored, 'uuid');
  const provider = readNonEmptyString(stored, 'provider');
  const identifier = readNonEmptyString(stored, 'identifier');
  const nonce = readNonEmptyString(stored, 'nonce');

  if (!uuid || !provider || !identifier || !nonce) {
    return undefined;
  }

  return { userUUID: uuid, provider: provider as ProviderType, identifier, nonce };
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads and immediately deletes a single-use KV entry, then parses it as an
 * object. Shared by tickets and link codes so both get the same guarantees: a
 * replay finds nothing, and a delete that fails refuses the value rather than
 * leaving it usable.
 */
async function consumeStoredValue(
  storage: AccountStateStorage,
  token: string | null | undefined,
  toKey: (token: string) => string,
): Promise<Record<string, unknown> | undefined> {
  if (!token) {
    return undefined;
  }

  const key = toKey(token);
  const stored = await storage.get(key);
  if (stored === null || stored === undefined) {
    return undefined;
  }

  try {
    await storage.delete(key);
  } catch {
    // Could not guarantee single use — refuse the value.
    return undefined;
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records `account/{provider}/{identifier} -> uuid` so a later login can still
 * resolve the same account while Supabase is unreachable. No TTL: the mapping
 * is immutable for the life of the account.
 */
export async function rememberAccountUUID(
  storage: AccountStateStorage,
  input: SocialLoginInput,
  userUUID: string,
): Promise<void> {
  await storage.put(accountCacheStorageKey(input), userUUID);
}

export async function recallAccountUUID(
  storage: AccountStateStorage,
  input: SocialLoginInput,
): Promise<string | undefined> {
  const stored = await storage.get(accountCacheStorageKey(input));
  return stored !== null && stored !== undefined && stored.length > 0 ? stored : undefined;
}

/**
 * Drops the cached mapping for a provider account. Disconnecting a login has to
 * revoke the credential, not just the Supabase row: the cache has no TTL, so a
 * surviving entry would let the disconnected provider log straight back into the
 * account during the next Supabase outage (design §2.2's fallback turned into a
 * bypass of §7's "unlinked provider logs in → new account").
 *
 * @param storage - OAuth state KV namespace
 * @param input - Provider and provider-side identifier whose mapping to drop
 */
export async function forgetAccountUUID(
  storage: AccountStateStorage,
  input: SocialLoginInput,
): Promise<void> {
  await storage.delete(accountCacheStorageKey(input));
}

export type LoginAccountResolution =
  | {
      resolved: true;
      userUUID: string;
      source: 'supabase' | 'cache';
      isNewUser: boolean;
      isNewAccount: boolean;
    }
  | { resolved: false; reason: 'unavailable' };

export interface ResolveLoginAccountOptions {
  storage: AccountStateStorage;
  createClient: () => SupabaseClientType;
  input: SocialLoginInput;
  /** Optional hook so the caller can log why Supabase was skipped. */
  onSupabaseError?: (error: unknown) => void;
}

/**
 * Resolves the account UUID for a successful social login.
 *
 * Supabase is authoritative. When it is unreachable the KV read-through cache
 * answers for accounts that have logged in before; a brand new account fails
 * closed. There is deliberately NO deterministic-UUID fallback any more — that
 * fallback was the source of account splitting between providers.
 *
 * @param options - Storage, Supabase client factory, provider identity
 * @returns Resolution with the source that answered, or an unavailable marker
 */
export async function resolveLoginAccount(
  options: ResolveLoginAccountOptions,
): Promise<LoginAccountResolution> {
  try {
    const client = options.createClient();
    const socialLoginResult = await handleSocialLogin(client, options.input);

    try {
      await rememberAccountUUID(options.storage, options.input, socialLoginResult.userUUID);
    } catch {
      // Best effort — a cache write failure must not fail the login.
    }

    return {
      resolved: true,
      userUUID: socialLoginResult.userUUID,
      source: 'supabase',
      isNewUser: socialLoginResult.isNewUser,
      isNewAccount: socialLoginResult.isNewAccount,
    };
  } catch (supabaseError) {
    options.onSupabaseError?.(supabaseError);
  }

  try {
    const cachedUUID = await recallAccountUUID(options.storage, options.input);
    if (cachedUUID) {
      return {
        resolved: true,
        userUUID: cachedUUID,
        source: 'cache',
        isNewUser: false,
        isNewAccount: false,
      };
    }
  } catch {
    // A cache read failure is treated as a miss.
  }

  return { resolved: false, reason: 'unavailable' };
}

export type LinkProviderOutcome = 'linked' | 'already_linked' | 'conflict';

function isAccountConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('already linked to another user') ||
    // Lost the race to another link of the same provider account.
    message.includes('duplicate key value violates unique constraint')
  );
}

/**
 * Links a provider account to an existing user, mapping the connector's
 * "linked to another user" throw onto a `conflict` outcome. Account merging is
 * out of scope, so a conflict is reported to the user rather than resolved.
 *
 * @param client - Supabase client
 * @param userUUID - Account UUID from the redeemed link ticket
 * @param input - Provider and provider-side identifier to attach
 * @returns Which of the three defined outcomes happened
 */
export async function linkProviderAccount(
  client: SupabaseClientType,
  userUUID: string,
  input: SocialLoginInput,
): Promise<LinkProviderOutcome> {
  try {
    const result = await linkAccount(client, userUUID, input);
    return result.alreadyLinked ? 'already_linked' : 'linked';
  } catch (error) {
    if (isAccountConflict(error)) {
      return 'conflict';
    }
    throw error;
  }
}

export type ConfirmAccountLinkResult =
  | { confirmed: true; outcome: LinkProviderOutcome; provider: ProviderType }
  | { confirmed: false; reason: 'link_code_expired' | 'link_binding_failed' };

export interface ConfirmAccountLinkOptions {
  /** `link_code` from the request body — anything but a string is "no code". */
  linkCode: unknown;
  /** `nonce` from the request body, read out of the caller's sessionStorage. */
  nonce: unknown;
  /** Account UUID from the verified session `sub`. Never from the request. */
  sub: string;
  createClient: () => SupabaseClientType;
}

/**
 * Confirms a link that a callback only stashed. This is the step that actually
 * writes to `accounts`, and the only one — the callback deliberately does not.
 *
 * Three things have to line up, and this request is the first moment all three
 * can be seen together:
 *
 * - the `link_code`, which only the browser that finished the OAuth round trip
 *   received;
 * - the `nonce`, which only the browser that started the flow was given;
 * - the session JWT of the account the ticket was minted for, checked as
 *   `sub === stashed uuid`.
 *
 * A cross-browser attack splits the first two apart, and a stolen link code
 * confirmed under a different session fails the third, so either way the answer
 * is `link_binding_failed` and nothing is linked. The code is consumed before
 * the checks run, so a failed attempt burns it rather than leaving it for a
 * retry with guessed values.
 *
 * @param storage - OAuth state KV namespace
 * @param options - Body values, verified `sub`, Supabase client factory
 * @returns The link outcome, or why the confirmation was refused
 */
export async function confirmAccountLink(
  storage: AccountStateStorage,
  options: ConfirmAccountLinkOptions,
): Promise<ConfirmAccountLinkResult> {
  const linkCode = typeof options.linkCode === 'string' ? options.linkCode : undefined;
  const stashed = await consumeLinkCode(storage, linkCode);

  if (!stashed) {
    return { confirmed: false, reason: 'link_code_expired' };
  }

  // Both halves are single-use random UUIDs and the code has already been
  // consumed, so a plain comparison leaks nothing an attacker could replay.
  const browserMatches = options.nonce === stashed.nonce;
  const accountMatches = options.sub === stashed.userUUID;

  if (!browserMatches || !accountMatches) {
    return { confirmed: false, reason: 'link_binding_failed' };
  }

  const input: SocialLoginInput = {
    provider: stashed.provider,
    identifier: stashed.identifier,
  };

  const outcome = await linkProviderAccount(options.createClient(), stashed.userUUID, input);

  if (outcome !== 'conflict') {
    try {
      await rememberAccountUUID(storage, input, stashed.userUUID);
    } catch {
      // Best effort — the link is done; only the outage fallback is missing.
    }
  }

  return { confirmed: true, outcome, provider: stashed.provider };
}

export interface LinkedAccountSummary {
  provider: ProviderType;
  linkedAt: string | null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * Lists the providers linked to a user, oldest link first.
 * The provider-side `identifier` is intentionally NOT exposed.
 *
 * @param client - Supabase client
 * @param userUUID - Account UUID from the verified session `sub`
 * @returns Provider + link timestamp pairs
 */
export async function listLinkedAccounts(
  client: SupabaseClientType,
  userUUID: string,
): Promise<LinkedAccountSummary[]> {
  const accounts = await getAccountsByUser(client, userUUID);

  return accounts
    .map((account) => ({
      provider: account.provider,
      linkedAt: normalizeTimestamp(account.created_at),
    }))
    .sort((left, right) => {
      const leftLinkedAt = left.linkedAt ?? '';
      const rightLinkedAt = right.linkedAt ?? '';
      if (leftLinkedAt !== rightLinkedAt) {
        return leftLinkedAt < rightLinkedAt ? -1 : 1;
      }
      return left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0;
    });
}

export type UnlinkProviderResult =
  | { removed: true }
  | { removed: false; reason: 'last_account' | 'account_not_found' };

export interface UnlinkProviderAccountOptions {
  client: SupabaseClientType;
  /** Account UUID from the verified session `sub` — never from the request. */
  userUUID: string;
  /** Provider path segment to unlink. */
  provider: string;
  /**
   * OAuth state KV. Required, not optional: disconnecting a login that leaves
   * its cache entry behind is not a disconnect at all (see
   * {@link forgetAccountUUID}), and an optional parameter is exactly the kind
   * of thing a second worker forgets to pass.
   */
  storage: AccountStateStorage;
}

/**
 * Removes a provider link from a user. The last remaining link is refused here,
 * at the request-handling layer, so the caller can answer with a precise
 * `last_account` error instead of a generic failure (a user must never be able
 * to lock themselves out of their own account).
 *
 * Two orderings in here are load-bearing:
 *
 * - The cache entry is dropped BEFORE the row is deleted. If the KV delete
 *   fails, nothing has been removed yet and the caller answers 503 with the
 *   account intact; the reverse order would leave a permanently valid cached
 *   credential behind whenever KV misbehaved. A dropped entry with the row
 *   still present is harmless — the cache is read-through and refills on the
 *   next successful login.
 * - The remaining-account count is re-read AFTER the delete. PostgREST cannot
 *   express "delete only while another row remains" in one statement, so the
 *   guard above is a time-of-check/time-of-use window: two concurrent deletes
 *   for different providers both observe two rows and both proceed, leaving
 *   zero logins and an account nobody can ever reach again. When the delete
 *   emptied the account the row is put back and the caller is told
 *   `last_account`, so the losing request of that race is refused rather than
 *   the user being locked out.
 *
 * @param options - Client, session-derived user UUID, provider, KV storage
 * @returns Removal result, or the reason it was refused
 */
export async function unlinkProviderAccount(
  options: UnlinkProviderAccountOptions,
): Promise<UnlinkProviderResult> {
  const { client, userUUID, provider, storage } = options;

  const accounts = await getAccountsByUser(client, userUUID);

  if (accounts.length <= 1) {
    return { removed: false, reason: 'last_account' };
  }

  const target = accounts.find((account) => account.provider === provider);
  if (!target) {
    return { removed: false, reason: 'account_not_found' };
  }

  const input: SocialLoginInput = { provider: target.provider, identifier: target.identifier };

  await forgetAccountUUID(storage, input);

  const removed = await unlinkAccount(client, userUUID, input);
  if (!removed) {
    return { removed: false, reason: 'account_not_found' };
  }

  const remaining = await getAccountsByUser(client, userUUID);
  if (remaining.length > 0) {
    return { removed: true };
  }

  try {
    await createAccount(client, { ...input, userUUID });
  } catch (restoreError) {
    const reason = restoreError instanceof Error ? restoreError.message : String(restoreError);
    throw new Error(
      `Removing ${input.provider} left user ${userUUID} with no login and the row could not be restored: ${reason}`,
    );
  }

  return { removed: false, reason: 'last_account' };
}
