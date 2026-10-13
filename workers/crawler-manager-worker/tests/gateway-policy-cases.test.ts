import { describe, it, expect } from 'vitest';
import { guardedFetch, REDIRECT_MODE_HEADER } from '../sources/crawler-runtime/outbound-gateway.ts';
import { createMockLogger } from './runtime-harness.ts';

// What the gateway refuses and what it lets through, beyond outbound-gateway.test.ts. The network behind it
// is a function: DNS over HTTPS answers from a table, every other request goes to `respond`.

interface Hop {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

interface DNSEntry {
  A?: string[];
  AAAA?: string[];
  cnameOnly?: boolean;
  failure?: 'A' | 'AAAA';
  status?: number;
}

function createNetwork(table: Record<string, DNSEntry>, respond: (hop: Hop) => Response = () => new Response('ok')) {
  const hops: Hop[] = [];
  const queries: { name: string; type: string; accept: string | null; hasTimeLimit: boolean }[] = [];
  const fetcher = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin === 'https://cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? '';
      const type = url.searchParams.get('type') ?? '';
      queries.push({ name, type, accept: new Headers(init.headers).get('accept'), hasTimeLimit: init.signal instanceof AbortSignal });
      const entry = table[name];
      if (entry === undefined || entry.failure === type) throw new Error('DNS over HTTPS is down');
      if (entry.status !== undefined && type === 'A') return new Response('error', { status: entry.status });
      if (entry.cnameOnly) return Response.json({ Status: 0, Answer: [{ name, type: 5, TTL: 60, data: 'target.example.net.' }] });
      const addresses = (type === 'A' ? entry.A : entry.AAAA) ?? [];
      return Response.json({ Status: 0, Answer: addresses.map((data) => ({ name, type: type === 'A' ? 1 : 28, TTL: 60, data })) });
    }
    const hop: Hop = {
      url: input,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body === undefined || init.body === null ? null : await new Response(init.body as BodyInit).text(),
    };
    hops.push(hop);
    return respond(hop);
  };
  return { fetch: fetcher, hops, queries };
}

const PUBLIC = { A: ['93.184.216.34'], AAAA: ['2606:2800:220:1::1'] };

