/**
 * Request-level policy the OAuth provider workers apply *before* they touch KV,
 * Supabase or the provider. It lives here, next to the shared account routes,
 * for the same reason those do: google and github must not drift apart, and it
 * stays unit-testable without a Workers runtime.
 *
 * Two checks, each closing a hole the account-linking work opened or widened:
 *
 * 1. {@link isValidOAuthState} — the OAuth state KV namespace now also holds
 *    `account/{provider}/{identifier}` and `link-ticket/{ticket}`, and the
 *    shared `verifyState` (worker-tools, shared with the live workers, not
 *    ours to change) `get`s and then `delete`s whatever key it is handed. An
 *    unauthenticated `GET /callback?code=x&state=account%2Fgithub%2F12345`
 *    would otherwise erase that account's cache entry — the very entry §2.2 of
 *    the design relies on to keep existing users logged in while Supabase is
 *    down. States are always `generateState()` output, so anything that is not
 *    exactly 32 characters of `[A-Za-z0-9]` is refused before KV is touched.
 *    No key this namespace holds other than a state can match that shape (the
 *    others all contain `/`).
 *
 * 2. {@link isAllowedRedirectURI} — `/callback` appends `user`, `access_token`,
 *    `uuid` and now a 24-hour `session_token` to the redirect target. An
 *    unvalidated `redirect_uri` therefore hands a full account credential to
 *    any origin the attacker names, so the target origin must be one the
 *    operator listed.
 *
 * A third check used to live here — a `Referer` allowlist on
 * `/authorize?link_ticket=…`, meant to prove that a link flow started at the
 * application. It has been removed, deliberately: `/authorize` is a plain
 * cookie-less GET, so an attacker calls it server side with a forged `Referer`
 * and their own ticket, then hands the resulting provider URL to the victim.
 * The header only constrains browsers, never the attacker, so it bought no
 * security while breaking every `Referer`-stripping browser. The binding now
 * happens where it can actually be enforced: the callback stashes the provider
 * identity and `POST /accounts/link-confirm` requires the session JWT, the
 * initiating browser's nonce and the callback's link code together (see
 * `account-linking.ts`).
 */

/** `generateState()` (sign-provider) emits exactly 32 characters of [A-Za-z0-9]. */
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9]{32}$/;

/**
 * Whether a callback `state` may be used as a KV key.
 *
 * @param state - Raw `state` query parameter
 * @returns True only for the exact shape `generateState()` produces
 */
export function isValidOAuthState(state: string | null | undefined): boolean {
  return typeof state === 'string' && OAUTH_STATE_PATTERN.test(state);
}

/**
 * Normalizes a URL to its origin, rejecting anything that is not http(s) —
 * `javascript:`, `data:` and relative values must never pass an origin check.
 */
function toOrigin(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the origin allowlist from the worker's own configuration.
 *
 * @param allowedOrigins - Comma separated `ALLOWED_ORIGINS` var
 * @param additionalOrigins - Further trusted URLs (typically `FRONTEND_URL`)
 * @returns Set of normalized origins; unparseable entries are dropped
 */
export function parseAllowedOrigins(
  allowedOrigins: string | null | undefined,
  ...additionalOrigins: (string | null | undefined)[]
): Set<string> {
  const candidates = [...(allowedOrigins ?? '').split(','), ...additionalOrigins];

  const origins = new Set<string>();
  for (const candidate of candidates) {
    const origin = toOrigin(candidate);
    if (origin) {
      origins.add(origin);
    }
  }

  return origins;
}

/**
 * Whether the login/link flow may redirect back to this URI.
 *
 * @param redirectURI - `redirect_uri` parameter, or the one stored in a state
 * @param allowedOrigins - Output of {@link parseAllowedOrigins}
 * @returns True when the URI's origin is on the allowlist
 */
export function isAllowedRedirectURI(
  redirectURI: string | null | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = toOrigin(redirectURI);
  return origin !== undefined && allowedOrigins.has(origin);
}
