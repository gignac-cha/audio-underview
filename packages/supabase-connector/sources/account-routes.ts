import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types/index.ts';
import {
  confirmAccountLink,
  createLinkTicket,
  listLinkedAccounts,
  unlinkProviderAccount,
  type AccountStateStorage,
} from './account-linking.ts';
import { authenticateSessionRequest, type SessionTokenVerifier } from './session-tokens.ts';

type SupabaseClientType = SupabaseClient<Database>;

/**
 * Account management routes, shared by every OAuth provider worker.
 *
 * The workers mount this as a thin layer: they translate their own Request into
 * the primitives below and turn the result back into a Response with their own
 * CORS headers. Keeping the logic here means google and github cannot drift
 * apart, and it stays testable without a Workers runtime.
 *
 * Every route requires `Authorization: Bearer <session JWT>` and derives the
 * user id exclusively from the verified `sub` claim — request bodies and query
 * parameters are never consulted for identity.
 *
 * `POST /accounts/link-confirm` is where a link is actually written. The OAuth
 * callback only stashes what it learned (see `stashLinkCode`), because it
 * cannot tell whose browser it is answering; this route can, because it sees
 * the session JWT, the browser's nonce and the callback's link code at once.
 */
export const ACCOUNTS_PATHNAME = '/accounts';
export const ACCOUNTS_PATHNAME_PREFIX = '/accounts/';
export const LINK_TICKETS_PATHNAME = '/link-tickets';
export const ACCOUNT_LINK_CONFIRM_PATHNAME = '/accounts/link-confirm';

export interface AccountRouteRequest {
  method: string;
  pathname: string;
  authorizationHeader: string | null;
  /**
   * Parsed JSON body. Only `POST /accounts/link-confirm` reads one, so the
   * workers parse a body only when {@link accountRouteRequiresBody} says so —
   * a body that could not be parsed is passed as undefined, which the route
   * treats exactly like a missing `link_code`.
   */
  body?: unknown;
}

/**
 * Whether the worker has to parse a JSON body before dispatching.
 *
 * @param method - Request method
 * @param pathname - Request pathname
 * @returns True only for the one route that takes a body
 */
export function accountRouteRequiresBody(method: string, pathname: string): boolean {
  return method.toUpperCase() === 'POST' && pathname === ACCOUNT_LINK_CONFIRM_PATHNAME;
}

export interface AccountRouteDependencies {
  /**
   * Session token verifier. Absent when the worker has no JWT_SECRET
   * configured, in which case every route answers 503 rather than guessing an
   * identity.
   */
  verifyToken?: SessionTokenVerifier;
  storage: AccountStateStorage;
  createClient: () => SupabaseClientType;
  onError?: (error: unknown, context: { route: string }) => void;
}

export interface AccountRouteResult {
  status: number;
  body: unknown;
}

export function isAccountRoutePathname(pathname: string): boolean {
  return (
    pathname === ACCOUNTS_PATHNAME ||
    pathname.startsWith(ACCOUNTS_PATHNAME_PREFIX) ||
    pathname === LINK_TICKETS_PATHNAME
  );
}

function methodNotAllowed(allowed: string): AccountRouteResult {
  return {
    status: 405,
    body: {
      error: 'method_not_allowed',
      error_description: `Only ${allowed} is supported on this endpoint`,
    },
  };
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Reads one field of a request body without assuming the body is an object. */
function readBodyField(body: unknown, field: string): unknown {
  return body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[field]
    : undefined;
}

/**
 * Dispatches the account management routes.
 *
 * @param request - Method, pathname and Authorization header of the request
 * @param dependencies - Session verifier, KV storage and Supabase client factory
 * @returns Status + JSON body, or undefined when the path is not ours (the
 *          caller should fall through to its own routing)
 */
export async function handleAccountRoute(
  request: AccountRouteRequest,
  dependencies: AccountRouteDependencies,
): Promise<AccountRouteResult | undefined> {
  if (!isAccountRoutePathname(request.pathname)) {
    return undefined;
  }

  const method = request.method.toUpperCase();
  const route = `${method} ${request.pathname}`;

  if (!dependencies.verifyToken) {
    return {
      status: 503,
      body: {
        error: 'session_tokens_unavailable',
        error_description: 'Session tokens are not configured on this worker',
      },
    };
  }

  const claims = await authenticateSessionRequest(
    request.authorizationHeader,
    dependencies.verifyToken,
  );

  if (!claims) {
    return {
      status: 401,
      body: {
        error: 'unauthorized',
        error_description: 'A valid session token is required',
      },
    };
  }

  try {
    if (request.pathname === LINK_TICKETS_PATHNAME) {
      if (method !== 'POST') {
        return methodNotAllowed('POST');
      }

      // The nonce goes in the response body, never in a URL: it is the half of
      // the binding that has to stay inside the browser that starts the link.
      const { ticket, nonce } = await createLinkTicket(dependencies.storage, claims.sub);
      return { status: 200, body: { ticket, nonce } };
    }

    if (request.pathname === ACCOUNT_LINK_CONFIRM_PATHNAME) {
      if (method !== 'POST') {
        return methodNotAllowed('POST');
      }

      const result = await confirmAccountLink(dependencies.storage, {
        linkCode: readBodyField(request.body, 'link_code'),
        nonce: readBodyField(request.body, 'nonce'),
        // Identity comes from the verified token only. This is also what stops
        // the reverse attack: a stolen link code confirmed under someone else's
        // session fails `sub === stashed uuid`.
        sub: claims.sub,
        createClient: dependencies.createClient,
      });

      if (!result.confirmed) {
        return result.reason === 'link_code_expired'
          ? {
              status: 410,
              body: {
                error: 'link_code_expired',
                error_description: 'This link code is unknown, expired or already used',
              },
            }
          : {
              status: 403,
              body: {
                error: 'link_binding_failed',
                error_description: 'This confirmation did not come from the browser that started the link',
              },
            };
      }

      if (result.outcome === 'conflict') {
        return { status: 409, body: { result: 'conflict' } };
      }

      return { status: 200, body: { result: result.outcome } };
    }

    if (request.pathname === ACCOUNTS_PATHNAME) {
      if (method !== 'GET') {
        return methodNotAllowed('GET');
      }

      const accounts = await listLinkedAccounts(dependencies.createClient(), claims.sub);
      return { status: 200, body: { accounts } };
    }

    if (method !== 'DELETE') {
      return methodNotAllowed('DELETE');
    }

    const provider = decodePathSegment(request.pathname.slice(ACCOUNTS_PATHNAME_PREFIX.length));
    const result = await unlinkProviderAccount({
      client: dependencies.createClient(),
      userUUID: claims.sub,
      provider,
      // Disconnecting has to revoke the KV account cache entry too, otherwise
      // the removed provider still logs into this account whenever Supabase is
      // unreachable. Both workers hand us the same namespace they cache into.
      storage: dependencies.storage,
    });

    if (result.removed) {
      return { status: 200, body: { removed: true } };
    }

    if (result.reason === 'last_account') {
      return {
        status: 400,
        body: {
          error: 'last_account',
          error_description: 'The last remaining login cannot be disconnected',
        },
      };
    }

    return {
      status: 404,
      body: {
        error: 'account_not_found',
        error_description: 'No such login is connected to this account',
      },
    };
  } catch (error) {
    dependencies.onError?.(error, { route });

    // Account management never falls back to the KV cache — consistency wins.
    return {
      status: 503,
      body: {
        error: 'accounts_unavailable',
        error_description: 'Account service is temporarily unavailable',
      },
    };
  }
}