function redirectTo(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

function crawlerRequest(url: string, init: RequestInit = {}, mode?: 'follow' | 'manual' | 'error'): Request {
  const request = new Request(url, { ...init, redirect: 'manual' });
  if (mode !== undefined) request.headers.set(REDIRECT_MODE_HEADER, mode);
  return request;
}

/** A request as the Workers runtime would not construct it, for schemes it refuses before the gateway */
function foreignRequest(url: string): Request {
  return { url, method: 'GET', headers: new Headers(), body: null } as unknown as Request;
}

describe('IP literals', () => {
  it.each([
    'http://127.1/', 'http://127.0.0.1./', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://[::ffff:7f00:1]:8080/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]/', 'http://[::FFFF:A00:1]/', 'http://0.0.0.0/', 'https://192.168.0.1:8443/path?token=abc',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/', 'http://[2002:7f00:1::]/', 'http://[fe80::1]/',
    'http://[::ffff:0:7f00:1]/', 'http://[64:ff9b:1::a00:1]/', 'http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/',
  ])('refuses %s without asking DNS or connecting', async (address) => {
    const network = createNetwork({});

    await expect(guardedFetch(crawlerRequest(address), { fetch: network.fetch, logger: createMockLogger() })).rejects.toThrow(
      /^The address of '.+' is not allowed$/,
    );
    expect(network.hops).toEqual([]);
    expect(network.queries).toEqual([]);
  });

  it('sends a public IP literal without asking DNS', async () => {
    const network = createNetwork({});

    await guardedFetch(crawlerRequest('http://93.184.216.34/'), { fetch: network.fetch, logger: createMockLogger() });
    await guardedFetch(crawlerRequest('http://[2606:4700:4700::1111]/'), { fetch: network.fetch, logger: createMockLogger() });

    expect(network.hops.map((hop) => hop.url)).toEqual(['http://93.184.216.34/', 'http://[2606:4700:4700::1111]/']);
    expect(network.queries).toEqual([]);
  });

  it('sends an IP literal that carries a public IPv4 address, or lies just outside a blocked range, without asking DNS', async () => {
    const network = createNetwork({});

    for (const address of ['http://[::ffff:0:808:808]/', 'http://[64:ff9b:2::]/', 'http://[2001:1::]/']) {
      await guardedFetch(crawlerRequest(address), { fetch: network.fetch, logger: createMockLogger() });
    }

    expect(network.hops.map((hop) => hop.url)).toEqual(['http://[::ffff:0:808:808]/', 'http://[64:ff9b:2::]/', 'http://[2001:1::]/']);
    expect(network.queries).toEqual([]);
  });
});

describe('names', () => {
  it('does not take a name that merely contains localhost for localhost, and refuses the real ones without asking DNS', async () => {
    const allowed = createNetwork({ 'notlocalhost.example.com': PUBLIC, 'localhost.example.com': PUBLIC });
    for (const host of ['notlocalhost.example.com', 'localhost.example.com']) {
      await expect(guardedFetch(crawlerRequest(`http://${host}/`), { fetch: allowed.fetch, logger: createMockLogger() })).resolves.toBeInstanceOf(Response);
    }

    const refused = createNetwork({});
    for (const address of ['http://localhost/', 'http://localhost./', 'http://LOCALHOST:8080/', 'http://foo.localhost/', 'http://a.b.localhost./']) {
      await expect(guardedFetch(crawlerRequest(address), { fetch: refused.fetch, logger: createMockLogger() }), address).rejects.toThrow(
        /^The address of '.+' is not allowed$/,
      );
    }
    expect(refused.queries).toEqual([]);
  });

  it('refuses the schemes that are not http and https', async () => {
    const network = createNetwork({});

    for (const address of ['ftp://example.com/file', 'file:///etc/passwd', 'gopher://example.com/', 'ws://example.com/']) {
      await expect(guardedFetch(foreignRequest(address), { fetch: network.fetch, logger: createMockLogger() }), address).rejects.toThrow(
        /^Protocol '[a-z]+:' is not allowed\. Only http: and https: are permitted$/,
      );
    }
    expect(network.hops).toEqual([]);
  });

  it('asks for A and AAAA with the JSON accept header and a time limit, in lower case and without the final dot', async () => {
    const network = createNetwork({ 'example.com': PUBLIC });

    await guardedFetch(crawlerRequest('https://Example.com./'), { fetch: network.fetch, logger: createMockLogger() });

    expect(network.queries.map(({ name, type }) => `${name}/${type}`).sort()).toEqual(['example.com/A', 'example.com/AAAA']);
    expect(network.queries.every((query) => query.accept === 'application/dns-json' && query.hasTimeLimit)).toBe(true);
  });

  it('refuses a name that has a private address among public ones, of either record type', async () => {
    const network = createNetwork({
      'mixed.example.com': { A: ['93.184.216.34', '192.168.1.1'] },
      'mixed6.example.com': { A: ['93.184.216.34'], AAAA: ['2606:2800:220:1::1', '::ffff:7f00:1'] },
      'loop6.example.com': { AAAA: ['::1'] },
      'internal.example.com': { A: ['10.1.2.3'] },
    });

    for (const host of ['mixed.example.com', 'mixed6.example.com', 'loop6.example.com', 'internal.example.com']) {
      await expect(guardedFetch(crawlerRequest(`https://${host}/`), { fetch: network.fetch, logger: createMockLogger() }), host).rejects.toThrow(
        new TypeError(`The address of '${host}' is not allowed`),
      );
    }
    expect(network.hops).toEqual([]);
  });

  it('refuses a name when one record type fails, the other holds no address, or DNS answers an error status', async () => {
    const network = createNetwork({
      'half.example.com': { A: ['93.184.216.34'], failure: 'AAAA' },
      'bad-status.example.com': { A: ['93.184.216.34'], status: 500 },
      'alias.example.com': { cnameOnly: true },
      'empty.example.com': {},
    });

    for (const host of ['half.example.com', 'bad-status.example.com', 'alias.example.com', 'empty.example.com', 'unknown.example.com']) {
      await expect(guardedFetch(crawlerRequest(`https://${host}/`), { fetch: network.fetch, logger: createMockLogger() }), host).rejects.toThrow(
        new TypeError(`DNS lookup failed for '${host}'`),
      );
    }
    expect(network.hops).toEqual([]);
  });

  it('allows a name that has only an A record or only an AAAA record', async () => {
    const network = createNetwork({ 'v4.example.com': { A: ['93.184.216.34'] }, 'v6.example.com': { AAAA: ['2606:2800:220:1::1'] } });

    for (const host of ['v4.example.com', 'v6.example.com']) {
      await expect(guardedFetch(crawlerRequest(`https://${host}/`), { fetch: network.fetch, logger: createMockLogger() })).resolves.toBeInstanceOf(Response);
    }
  });
});

describe('redirects', () => {
  it('refuses a redirect to a name that resolves to a private address, to localhost and to another scheme, without requesting them', async () => {
    for (const location of ['http://rebind.example.com/', 'http://localhost:9000/', 'ftp://example.com/file']) {
      const network = createNetwork({ 'example.com': PUBLIC, 'rebind.example.com': { A: ['127.0.0.1'] } }, () => redirectTo(301, location));

      await expect(guardedFetch(crawlerRequest('https://example.com/'), { fetch: network.fetch, logger: createMockLogger() }), location).rejects.toThrow(TypeError);
      expect(network.hops.map((hop) => hop.url), location).toEqual(['https://example.com/']);
    }
  });

  it('checks the next host again with DNS and follows a redirect to another public host', async () => {
    const network = createNetwork(
      { 'example.com': PUBLIC, 'other.example.org': PUBLIC },
      (hop) => (hop.url === 'https://example.com/' ? redirectTo(302, 'https://other.example.org/landing') : new Response('landed')),
    );

    const response = await guardedFetch(crawlerRequest('https://example.com/'), { fetch: network.fetch, logger: createMockLogger() });

    expect(await response.text()).toBe('landed');
    expect(network.hops.map((hop) => hop.url)).toEqual(['https://example.com/', 'https://other.example.org/landing']);
    expect(network.queries.map((query) => query.name)).toContain('other.example.org');
  });

  it('resolves a relative Location against the current URL', async () => {
    const network = createNetwork({ 'example.com': PUBLIC }, (hop) => (hop.url.endsWith('/dir/start') ? redirectTo(302, '../next?x=1') : new Response('done')));

    await guardedFetch(crawlerRequest('https://example.com/dir/start'), { fetch: network.fetch, logger: createMockLogger() });

    expect(network.hops.map((hop) => hop.url)).toEqual(['https://example.com/dir/start', 'https://example.com/next?x=1']);
  });

  it('refuses a Location that is not a URL when it follows, and hands it back when the code asked for manual', async () => {
    const network = createNetwork({ 'example.com': PUBLIC }, () => redirectTo(302, 'http://[invalid'));

    await expect(guardedFetch(crawlerRequest('https://example.com/start'), { fetch: network.fetch, logger: createMockLogger() })).rejects.toThrow(TypeError);
    const manual = await guardedFetch(crawlerRequest('https://example.com/start', {}, 'manual'), { fetch: network.fetch, logger: createMockLogger() });
    expect(manual.status).toBe(302);
    expect(manual.headers.get('location')).toBe('http://[invalid');
  });

  it('returns a 3xx without a Location, a 300 and a 304 as they are', async () => {
    const answers = [new Response(null, { status: 302 }), new Response('multiple', { status: 300, headers: { location: 'https://example.com/other' } }), new Response(null, { status: 304 })];
    const network = createNetwork({ 'example.com': PUBLIC }, () => answers.shift() as Response);

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await guardedFetch(crawlerRequest('https://example.com/'), { fetch: network.fetch, logger: createMockLogger() })).status);
    }

    expect(statuses).toEqual([302, 300, 304]);
    expect(network.hops).toHaveLength(3);
  });

  it('turns a 303 of a PUT into a GET, keeps GET, HEAD and a bodiless DELETE for the other 3xx, and keeps HEAD for a 303', async () => {
    const network = createNetwork({ 'example.com': PUBLIC }, (hop) => (hop.url.endsWith('/from') ? redirectTo(303, '/to') : new Response('to')));
    const options = { fetch: network.fetch, logger: createMockLogger() };

    await guardedFetch(crawlerRequest('https://example.com/from', { method: 'PUT', body: 'x' }), options);
    await guardedFetch(crawlerRequest('https://example.com/from', { method: 'HEAD' }), options);

    expect(network.hops.map((hop) => hop.method)).toEqual(['PUT', 'GET', 'HEAD', 'HEAD']);

    for (const status of [301, 302, 307, 308]) {
      const other = createNetwork({ 'example.com': PUBLIC }, (hop) => (hop.url.endsWith('/from') ? redirectTo(status, '/to') : new Response('to')));
      for (const method of ['GET', 'HEAD', 'DELETE']) {
        other.hops.length = 0;
        await guardedFetch(crawlerRequest('https://example.com/from', { method }), { fetch: other.fetch, logger: createMockLogger() });
        expect(other.hops.map((hop) => hop.method), `${status} ${method}`).toEqual([method, method]);
      }
    }
  });

  it('drops the credentials on a change of scheme or port, and does not bring them back when a later redirect returns to the first origin', async () => {
    const headers = { authorization: 'Bearer abc', cookie: 'session=1', 'proxy-authorization': 'Basic x', 'x-keep': 'yes' };
    for (const location of ['http://example.com/', 'https://example.com:8443/']) {
      const network = createNetwork({ 'example.com': PUBLIC }, (hop) => (hop.url === 'https://example.com/start' ? redirectTo(302, location) : new Response('end')));

      await guardedFetch(crawlerRequest('https://example.com/start', { headers }), { fetch: network.fetch, logger: createMockLogger() });

      const second = network.hops[1];
      expect(second.url).toBe(location);
      for (const name of ['authorization', 'cookie', 'proxy-authorization']) {
        expect(second.headers.has(name), `${location} ${name}`).toBe(false);
      }
      expect(second.headers.get('x-keep')).toBe('yes');
    }

    const returning = createNetwork({ 'example.com': PUBLIC, 'other.example.org': PUBLIC }, (hop) => {
      if (hop.url === 'https://example.com/a') return redirectTo(302, 'https://other.example.org/b');
      if (hop.url === 'https://other.example.org/b') return redirectTo(302, 'https://example.com/c');
      return new Response('end');
    });
    await guardedFetch(crawlerRequest('https://example.com/a', { headers: { authorization: 'Bearer abc' } }), { fetch: returning.fetch, logger: createMockLogger() });
    expect(returning.hops.map((hop) => hop.headers.has('authorization'))).toEqual([true, false, false]);
  });

  it('does not send the header of the redirect mode on', async () => {
    const network = createNetwork({ 'example.com': PUBLIC });

    await guardedFetch(crawlerRequest('https://example.com/', {}, 'manual'), { fetch: network.fetch, logger: createMockLogger() });

    expect(network.hops[0].headers.has(REDIRECT_MODE_HEADER)).toBe(false);
  });
});

