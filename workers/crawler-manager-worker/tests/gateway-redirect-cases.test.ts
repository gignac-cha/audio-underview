import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { runLoadedCrawler } from '../sources/crawler-runtime/run-crawler.ts';
import { crawlerRow, createTestDependencies, uniqueUUID } from './runtime-harness.ts';

// Redirects and request headers the way crawler code meets them: through the real LOADER, its fetch wrapper
// and the real gateway entrypoint. Only the network behind the gateway (DNS over HTTPS and the sites) is a spy.

interface Hop {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

const PUBLIC_HOSTS = new Set(['example.com', 'other.example.org']);

let hops: Hop[];
let respond: (hop: Hop) => Response;

beforeEach(() => {
  hops = [];
  respond = () => new Response('from the network');
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? '';
      const isPublic = PUBLIC_HOSTS.has(name);
      const answer = url.searchParams.get('type') === 'A' && isPublic ? [{ name, type: 1, TTL: 60, data: '93.184.216.34' }] : [];
      return Response.json({ Status: 0, Answer: answer });
    }
    if (!PUBLIC_HOSTS.has(url.hostname)) {
      // Anything that is not a site of this file (the database, for example) keeps its own mock
      return originalFetch(input, init);
    }
    const body = init?.body === undefined || init.body === null ? null : await new Response(init.body as BodyInit).text();
    const hop: Hop = { url: url.toString(), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body };
    hops.push(hop);
    return respond(hop);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(code: string): Promise<CrawlerRunOutcome> {
  return runLoadedCrawler(createTestDependencies(), crawlerRow({ code }), {}, { userUUID: uniqueUUID() });
}

function resultOf(outcome: CrawlerRunOutcome): any {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'completed' });
  return outcome.status === 'completed' ? outcome.result : undefined;
}

function redirectTo(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

describe('a redirect of a request with a body', () => {
  it.each([307, 308])('hands a %i back to the code instead of sending the body, the Cookie and the Proxy-Authorization to another origin', async (status) => {
    respond = (hop) => (hop.url === 'https://example.com/upload' ? redirectTo(status, 'https://other.example.org/collect') : new Response('collected'));

    const outcome = await run(`async () => {
      const response = await fetch('https://example.com/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'session=1', 'proxy-authorization': 'Basic abc', authorization: 'Bearer token' },
        body: JSON.stringify({ secret: 'payload' }),
      });
      return { status: response.status, location: response.headers.get('location') };
    }`);

    expect(resultOf(outcome)).toEqual({ status, location: 'https://other.example.org/collect' });
    expect(hops.map((hop) => hop.url)).toEqual(['https://example.com/upload']);
    expect(hops[0]).toMatchObject({ method: 'POST', body: '{"secret":"payload"}' });
    expect(hops[0].headers.get('cookie')).toBe('session=1');
  });

  it('hands a 302 of a PUT with a body back to the code, whatever the origin', async () => {
    respond = (hop) => (hop.url === 'https://example.com/item' ? redirectTo(302, 'https://other.example.org/item') : new Response('moved'));

    const outcome = await run(`async () => {
      const response = await fetch('https://example.com/item', {
        method: 'PUT',
        headers: { cookie: 'session=1', 'proxy-authorization': 'Basic abc' },
        body: 'replacement',
      });
      return { status: response.status, location: response.headers.get('location') };
    }`);

    expect(resultOf(outcome)).toEqual({ status: 302, location: 'https://other.example.org/item' });
    expect(hops.map((hop) => [hop.method, hop.url, hop.body])).toEqual([['PUT', 'https://example.com/item', 'replacement']]);
  });

  it('follows a 303 of a POST as a GET without the body and the content headers, and without credentials to another origin', async () => {
    respond = (hop) => (hop.url === 'https://example.com/submit'
      ? redirectTo(303, 'https://other.example.org/result')
      : new Response(`${hop.method} arrived`));

    const outcome = await run(`async () => {
      const response = await fetch('https://example.com/submit', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'content-language': 'en',
          'content-encoding': 'identity',
          'content-location': '/submit',
          cookie: 'session=1',
          'proxy-authorization': 'Basic abc',
          authorization: 'Bearer token',
          'x-keep': 'yes',
        },
        body: 'payload',
      });
      return { status: response.status, text: await response.text() };
    }`);

    expect(resultOf(outcome)).toEqual({ status: 200, text: 'GET arrived' });
    expect(hops).toHaveLength(2);
    const [first, next] = hops;
    expect(first).toMatchObject({ method: 'POST', body: 'payload' });
    expect(first.headers.get('content-type')).toBe('text/plain');
    expect(next).toMatchObject({ method: 'GET', url: 'https://other.example.org/result', body: null });
    for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location', 'cookie', 'proxy-authorization', 'authorization']) {
      expect(next.headers.has(name), name).toBe(false);
    }
    expect(next.headers.get('x-keep')).toBe('yes');
  });

  it('follows a 303 of a PUT as a GET too, and a 302 of a POST', async () => {
    respond = (hop) => (hop.url.endsWith('/from') ? redirectTo(hop.method === 'PUT' ? 303 : 302, '/to') : new Response(hop.method));

    const outcome = await run(`async () => {
      const afterPut = await fetch('https://example.com/from', { method: 'PUT', body: 'x' });
      const afterPost = await fetch('https://example.com/from', { method: 'POST', body: 'x' });
      return [await afterPut.text(), await afterPost.text()];
    }`);

    expect(resultOf(outcome)).toEqual(['GET', 'GET']);
    expect(hops.map((hop) => hop.method)).toEqual(['PUT', 'GET', 'POST', 'GET']);
  });
});

