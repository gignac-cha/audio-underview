import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

// Must import handler after vi.mock so the mock is applied
const { handler } = await import('../sources/index.ts');

process.env.ALLOWED_ORIGINS = 'https://example.com';

const MIGRATION_URL = new URL('../../../packages/supabase-connector/migrations/010_create_system_crawlers.sql', import.meta.url);

const SYSTEM_CRAWLER_PATTERN = /VALUES \('[0-9a-f-]+', '([a-z-]+)', 'web', '[^']*', \$system_crawler\$([\s\S]*?)\$system_crawler\$\);/g;

// documents/migration/03-system-crawlers.md §3
const EXPECTED_SYSTEM_CRAWLERS = [
  { name: 'geeknews-list', urlPattern: String.raw`^https://news\.hada\.io.*$`, length: 1910, sha256: '97079ddee9bb08be76d01050ba3833c4b561bb49e950cac0899b08ae490771a0' },
  { name: 'geeknews-summary', urlPattern: String.raw`^https://news\.hada\.io/topic.*$`, length: 2391, sha256: '2b91aaa302aad451120713c68f08ca2221b313d9c0f8d00c91d2030165a132b3' },
  { name: 'article-content', urlPattern: String.raw`^https?://.+$`, length: 2376, sha256: 'd45bbc28529f3eb72e6aeff7c4c8b1d07a091380b70237bc577913df82419d60' },
  { name: 'hn-search', urlPattern: String.raw`^https://hn\.algolia\.com/api/v1/search.*$`, length: 527, sha256: '6309c591c3e556dd870434fb6ed88ab06f22df637f41759ea6f7977493238ee7' },
  { name: 'hn-items', urlPattern: String.raw`^https://hn\.algolia\.com/api/v1/items/.*$`, length: 1919, sha256: 'dddd2e1fbe9d880490f4ef5f9bfcc4799eee5a9d10fa0841bdda0bb6bcab92ef' },
];

// Any URL that matches the crawler's url_pattern; the fetch stub ignores it.
const SYSTEM_CRAWLER_URLS: Record<string, string> = {
  'geeknews-list': 'https://news.hada.io/',
  'geeknews-summary': 'https://news.hada.io/topic?id=101',
  'article-content': 'https://example.com/posts/first',
  'hn-search': 'https://hn.algolia.com/api/v1/search?query=https%3A%2F%2Fexample.com%2Fposts%2Ffirst&restrictSearchableAttributes=url&tags=story',
  'hn-items': 'https://hn.algolia.com/api/v1/items/2',
};

const SYSTEM_CRAWLER_CASES = [
  {
    name: 'geeknews-list',
    body:
      "<div class='topic_row' data-topic-state-id='101' data-topic-voteable='1'><div class=votenum>1</div><div class=topictitle><a href='https://example.com/posts/first' rel='nofollow' id='tr1' class='topic-title-link'><h2 class='topic-title-heading'>First &amp; <b>bold</b>  title</h2></a></div></div>\n" +
      "<div class='topic_row' data-topic-state-id='102'><div class=topictitle><a href='topic?id=102' class='topic-title-link'><h2 class='topic-title-heading'>Ask GN: second</h2></a></div></div>\n" +
      "<div class='topic_row' data-topic-state-id='103'><div class=topictitle>no heading</div></div>",
    expected: [
      { title: 'First & bold title', discussionUrl: 'https://news.hada.io/topic?id=101', originalUrl: 'https://example.com/posts/first' },
      { title: 'Ask GN: second', discussionUrl: 'https://news.hada.io/topic?id=102', originalUrl: 'https://news.hada.io/topic?id=102' },
    ],
  },
  { name: 'geeknews-list', body: 'Forbidden', expected: [] },
  {
    name: 'geeknews-summary',
    body:
      "<div class=topic_contents><div><section id='topic_contents' class='article-content'><ul>\n<li>First <strong>point</strong> &amp; more</li>\n<li>Second point</li>\n</ul></section></div><div id='comment_thread' class='comment_thread'><div class='comment'>reader comment</div></div></div>",
    expected: 'First point & more\n\nSecond point',
  },
  {
    name: 'geeknews-summary',
    body: "<div id='topic_contents'><p>Older layout</p><div class='nested'>inner</div></div><div id='comment_thread'>reader comment</div>",
    expected: 'Older layout\ninner',
  },
  { name: 'geeknews-summary', body: '<html><body>no summary here</body></html>', expected: '' },
  {
    name: 'article-content',
    body:
      '<html><head><title>x</title><style>p{}</style></head><body><nav>menu</nav><article><h1>Title</h1><p>First&nbsp;paragraph.</p><script>var a=1</script><p>Second<br>line</p></article><footer>foot</footer></body></html>',
    expected: 'Title\nFirst paragraph.\nSecond\nline',
  },
  { name: 'article-content', body: '<html><body><p>No article tag</p><aside>side</aside></body></html>', expected: 'No article tag' },
  { name: 'article-content', body: 'plain text without tags', expected: '' },
  {
    name: 'hn-search',
    body: '{"hits":[{"objectID":"1","points":5},{"objectID":"2","points":40},{"points":99}]}',
    expected: { objectID: '2', itemsUrl: 'https://hn.algolia.com/api/v1/items/2' },
  },
  { name: 'hn-search', body: '{"hits":[]}', expected: null },
  { name: 'hn-search', body: 'not json', expected: null },
  {
    name: 'hn-items',
    body:
      '{"children":[{"author":"a","text":"<p>First &amp; top</p>","children":[{"author":"b","text":"reply<br>here","children":[]}]},{"author":null,"text":"deleted"},{"author":"c","text":"second top"}]}',
    expected: 'First & top\nsecond top\nreply here',
  },
  { name: 'hn-items', body: '{"children":[]}', expected: '' },
  { name: 'hn-items', body: 'not json', expected: '' },
];

