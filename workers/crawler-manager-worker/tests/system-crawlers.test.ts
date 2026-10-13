import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { SYSTEM_USER_UUID } from '@audio-underview/supabase-connector';
import migration from '../../../packages/supabase-connector/migrations/010_create_system_crawlers.sql?raw';
import type CrawlerManagerWorker from '../sources/index.ts';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import { SUPABASE_ORIGIN, crawlerRow, mockPageBody } from './runtime-harness.ts';

// The fixed inputs and expected results of functions/crawler-code-runner-function/tests/system-crawlers.test.ts,
// run on the Dynamic Worker runtime. The page still comes from the code runner Lambda, so the requests to
// the real sites do not change. The length and SHA-256 of the code stay checked in the Lambda tests.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);
const crawlerManager = SELF as unknown as Service<typeof CrawlerManagerWorker>;

const SYSTEM_CRAWLER_PATTERN = /VALUES \('[0-9a-f-]+', '([a-z-]+)', 'web', '([^']*)', \$system_crawler\$([\s\S]*?)\$system_crawler\$\);/g;

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

const systemCrawlers = Array.from(migration.matchAll(SYSTEM_CRAWLER_PATTERN), (match) => ({
  name: match[1],
  urlPattern: match[2],
  code: match[3].trim(),
}));

async function runSystemCrawler(name: string, pageBody: string): Promise<unknown> {
  const systemCrawler = systemCrawlers.find((candidate) => candidate.name === name);
  if (systemCrawler === undefined) {
    throw new Error(`System crawler '${name}' is missing from the migration`);
  }
  supabase.tables.crawlers = [crawlerRow({
    user_uuid: SYSTEM_USER_UUID,
    name,
    type: 'web',
    url_pattern: systemCrawler.urlPattern,
    code: systemCrawler.code,
    input_schema: { body: 'string' },
  })];
  const page = mockPageBody(pageBody);

  const response = await crawlerManager.executeCrawlerByName(name, { url: SYSTEM_CRAWLER_URLS[name] });

  // The page is fetched exactly as before: the Lambda gets the URL and returns the body
  expect(page.requests).toEqual([{ type: 'web', mode: 'run', url: SYSTEM_CRAWLER_URLS[name], code: '(body) => body' }]);
  expect(response.type).toBe('web');
  return response.result;
}

describe('system crawlers on the Dynamic Worker runtime', () => {
  it('reads the five system crawlers from migration 010', () => {
    expect(systemCrawlers.map((systemCrawler) => systemCrawler.name)).toEqual([
      'geeknews-list',
      'geeknews-summary',
      'article-content',
      'hn-search',
      'hn-items',
    ]);
  });

  it.each(SYSTEM_CRAWLER_CASES)('case %$: $name', async ({ name, body, expected }) => {
    expect(await runSystemCrawler(name, body)).toEqual(expected);
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
