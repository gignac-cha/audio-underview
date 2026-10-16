import { describe, it, expect, afterEach, vi } from 'vitest';
import { CrawlerOutboundGateway, guardedFetch, REDIRECT_MODE_HEADER } from '../sources/crawler-runtime/outbound-gateway.ts';
import { runCrawler } from '../sources/crawler-runtime/run-crawler.ts';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import { SUPABASE_ORIGIN, addCrawler, crawlerRow, createMockLogger, createTestDependencies, uniqueUUID } from './runtime-harness.ts';
import { http, HttpResponse } from 'msw';
import { appendHandlers, network, requestMatching } from '@audio-underview/worker-tools/tests/network.ts';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: string | undefined;
}

type Route = (request: SentRequest) => Response | Promise<Response>;

const PUBLIC_ADDRESSES: Record<string, { A?: string[]; AAAA?: string[] }> = {
  'api.example.com': { A: ['93.184.216.34'] },
  'other.example.com': { A: ['93.184.216.35'], AAAA: ['2606:2800:220:1:248:1893:25c8:1946'] },
  'private.example.com': { A: ['93.184.216.36', '10.0.0.5'] },
  'private6.example.com': { AAAA: ['fd00::5'] },
  'cname.example.com': {},
};

/**
 * A network for guardedFetch: DNS over HTTPS answers from PUBLIC_ADDRESSES, every other request goes to route.
 */
function createNetwork(route: Route, options: { dnsFailure?: boolean; cnameOnly?: boolean } = {}) {
  const sent: SentRequest[] = [];
  const dnsQueries: string[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin === 'https://cloudflare-dns.com') {
      dnsQueries.push(input);
      expect(new Headers(init.headers).get('accept')).toBe('application/dns-json');
      if (options.dnsFailure) throw new Error('DNS over HTTPS is unreachable');
      const name = url.searchParams.get('name') as string;
      const type = url.searchParams.get('type') as 'A' | 'AAAA';
      const records = PUBLIC_ADDRESSES[name];
      if (records === undefined) return Response.json({ Status: 3 });
      if (name === 'cname.example.com' || options.cnameOnly) {
        return Response.json({ Status: 0, Answer: [{ name, type: 5, TTL: 60, data: 'target.example.net.' }] });
      }
      const answer = (records[type] ?? []).map((data) => ({ name, type: type === 'A' ? 1 : 28, TTL: 60, data }));
      return Response.json({ Status: 0, Answer: answer });
    }
    const request = new Request(input, init);
    const sentRequest: SentRequest = {
      url: input,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body === null ? null : await request.text(),
      redirect: init.redirect,
    };
    sent.push(sentRequest);
    return route(sentRequest);
  };
  return { fetch, sent, dnsQueries };
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

function crawlerRequest(url: string, init: RequestInit = {}, mode?: 'follow' | 'manual' | 'error'): Request {
  const request = new Request(url, { ...init, redirect: 'manual' });
  if (mode !== undefined) request.headers.set(REDIRECT_MODE_HEADER, mode);
  return request;
}

