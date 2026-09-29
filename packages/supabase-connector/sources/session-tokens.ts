import type { ProviderType } from './types/index.ts';

/**
 * Session tokens are self-issued HS256 JWTs whose `sub` is the Supabase account
 * UUID. They replace the raw provider access token as the browser session
 * credential, so every downstream worker sees a single identity space.
 *
 * The signing secret is the same `JWT_SECRET` the newscast pipeline verifies
 * with, which is why the claim shape must stay compatible with it:
 * - `sub` — account UUID (the only trusted source of a user id).
 * - `provider` — which social login minted this session (informational).
 * - `iat`/`exp` — 24 hours, matching the SPA session lifetime.
 * - **no `jid`** — the pipeline treats a `jid` claim as a short-lived media
 *   token and refuses to accept it as a session, so session tokens must never
 *   carry one.
 *
 * The HS256 primitives themselves live in `worker-tools`, which is a
 * Workers-runtime package; this module stays runtime-agnostic and takes the
 * verifier as a parameter so the connector can be unit-tested in plain Node.
 */
export const SESSION_TOKEN_LIFETIME_SECONDS = 86_400;

export interface SessionTokenClaims {
  sub: string;
  provider?: ProviderType;
  iat: number;
  exp: number;
}

/**
 * Declared as a type alias (not an interface) so it satisfies the index
 * signature of the worker-side `JWTPayload` when handed to `signJWT`.
 */
export type SessionTokenPayload = {
  sub: string;
  provider: ProviderType;
  iat: number;
  exp: number;
};

export interface CreateSessionTokenPayloadOptions {
  userUUID: string;
  provider: ProviderType;
  /** Overridable for deterministic tests; defaults to the current wall clock. */
  issuedAtSeconds?: number;
}

/** Verifies a raw JWT and returns its payload, or null/undefined when invalid. */
export type SessionTokenVerifier = (token: string) => Promise<unknown>;

/**
 * Builds the claim set for a session token. Sign it with the worker's
 * `signJWT(payload, JWT_SECRET)`.
 *
 * @param options - Account UUID, minting provider, optional issue time
 * @returns Claims to sign — never contains `jid`
 */
export function createSessionTokenPayload(
  options: CreateSessionTokenPayloadOptions,
): SessionTokenPayload {
  const issuedAtSeconds = options.issuedAtSeconds ?? Math.floor(Date.now() / 1000);

  return {
    sub: options.userUUID,
    provider: options.provider,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + SESSION_TOKEN_LIFETIME_SECONDS,
  };
}

/**
 * Extracts the bearer token from an Authorization header value.
 *
 * @param authorizationHeader - Raw header value, if present
 * @returns Token string, or undefined when the header is absent or malformed
 */
export function readBearerToken(authorizationHeader: string | null | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const parts = authorizationHeader.trim().split(/\s+/);
  if (parts.length !== 2) {
    return undefined;
  }

  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== 'bearer' || token.length === 0) {
    return undefined;
  }

  return token;
}

/**
 * Narrows a verified JWT payload to session claims.
 * Rejects media tokens (`jid` present) so they can never act as a session.
 *
 * @param payload - Payload returned by the JWT verifier
 * @returns Session claims when the payload is shaped like a session token
 */
export function toSessionTokenClaims(payload: unknown): SessionTokenClaims | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;

  // Media tokens (job-scoped, 300s) carry `jid`. They are not sessions.
  if ('jid' in record) {
    return undefined;
  }

  const { sub, iat, exp, provider } = record;

  if (typeof sub !== 'string' || sub.length === 0) {
    return undefined;
  }

  if (typeof iat !== 'number' || typeof exp !== 'number') {
    return undefined;
  }

  return {
    sub,
    provider: typeof provider === 'string' ? (provider as ProviderType) : undefined,
    iat,
    exp,
  };
}

/**
 * Authenticates a request from its Authorization header.
 * The returned `sub` is the ONLY trusted user id — request bodies and query
 * parameters must never be consulted for identity.
 *
 * @param authorizationHeader - Raw Authorization header value
 * @param verifyToken - Signature/expiry verifier (worker-side `verifyJWT`)
 * @returns Claims when the request carries a valid session token
 */
export async function authenticateSessionRequest(
  authorizationHeader: string | null | undefined,
  verifyToken: SessionTokenVerifier,
): Promise<SessionTokenClaims | undefined> {
  const token = readBearerToken(authorizationHeader);
  if (!token) {
    return undefined;
  }

  const payload = await verifyToken(token);
  return toSessionTokenClaims(payload);
}
