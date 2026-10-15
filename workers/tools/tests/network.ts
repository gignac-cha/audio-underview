/**
 * The MSW network (`@msw/cloudflare`) that mocks outbound requests in the worker tests, and helpers for its handlers.
 * `./setup.ts` enables it for every test file that lists the setup in `setupFiles`.
 */
import { setupNetwork } from '@msw/cloudflare';
import type { RequestHandler } from 'msw';
import { HttpNetworkFrame } from 'msw/experimental';

export const network = setupNetwork();

export type Network = typeof network;
type Handler = Parameters<Network['use']>[number];

// A request that no handler matches fails rather than reaching the network. The "error" strategy is not used
// because it still lets through requests whose path looks like a static asset (`.json`, `.html`, `.png`, ...).
// The message names the request; a thrown network error response then fails the fetch with `TypeError: Failed to fetch`.
network.configure({
  onUnhandledFrame: async ({ frame, defaults }) => {
    await defaults.error();
    throw frame instanceof HttpNetworkFrame ? Response.error() : new Error(await frame.getUnhandledMessage());
  },
});

type ValueMatcher = string | RegExp | ((value: string) => boolean);

export interface RequestMatch {
  /** Path with its query string; a string matches whatever order the query parameters come in */
  path: ValueMatcher;
  method?: ValueMatcher;
  /** Matches the body read as text */
  body?: ValueMatcher;
  /** Matches each named header, or all headers with lower-case names at once */
  headers?: Record<string, ValueMatcher> | ((headers: Record<string, string>) => boolean);
}

// What each predicate made by requestMatching() matches, for the message of assertNoPendingHandlers()
const requestDescriptions = new WeakMap<object, string>();

// The query parameters sorted, so their order does not matter
function normalizePath(path: string): string {
  const separatorIndex = path.indexOf('?');
  if (separatorIndex === -1) return path;
  const query = new URLSearchParams(path.slice(separatorIndex + 1));
  query.sort();
  return `${path.slice(0, separatorIndex)}?${query.toString()}`;
}

function matchesValue(matcher: ValueMatcher, value: string): boolean {
  if (typeof matcher === 'string') return matcher === value;
  if (matcher instanceof RegExp) return matcher.test(value);
  return matcher(value) === true;
}

function matchesHeaders(matcher: NonNullable<RequestMatch['headers']>, headers: Headers): boolean {
  if (typeof matcher === 'function') return matcher(Object.fromEntries(headers));
  return Object.entries(matcher).every(([name, valueMatcher]) => matchesValue(valueMatcher, headers.get(name) ?? ''));
}

function describeMatcher(matcher: ValueMatcher): string {
  if (typeof matcher === 'string') return matcher;
  if (matcher instanceof RegExp) return String(matcher);
  return '[function]';
}

function describeRequest(origin: string, match: RequestMatch): string {
  const method = describeMatcher(match.method ?? 'GET');
  const path = typeof match.path === 'string' ? `${origin}${match.path}` : `${origin} path ${describeMatcher(match.path)}`;
  const conditions = [match.headers === undefined ? null : 'headers', match.body === undefined ? null : 'body'].filter((condition) => condition !== null);
  return `${method} ${path}${conditions.length > 0 ? ` (also matching its ${conditions.join(' and ')})` : ''}`;
}

/**
 * A predicate for `http.all()` that matches a request as the undici interceptor of the old test pool did:
 * by its origin, its method, GET by default, and its exact path with the query string, which the URL patterns of MSW
 * leave out (they also let a trailing slash through).
 * The body and the headers are checked here rather than in the resolver,
 * because MSW counts a handler `{ once: true }` as used as soon as its predicate matches.
 */
export function requestMatching(origin: string, match: RequestMatch): (arguments_: { request: Request }) => Promise<boolean> {
  const predicate = async ({ request }: { request: Request }): Promise<boolean> => {
    const url = new URL(request.url);
    if (url.origin !== origin) return false;
    if (!matchesValue(match.method ?? 'GET', request.method)) return false;
    const path = normalizePath(`${url.pathname}${url.search}`);
    const pathMatcher = typeof match.path === 'string' ? normalizePath(match.path) : match.path;
    if (!matchesValue(pathMatcher, path)) return false;
    if (match.headers !== undefined && !matchesHeaders(match.headers, request.headers)) return false;
    // Decoded from the bytes: workerd warns about text() on a form-encoded body
    if (match.body !== undefined && !matchesValue(match.body, new TextDecoder().decode(await request.clone().arrayBuffer()))) return false;
    return true;
  };
  requestDescriptions.set(predicate, describeRequest(origin, match));
  return predicate;
}

/**
 * Registers handlers after the ones already in use, so the handler registered first answers first
 * and answers queued for one request keep their order. `network.use()` puts new handlers first.
 */
export function appendHandlers(target: Network, ...handlers: Array<Handler>): void {
  target.use(...target.listHandlers(), ...handlers);
}

function describeHandler(handler: RequestHandler): string {
  const info: { header: string; path?: unknown } = handler.info;
  const description = typeof info.path === 'function' ? requestDescriptions.get(info.path) : undefined;
  return description ?? info.header;
}

/**
 * Fails when a handler in use never answered, naming the request each such handler waits for.
 * A handler `{ once: true }` answers one request, so an answer queued `n` times is `n` such handlers.
 */
export function assertNoPendingHandlers(target: Network): void {
  const pendingHandlers = target.listHandlers().filter((handler): handler is RequestHandler => handler.kind === 'request' && !handler.isUsed);
  if (pendingHandlers.length > 0) {
    throw new Error(`${pendingHandlers.length} handler(s) never answered:\n${pendingHandlers.map((handler) => `  ${describeHandler(handler)}`).join('\n')}`);
  }
}