describe('guardedFetch', () => {
  it.each([
    ['127.0.0.1'], ['10.0.0.1'], ['100.64.0.1'], ['[::1]'], ['[::]'], ['[::ffff:7f00:1]'], ['[::ffff:127.0.0.1]'],
    ['[::7f00:1]'], ['[64:ff9b::a00:1]'], ['[fd00::1]'], ['0x7f.1'], ['2130706433'], ['169.254.169.254'],
  ])('blocks the IP literal %s without a DNS query', async (host) => {
    const network = createNetwork(() => new Response('reached'));
    const url = new URL(`http://${host}/path?key=secret`);

    await expect(guardedFetch(crawlerRequest(`http://${host}/path?key=secret`), { fetch: network.fetch, logger: createMockLogger() }))
      .rejects.toThrow(new TypeError(`The address of '${url.hostname}' is not allowed`));
    expect(network.sent).toEqual([]);
    expect(network.dnsQueries).toEqual([]);
  });

  it.each(['localhost', 'localhost.', 'foo.localhost', 'LOCALHOST', 'a.b.localhost.'])('blocks %s', async (host) => {
    const network = createNetwork(() => new Response('reached'));

    await expect(guardedFetch(crawlerRequest(`https://${host}/`), { fetch: network.fetch, logger: createMockLogger() }))
      .rejects.toThrow(TypeError);
    await expect(guardedFetch(crawlerRequest(`https://${host}/`), { fetch: network.fetch, logger: createMockLogger() }))
      .rejects.toThrow(/^The address of '.+' is not allowed$/);
    expect(network.sent).toEqual([]);
    expect(network.dnsQueries).toEqual([]);
  });

  it('blocks a protocol other than http: and https:', async () => {
    const network = createNetwork(() => new Response('reached'));

    await expect(guardedFetch(crawlerRequest('ftp://files.example.com/a'), { fetch: network.fetch, logger: createMockLogger() }))
      .rejects.toThrow(new TypeError("Protocol 'ftp:' is not allowed. Only http: and https: are permitted"));
    expect(network.sent).toEqual([]);
  });

  it('blocks a name with a private address among its addresses', async () => {
    const network = createNetwork(() => new Response('reached'));

    for (const host of ['private.example.com', 'private6.example.com']) {
      await expect(guardedFetch(crawlerRequest(`https://${host}/`), { fetch: network.fetch, logger: createMockLogger() }))
        .rejects.toThrow(new TypeError(`The address of '${host}' is not allowed`));
    }
    expect(network.sent).toEqual([]);
  });

  it('asks DNS over HTTPS for A and AAAA records of a name', async () => {
    const network = createNetwork(() => new Response('ok'));

    await guardedFetch(crawlerRequest('https://api.example.com/'), { fetch: network.fetch, logger: createMockLogger() });

    expect(network.dnsQueries.sort()).toEqual([
      'https://cloudflare-dns.com/dns-query?name=api.example.com&type=A',
      'https://cloudflare-dns.com/dns-query?name=api.example.com&type=AAAA',
    ]);
  });

  it('fails the lookup when DNS over HTTPS fails, when a name has no address, and for a CNAME alone', async () => {
    for (const [host, options] of [
      ['api.example.com', { dnsFailure: true }],
      ['missing.example.com', {}],
      ['cname.example.com', {}],
      ['api.example.com', { cnameOnly: true }],
    ] as const) {
      const network = createNetwork(() => new Response('reached'), options);

      await expect(guardedFetch(crawlerRequest(`https://${host}/`), { fetch: network.fetch, logger: createMockLogger() }))
        .rejects.toThrow(new TypeError(`DNS lookup failed for '${host}'`));
      expect(network.sent).toEqual([]);
    }
  });

  it('fails the lookup when DNS over HTTPS answers an error status', async () => {
    const fetch = async (input: string): Promise<Response> => (input.startsWith('https://cloudflare-dns.com/')
      ? new Response('busy', { status: 503 })
      : new Response('reached'));

    await expect(guardedFetch(crawlerRequest('https://api.example.com/'), { fetch, logger: createMockLogger() }))
      .rejects.toThrow("DNS lookup failed for 'api.example.com'");
  });

  it('sends a request to a public address with its method, headers and body, redirect manual, without the mode header', async () => {
    const network = createNetwork(() => new Response('created', { status: 201 }));

    const response = await guardedFetch(
      crawlerRequest('https://api.example.com/v1/speech?format=mp3', {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: '{"text":"hello"}',
      }, 'follow'),
      { fetch: network.fetch, logger: createMockLogger() },
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('created');
    expect(network.sent).toEqual([{
      url: 'https://api.example.com/v1/speech?format=mp3',
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: '{"text":"hello"}',
      redirect: 'manual',
    }]);
  });

  it('follows a 303 as a GET without the body and the content headers', async () => {
    const network = createNetwork((request) => (request.url.endsWith('/submit')
      ? redirect(303, '/result')
      : new Response(`result of ${request.method}`)));

    const response = await guardedFetch(
      crawlerRequest('https://api.example.com/submit', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'content-language': 'en',
          'content-encoding': 'identity',
          'content-location': '/x',
          authorization: 'Bearer token',
        },
        body: 'payload',
      }),
      { fetch: network.fetch, logger: createMockLogger() },
    );

    expect(await response.text()).toBe('result of GET');
    expect(network.sent[1]).toEqual({
      url: 'https://api.example.com/result',
      method: 'GET',
      headers: { authorization: 'Bearer token' },
      body: null,
      redirect: 'manual',
    });
  });

  it('follows a 301 or 302 of a POST as a GET, and keeps the method of a GET', async () => {
    for (const status of [301, 302]) {
      const network = createNetwork((request) => (request.url.endsWith('/old') ? redirect(status, '/new') : new Response(request.method)));

      const post = await guardedFetch(crawlerRequest('https://api.example.com/old', { method: 'POST', body: 'x' }), { fetch: network.fetch, logger: createMockLogger() });
      const get = await guardedFetch(crawlerRequest('https://api.example.com/old'), { fetch: network.fetch, logger: createMockLogger() });

      expect(await post.text()).toBe('GET');
      expect(await get.text()).toBe('GET');
    }
  });

  it('follows a 307 or 308 without a body, keeping the method', async () => {
    for (const status of [307, 308]) {
      const network = createNetwork((request) => (request.url.endsWith('/old') ? redirect(status, '/new') : new Response(request.method)));

      const response = await guardedFetch(crawlerRequest('https://api.example.com/old', { method: 'DELETE' }), { fetch: network.fetch, logger: createMockLogger() });

      expect(await response.text()).toBe('DELETE');
    }
  });

  it('returns a 307 or 308 of a request with a body as it is, since the body cannot be sent again', async () => {
    for (const status of [307, 308]) {
      const network = createNetwork(() => redirect(status, '/new'));

      const response = await guardedFetch(crawlerRequest('https://api.example.com/old', { method: 'POST', body: 'payload' }), { fetch: network.fetch, logger: createMockLogger() });

      expect(response.status).toBe(status);
      expect(response.headers.get('location')).toBe('/new');
      expect(network.sent).toHaveLength(1);
    }
  });

  it('removes authorization, cookie and proxy-authorization when a redirect changes the origin', async () => {
    const network = createNetwork((request) => (request.url.startsWith('https://api.example.com/')
      ? redirect(302, 'https://other.example.com/landing')
      : new Response('landed')));

    await guardedFetch(
      crawlerRequest('https://api.example.com/start', { headers: { authorization: 'Bearer token', cookie: 'session=1', 'proxy-authorization': 'Basic x', 'x-custom': 'kept' } }),
      { fetch: network.fetch, logger: createMockLogger() },
    );

    expect(network.sent[1].url).toBe('https://other.example.com/landing');
    expect(network.sent[1].headers).toEqual({ 'x-custom': 'kept' });
  });

  it('keeps the credentials when a redirect stays on the same origin', async () => {
    const network = createNetwork((request) => (request.url.endsWith('/start') ? redirect(302, '/next') : new Response('next')));

    await guardedFetch(
      crawlerRequest('https://api.example.com/start', { headers: { authorization: 'Bearer token', cookie: 'session=1' } }),
      { fetch: network.fetch, logger: createMockLogger() },
    );

    expect(network.sent[1].headers).toEqual({ authorization: 'Bearer token', cookie: 'session=1' });
  });

  it('treats a change of scheme or port as another origin', async () => {
    for (const location of ['http://api.example.com/next', 'https://api.example.com:8443/next']) {
      const network = createNetwork((request) => (request.url.endsWith('/start') ? redirect(302, location) : new Response('next')));

      await guardedFetch(crawlerRequest('https://api.example.com/start', { headers: { authorization: 'Bearer token' } }), { fetch: network.fetch, logger: createMockLogger() });

      expect(network.sent[1].headers).toEqual({});
    }
  });

  it('checks every redirect target and blocks one to a private address', async () => {
    for (const location of ['http://127.0.0.1/admin', 'http://[::ffff:7f00:1]/', 'https://private.example.com/', 'http://localhost/', 'ftp://api.example.com/']) {
      const network = createNetwork(() => redirect(302, location));

      await expect(guardedFetch(crawlerRequest('https://api.example.com/start'), { fetch: network.fetch, logger: createMockLogger() }))
        .rejects.toThrow(TypeError);
      expect(network.sent).toHaveLength(1);
    }
  });

  it('follows 20 redirects and refuses the 21st', async () => {
    const twenty = createNetwork((request) => {
      const step = Number(new URL(request.url).searchParams.get('step') ?? '0');
      return step < 20 ? redirect(302, `/hop?step=${step + 1}`) : new Response('arrived');
    });
    const response = await guardedFetch(crawlerRequest('https://api.example.com/hop'), { fetch: twenty.fetch, logger: createMockLogger() });
    expect(await response.text()).toBe('arrived');
    expect(twenty.sent).toHaveLength(21);

    const endless = createNetwork(() => redirect(302, '/again'));
    await expect(guardedFetch(crawlerRequest('https://api.example.com/again'), { fetch: endless.fetch, logger: createMockLogger() }))
      .rejects.toThrow(new TypeError('Too many redirects'));
    expect(endless.sent).toHaveLength(21);
  });

  it('returns the redirect as it is in manual mode', async () => {
    const network = createNetwork(() => redirect(302, 'http://127.0.0.1/'));

    const response = await guardedFetch(crawlerRequest('https://api.example.com/start', {}, 'manual'), { fetch: network.fetch, logger: createMockLogger() });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://127.0.0.1/');
    expect(network.sent).toHaveLength(1);
  });

  it('throws on a redirect in error mode', async () => {
    const network = createNetwork(() => redirect(302, '/next'));

    await expect(guardedFetch(crawlerRequest('https://api.example.com/start', {}, 'error'), { fetch: network.fetch, logger: createMockLogger() }))
      .rejects.toThrow(new TypeError('Redirect was not allowed'));
  });

  it('logs only the hostname and the reason of a blocked request', async () => {
    const logger = createMockLogger();
    const network = createNetwork(() => redirect(302, 'http://10.0.0.1/internal?token=query-secret'));

    await expect(guardedFetch(crawlerRequest('https://api.example.com/start?key=query-secret', { headers: { authorization: 'Bearer header-secret' } }), { fetch: network.fetch, logger }))
      .rejects.toThrow(TypeError);
    await expect(guardedFetch(crawlerRequest('http://127.0.0.1/path?key=query-secret'), { fetch: network.fetch, logger }))
      .rejects.toThrow(TypeError);

    expect(logger.warn.mock.calls).toEqual([
      ['Outbound request blocked', { hostname: '10.0.0.1', reason: 'address' }, { function: 'guardedFetch' }],
      ['Outbound request blocked', { hostname: '127.0.0.1', reason: 'address' }, { function: 'guardedFetch' }],
    ]);
    const logged = JSON.stringify([logger.debug.mock.calls, logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    for (const text of ['query-secret', 'header-secret', '/internal', '/path', '/start']) {
      expect(logged).not.toContain(text);
    }
  });
});

describe('fetch inside crawler code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(code: string) {
    const crawler = addCrawler(supabase, crawlerRow({ code }));
    return runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: uniqueUUID() });
  }

  // Every request and every redirect hop asks again
  function mockDNS(host: string, address: string) {
    for (const type of ['A', 'AAAA']) {
      appendHandlers(
        network,
        http.all(
          requestMatching('https://cloudflare-dns.com', { path: `/dns-query?name=${host}&type=${type}`, method: 'GET' }),
          () => HttpResponse.json({ Status: 0, Answer: type === 'A' ? [{ name: host, type: 1, TTL: 60, data: address }] : [] }),
        ),
      );
    }
  }

  it('throws a TypeError for a blocked address', async () => {
    const outcome = await run(`async (input) => {
      const errors = [];
      for (const url of ['http://127.0.0.1/', 'http://[::ffff:7f00:1]/', 'http://localhost./', 'ftp://example.com/']) {
        try { await fetch(url); errors.push('fetched'); } catch (error) { errors.push(error.name + ': ' + error.message); }
      }
      return errors;
    }`);

    expect(outcome).toMatchObject({
      status: 'completed',
      result: [
        "TypeError: The address of '127.0.0.1' is not allowed",
        "TypeError: The address of '[::ffff:7f00:1]' is not allowed",
        "TypeError: The address of 'localhost.' is not allowed",
        // workerd refuses the scheme itself before the gateway
        expect.stringMatching(/^TypeError: /),
      ],
    });
  });

  it('reaches a public address through the gateway and follows redirects there', async () => {
    mockDNS('api.example.com', '93.184.216.34');
    appendHandlers(
      network,
      http.all(
        requestMatching('https://api.example.com', { path: '/v1/items?key=query-key', method: 'GET' }),
        () => new HttpResponse(null, { status: 302, headers: { location: 'https://api.example.com/v1/items/final' } }),
        { once: true },
      ),
    );
    appendHandlers(
      network,
      http.all(
        requestMatching('https://api.example.com', { path: '/v1/items/final', method: 'GET' }),
        () => HttpResponse.json({ items: [1, 2] }),
        { once: true },
      ),
    );

    const outcome = await run(`async (input) => {
      const response = await fetch('https://api.example.com/v1/items?key=query-key');
      return { status: response.status, body: await response.json() };
    }`);

    expect(outcome).toMatchObject({ status: 'completed', result: { status: 200, body: { items: [1, 2] } } });
  });

  it('passes the redirect mode of the code to the gateway', async () => {
    mockDNS('api.example.com', '93.184.216.34');
    appendHandlers(
      network,
      ...Array.from({ length: 2 }, () => http.all(
        requestMatching('https://api.example.com', { path: '/moved', method: 'GET' }),
        () => new HttpResponse(null, { status: 301, headers: { location: 'https://api.example.com/elsewhere' } }),
        { once: true },
      )),
    );

    const outcome = await run(`async (input) => {
      const manual = await fetch('https://api.example.com/moved', { redirect: 'manual' });
      let error;
      try { await fetch(new Request('https://api.example.com/moved'), { redirect: 'error' }); } catch (caught) { error = caught.name + ': ' + caught.message; }
      return { manual: [manual.status, manual.headers.get('location')], error };
    }`);

    expect(outcome).toMatchObject({
      status: 'completed',
      result: { manual: [301, 'https://api.example.com/elsewhere'], error: 'TypeError: Redirect was not allowed' },
    });
  });

  it('cannot open a socket with connect()', async () => {
    // workerd opens a socket of the code through the gateway when the gateway has any connect member
    expect('connect' in CrawlerOutboundGateway.prototype).toBe(false);

    // The gateway has no connect(), so the runtime refuses the socket. A test runner that gives every
    // entrypoint a connect() lets it open, but the socket then ends before any data arrives.
    const outcome = await run(`async (input) => {
      const { connect } = await import('cloudflare:sockets');
      let socket;
      try {
        socket = connect('example.com:443');
        await socket.opened;
      } catch {
        return { opened: false };
      }
      try {
        const { done, value } = await socket.readable.getReader().read();
        return { opened: true, ended: done, bytes: value === undefined ? 0 : value.byteLength };
      } catch {
        return { opened: true, ended: true, bytes: 0 };
      } finally {
        socket.close().catch(() => {});
      }
    }`);

    expect(outcome).toMatchObject({ status: 'completed' });
    const result = (outcome as { result: { opened: boolean; ended?: boolean; bytes?: number } }).result;
    expect(result.opened === false || (result.ended === true && result.bytes === 0), JSON.stringify(result)).toBe(true);
  });

  it('receives nothing over a node:net socket either, which the Node.js APIs of the compatibility date give the code', async () => {
    // node:net opens its sockets with connect() of the runtime, so the same refusal applies
    const outcome = await run(`async (input) => {
      const net = require('node:net');
      return new Promise((resolve) => {
        let connected = false;
        let bytes = 0;
        const socket = net.connect(80, 'example.com');
        const finish = () => resolve({ connected, bytes });
        socket.on('connect', () => {
          connected = true;
          socket.write('GET / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n');
        });
        socket.on('data', (data) => { bytes += data.length; });
        socket.on('error', finish);
        socket.on('close', finish);
        setTimeout(() => { socket.destroy(); finish(); }, 5_000);
      });
    }`);

    expect(outcome).toMatchObject({ status: 'completed', result: { bytes: 0 } });
  });
});