describe('logging', () => {
  it('names the hostname and a reason for each way a request is refused, and nothing of the URL, the query, the headers or the body', async () => {
    const logger = createMockLogger();
    const network = createNetwork({ 'internal.example.com': { A: ['10.1.2.3'] } });
    const attempts = [
      crawlerRequest('https://internal.example.com/private/path?api_key=SECRETKEY123', { headers: { authorization: 'Bearer SECRETTOKEN' } }),
      crawlerRequest('http://127.0.0.1:8080/admin?token=SECRETQUERY', { method: 'POST', body: 'SECRETBODY' }),
      crawlerRequest('http://foo.localhost/x?k=SECRETLOCAL'),
      crawlerRequest('https://unknown.example.com/p?k=SECRETDNS'),
    ];

    for (const attempt of attempts) {
      await expect(guardedFetch(attempt, { fetch: network.fetch, logger })).rejects.toThrow(TypeError);
    }

    expect(logger.warn.mock.calls.map((call) => (call[1] as { hostname: string }).hostname)).toEqual([
      'internal.example.com',
      '127.0.0.1',
      'foo.localhost',
      'unknown.example.com',
    ]);
    const logged = JSON.stringify([logger.debug.mock.calls, logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    for (const secret of ['SECRETKEY123', 'SECRETTOKEN', 'SECRETQUERY', 'SECRETBODY', 'SECRETLOCAL', 'SECRETDNS', 'private/path', '/admin', 'api_key', '8080', 'https://', 'http://']) {
      expect(logged, secret).not.toContain(secret);
    }
  });

  it('logs nothing for a request it lets through, and for the redirects it follows', async () => {
    const logger = createMockLogger();
    const network = createNetwork(
      { 'example.com': PUBLIC },
      (hop) => (hop.url === 'https://example.com/a?k=SECRET' ? redirectTo(302, 'https://example.com/b?k=SECRET2') : new Response('ok')),
    );

    await guardedFetch(crawlerRequest('https://example.com/a?k=SECRET'), { fetch: network.fetch, logger });

    expect([logger.debug, logger.info, logger.warn, logger.error].flatMap((method) => method.mock.calls)).toEqual([]);
  });
});