describe('the redirect mode of the code', () => {
  it('hands the redirect back for redirect: manual, also with a Cookie and a Proxy-Authorization header, and does not ask where it leads', async () => {
    respond = () => redirectTo(302, 'https://other.example.org/end');

    const outcome = await run(`async () => {
      const response = await fetch('https://example.com/start', {
        redirect: 'manual',
        headers: { cookie: 'session=1', 'proxy-authorization': 'Basic abc', 'x-keep': 'yes' },
      });
      return { status: response.status, location: response.headers.get('location') };
    }`);

    expect(resultOf(outcome)).toEqual({ status: 302, location: 'https://other.example.org/end' });
    expect(hops.map((hop) => hop.url)).toEqual(['https://example.com/start']);
  });

  it('hands back a redirect to an address that is not allowed, as the code asked for manual, without requesting it', async () => {
    respond = () => redirectTo(301, 'http://169.254.169.254/latest/meta-data/');

    const outcome = await run(`async () => {
      const response = await fetch('https://example.com/start', { redirect: 'manual' });
      return [response.status, response.headers.get('location')];
    }`);

    expect(resultOf(outcome)).toEqual([301, 'http://169.254.169.254/latest/meta-data/']);
    expect(hops).toHaveLength(1);
  });

  it('takes redirect: manual from a Request too', async () => {
    respond = () => redirectTo(302, 'https://other.example.org/end');

    const outcome = await run(`async () => {
      const response = await fetch(new Request('https://example.com/start', { redirect: 'manual', headers: { cookie: 'session=1' } }));
      return response.status;
    }`);

    expect(resultOf(outcome)).toBe(302);
    expect(hops).toHaveLength(1);
  });

  it('lets the init of fetch override the redirect mode of its Request', async () => {
    respond = (hop) => (hop.url.endsWith('/start') ? redirectTo(302, '/next') : new Response('arrived'));

    const outcome = await run(`async () => {
      const response = await fetch(new Request('https://example.com/start', { redirect: 'manual' }), { redirect: 'follow' });
      return [response.status, await response.text()];
    }`);

    expect(resultOf(outcome)).toEqual([200, 'arrived']);
    expect(hops.map((hop) => hop.url)).toEqual(['https://example.com/start', 'https://example.com/next']);
  });

  it('throws a TypeError for redirect: error when the answer is a redirect, and requests nothing further', async () => {
    respond = () => redirectTo(302, 'https://other.example.org/end');

    const outcome = await run(`async () => {
      try {
        await fetch('https://example.com/start', { redirect: 'error', headers: { cookie: 'session=1' } });
        return 'fetched';
      } catch (error) {
        return [error.name, error.message];
      }
    }`);

    expect(resultOf(outcome)).toEqual(['TypeError', 'Redirect was not allowed']);
    expect(hops.map((hop) => hop.url)).toEqual(['https://example.com/start']);
  });

  it('answers redirect: error as usual when nothing redirects', async () => {
    respond = () => new Response('plain', { status: 200 });

    const outcome = await run(`async () => {
      const response = await fetch('https://example.com/plain', { redirect: 'error' });
      return [response.status, await response.text()];
    }`);

    expect(resultOf(outcome)).toEqual([200, 'plain']);
  });

  it('rejects a redirect value that is none of follow, manual and error', async () => {
    const outcome = await run(`async () => {
      try { await fetch('https://example.com/start', { redirect: 'sometimes' }); return 'fetched'; } catch (error) { return error.name; }
    }`);

    expect(resultOf(outcome)).toBe('TypeError');
    expect(hops).toEqual([]);
  });
});

