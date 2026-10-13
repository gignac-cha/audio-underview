import { WorkerEntrypoint } from 'cloudflare:workers';
import { createWorkerLogger, type Logger } from '@audio-underview/logger';
import { isBlockedAddress, parseIPv4 } from './address-policy.ts';

/**
 * Every request the code of a crawler sends leaves through this gateway (the globalOutbound of its
 * Dynamic Worker). It refuses private and internal addresses, follows redirects itself so every hop
 * is checked again, and never logs what a request carries: only the hostname and the reason of a refusal.
 */

/**
 * The redirect mode the crawler code asked for. A request reaches the gateway with redirect 'manual'
 * whatever the code asked, so the runner module sends the mode in this header; the gateway removes it.
 */
export const REDIRECT_MODE_HEADER = 'x-crawler-redirect-mode';

const MAXIMUM_REDIRECTS = 20;
const DNS_TIMEOUT_MILLISECONDS = 5_000;
const DNS_OVER_HTTPS_URL = 'https://cloudflare-dns.com/dns-query';
const DNS_RECORD_TYPE_A = 1;
const DNS_RECORD_TYPE_AAAA = 28;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Headers that describe a body, removed when a redirect drops the body
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];
// Credentials that must not follow a redirect to another origin
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

type RedirectMode = 'follow' | 'manual' | 'error';

export interface GuardedFetchOptions {
  /** Sends the DNS queries and the requests; the global fetch of the crawler manager by default */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  logger?: Logger;
}

const defaultLogger = createWorkerLogger({
  defaultContext: {
    module: 'crawler-outbound-gateway',
  },
});

function readRedirectMode(request: Request): RedirectMode {
  const mode = request.headers.get(REDIRECT_MODE_HEADER);
  return mode === 'manual' || mode === 'error' ? mode : 'follow';
}

function blocked(logger: Logger, hostname: string, reason: string, message: string): TypeError {
  logger.warn('Outbound request blocked', { hostname, reason }, { function: 'guardedFetch' });
  return new TypeError(message);
}

interface DNSAnswer {
  type?: unknown;
  data?: unknown;
}

async function queryAddresses(
  fetcher: NonNullable<GuardedFetchOptions['fetch']>,
  hostname: string,
  type: 'A' | 'AAAA',
): Promise<string[]> {
  const response = await fetcher(`${DNS_OVER_HTTPS_URL}?name=${encodeURIComponent(hostname)}&type=${type}`, {
    method: 'GET',
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DNS_TIMEOUT_MILLISECONDS),
  });
  if (!response.ok) {
    throw new Error(`DNS query answered ${response.status}`);
  }
  const body = await response.json() as { Answer?: unknown };
  const answers = Array.isArray(body.Answer) ? body.Answer as DNSAnswer[] : [];
  // Only address records count; a CNAME alone leads nowhere
  return answers
    .filter((answer) => answer.type === DNS_RECORD_TYPE_A || answer.type === DNS_RECORD_TYPE_AAAA)
    .map((answer) => String(answer.data));
}

/**
 * Checks where a request would go, before every request and every redirect hop.
 *
 * @throws TypeError when the protocol, the name or an address of the host is not allowed
 */
async function checkDestination(
  url: URL,
  fetcher: NonNullable<GuardedFetchOptions['fetch']>,
  logger: Logger,
): Promise<void> {
  const hostname = url.hostname;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw blocked(logger, hostname, 'protocol', `Protocol '${url.protocol}' is not allowed. Only http: and https: are permitted`);
  }

  const name = hostname.replace(/\.+$/, '').toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) {
    throw blocked(logger, hostname, 'localhost', `The address of '${hostname}' is not allowed`);
  }

  let addresses: string[];
  if (name.startsWith('[') && name.endsWith(']')) {
    addresses = [name.slice(1, -1)];
  } else if (parseIPv4(name) !== undefined) {
    addresses = [name];
  } else {
    try {
      const [ipv4Addresses, ipv6Addresses] = await Promise.all([
        queryAddresses(fetcher, name, 'A'),
        queryAddresses(fetcher, name, 'AAAA'),
      ]);
      addresses = [...ipv4Addresses, ...ipv6Addresses];
    } catch {
      throw blocked(logger, hostname, 'dns_lookup_failed', `DNS lookup failed for '${hostname}'`);
    }
    if (addresses.length === 0) {
      throw blocked(logger, hostname, 'dns_lookup_failed', `DNS lookup failed for '${hostname}'`);
    }
  }

  if (addresses.some((address) => isBlockedAddress(address))) {
    throw blocked(logger, hostname, 'address', `The address of '${hostname}' is not allowed`);
  }
}

/**
 * Sends a request of crawler code after checking its destination, and follows redirects itself.
 * The body is passed on as a stream and never collected.
 *
 * @throws TypeError for a destination that is not allowed, a refused or endless redirect
 */
export async function guardedFetch(request: Request, options: GuardedFetchOptions = {}): Promise<Response> {
  const fetcher = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const logger = options.logger ?? defaultLogger;
  const redirectMode = readRedirectMode(request);

  const headers = new Headers(request.headers);
  headers.delete(REDIRECT_MODE_HEADER);
  let url = new URL(request.url);
  let method = request.method;
  let body: ReadableStream | null = request.body;

  for (let redirectCount = 0; ; redirectCount += 1) {
    await checkDestination(url, fetcher, logger);

    const response = await fetcher(url.toString(), { method, headers, body, redirect: 'manual' });
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null || redirectMode === 'manual') {
      return response;
    }
    if (redirectMode === 'error') {
      await response.body?.cancel();
      throw new TypeError('Redirect was not allowed');
    }
    if (redirectCount === MAXIMUM_REDIRECTS) {
      await response.body?.cancel();
      throw blocked(logger, url.hostname, 'too_many_redirects', 'Too many redirects');
    }

    const changesToGet =
      ((response.status === 301 || response.status === 302) && method === 'POST') ||
      (response.status === 303 && method !== 'GET' && method !== 'HEAD');
    if (changesToGet) {
      method = 'GET';
      body = null;
      for (const header of BODY_HEADERS) {
        headers.delete(header);
      }
    } else if (body !== null) {
      // The body was sent as a stream and cannot be sent again
      return response;
    }

    const nextURL = new URL(location, url);
    if (nextURL.origin !== url.origin) {
      for (const header of CREDENTIAL_HEADERS) {
        headers.delete(header);
      }
    }
    await response.body?.cancel();
    url = nextURL;
  }
}

/**
 * The globalOutbound of every crawler Dynamic Worker. connect() is not implemented, so it fails.
 */
export class CrawlerOutboundGateway extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    return guardedFetch(request);
  }
}