function readSystemCrawlers(): { name: string; code: string }[] {
  const migration = readFileSync(MIGRATION_URL, 'utf-8');
  return Array.from(migration.matchAll(SYSTEM_CRAWLER_PATTERN), (match) => ({ name: match[1], code: match[2].trim() }));
}

const systemCrawlers = readSystemCrawlers();

function findSystemCrawlerCode(name: string): string {
  const systemCrawler = systemCrawlers.find((candidate) => candidate.name === name);
  if (systemCrawler === undefined) {
    throw new Error(`System crawler '${name}' is missing from the migration`);
  }
  return systemCrawler.code;
}

async function runSystemCrawler(name: string, fetchedBody: string): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status: 200,
    text: () => Promise.resolve(fetchedBody),
  }));

  const response = await handler({
    version: '2.0',
    requestContext: {
      http: {
        method: 'POST',
        path: '/run',
      },
    },
    headers: {
      origin: 'https://example.com',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'web',
      mode: 'run',
      url: SYSTEM_CRAWLER_URLS[name],
      code: findSystemCrawlerCode(name),
    }),
    isBase64Encoded: false,
  });

  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body).result;
}

describe('system crawlers', () => {
  describe('migration', () => {
    it('contains the five system crawlers', () => {
      expect(systemCrawlers.map((systemCrawler) => systemCrawler.name)).toEqual(
        EXPECTED_SYSTEM_CRAWLERS.map((expectedSystemCrawler) => expectedSystemCrawler.name),
      );
    });

    it.each(EXPECTED_SYSTEM_CRAWLERS)('$name code has the documented length and SHA-256', ({ name, length, sha256 }) => {
      const code = findSystemCrawlerCode(name);

      expect(code.length).toBe(length);
      expect(createHash('sha256').update(code).digest('hex')).toBe(sha256);
    });

    it.each(EXPECTED_SYSTEM_CRAWLERS)('$name code is ASCII only', ({ name }) => {
      expect(findSystemCrawlerCode(name)).not.toMatch(/[^\x00-\x7f]/);
    });

    it.each(EXPECTED_SYSTEM_CRAWLERS)('$name test URL matches its url_pattern', ({ name, urlPattern }) => {
      expect(SYSTEM_CRAWLER_URLS[name]).toMatch(new RegExp(urlPattern));
    });
  });

  describe('results', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each(SYSTEM_CRAWLER_CASES)('case %$: $name', async ({ name, body, expected }) => {
      expect(await runSystemCrawler(name, body)).toEqual(expected);
    });
  });

  describe('limits', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('article-content returns at most 24000 characters', async () => {
      const result = await runSystemCrawler('article-content', '<article>' + 'a'.repeat(30000) + '</article>');

      expect(typeof result).toBe('string');
      expect((result as string).length).toBe(24000);
    });

    it('geeknews-summary returns at most 8000 characters', async () => {
      const result = await runSystemCrawler('geeknews-summary', '<div class=topic_contents>' + 'b'.repeat(9000) + '</div>');

      expect(typeof result).toBe('string');
      expect((result as string).length).toBe(8000);
    });

    it('hn-items returns at most 60 comments', async () => {
      const children = Array.from({ length: 80 }, (_, index) => ({ author: 'u', text: `comment ${index + 1}` }));
      const result = await runSystemCrawler('hn-items', JSON.stringify({ children }));

      expect(typeof result).toBe('string');
      expect((result as string).split('\n')).toHaveLength(60);
    });
  });
});