describe('following redirects by default', () => {
  it('drops Authorization, Cookie and Proxy-Authorization when a redirect changes the origin, and keeps the other headers', async () => {
    respond = (hop) => (hop.url === 'https://example.com/start' ? redirectTo(302, 'https://other.example.org/end') : new Response('arrived'));

    const outcome = await run(`async () => {
      const response = await fetch('https://example.com/start', {
        headers: { cookie: 'session=1', 'proxy-authorization': 'Basic abc', authorization: 'Bearer token', 'x-keep': 'yes' },
      });
      return await response.text();
    }`);

    expect(resultOf(outcome)).toBe('arrived');
    expect(hops.map((hop) => hop.url)).toEqual(['https://example.com/start', 'https://other.example.org/end']);
    expect(hops[0].headers.get('proxy-authorization')).toBe('Basic abc');
    for (const name of ['cookie', 'proxy-authorization', 'authorization']) {
      expect(hops[1].headers.has(name), name).toBe(false);
    }
    expect(hops[1].headers.get('x-keep')).toBe('yes');
  });

  it('keeps the credentials on a redirect inside one origin', async () => {
    respond = (hop) => (hop.url === 'https://example.com/start' ? redirectTo(302, '/next') : new Response('arrived'));

    const outcome = await run(`async () => {
      const response = await fetch('https://example.com/start', { headers: { cookie: 'session=1', authorization: 'Bearer token' } });
      return await response.text();
    }`);

    expect(resultOf(outcome)).toBe('arrived');
    expect(hops.map((hop) => [hop.headers.get('cookie'), hop.headers.get('authorization')])).toEqual([
      ['session=1', 'Bearer token'],
      ['session=1', 'Bearer token'],
    ]);
  });

  it('checks every hop and refuses a redirect to a private address without requesting it', async () => {
    respond = (hop) => (hop.url === 'https://example.com/start' ? redirectTo(302, 'http://169.254.169.254/latest/meta-data/') : new Response('secret'));

    const outcome = await run(`async () => {
      try { await fetch('https://example.com/start'); return 'fetched'; } catch (error) { return [error.name, error.message]; }
    }`);

    expect(resultOf(outcome)).toEqual(['TypeError', "The address of '169.254.169.254' is not allowed"]);
    expect(hops.map((hop) => hop.url)).toEqual(['https://example.com/start']);
  });

  it('follows 20 redirects and refuses more', async () => {
    let step = 0;
    respond = () => (step < 20 ? redirectTo(302, `https://example.com/hop/${(step += 1)}`) : new Response('arrived'));

    const arrived = await run(`async () => (await fetch('https://example.com/hop/0')).text()`);

    expect(resultOf(arrived)).toBe('arrived');
    expect(hops).toHaveLength(21);

    hops = [];
    respond = () => redirectTo(302, 'https://example.com/again');

    const endless = await run(`async () => {
      try { await fetch('https://example.com/again'); return 'fetched'; } catch (error) { return [error.name, error.message]; }
    }`);

    expect(resultOf(endless)).toEqual(['TypeError', 'Too many redirects']);
    expect(hops).toHaveLength(21);
  });

  it('resolves a relative Location against the URL it came from', async () => {
    respond = (hop) => (hop.url.endsWith('/dir/start') ? redirectTo(302, '../next?x=1') : new Response('done'));

    const outcome = await run(`async () => (await fetch('https://example.com/dir/start')).text()`);

    expect(resultOf(outcome)).toBe('done');
    expect(hops.map((hop) => hop.url)).toEqual(['https://example.com/dir/start', 'https://example.com/next?x=1']);
  });

  it('hands back a 3xx without a Location as it is', async () => {
    respond = () => new Response(null, { status: 302 });

    const outcome = await run(`async () => (await fetch('https://example.com/start')).status`);

    expect(resultOf(outcome)).toBe(302);
    expect(hops).toHaveLength(1);
  });
});
