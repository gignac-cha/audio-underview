import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Environment } from '../sources/environment.ts';
import { crawlHackerNewsViaManager, crawlTextViaManager } from '../sources/crawler-client.ts';

const environment = env as unknown as Environment;

async function configureCrawler(name: string, input: unknown, answer: unknown): Promise<void> {
  await (environment.CRAWLER_MANAGER as unknown as Fetcher).fetch('https://stand-in.example.com/__test__/configure', {
    method: 'POST',
    body: JSON.stringify({ name, input, answer }),
  });
}

async function crawlerCalls(name: string): Promise<Array<{ name: string; input: { url: string } }>> {
  const response = await (environment.CRAWLER_MANAGER as unknown as Fetcher).fetch(`https://stand-in.example.com/__test__/calls?name=${name}`);
  return response.json();
}

describe('crawlTextViaManager', () => {
  it('answers the text a system crawler returns for the URL', async () => {
    const url = `https://example.com/${crypto.randomUUID()}`;
    await configureCrawler('article-content', { url }, { value: { type: 'web', result: 'The article' } });

    expect(await crawlTextViaManager(environment, 'article-content', url)).toBe('The article');
  });

  it('degrades to an empty text, and reports why, when the crawler fails or answers no text', async () => {
    const failingURL = `https://example.com/${crypto.randomUUID()}`;
    const objectURL = `https://example.com/${crypto.randomUUID()}`;
    await configureCrawler('geeknews-summary', { url: failingURL }, { error: '[execution_failed] broken' });
    await configureCrawler('geeknews-summary', { url: objectURL }, { value: { type: 'data', result: { text: 'x' } } });
    const reasons: string[] = [];

    expect(await crawlTextViaManager(environment, 'geeknews-summary', failingURL, (reason) => reasons.push(reason))).toBe('');
    expect(await crawlTextViaManager(environment, 'geeknews-summary', objectURL)).toBe('');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('[execution_failed] broken');
  });

  it('calls no crawler for an empty URL', async () => {
    const before = (await crawlerCalls('geeknews-summary')).length;

    expect(await crawlTextViaManager(environment, 'geeknews-summary', '')).toBe('');
    expect(await crawlerCalls('geeknews-summary')).toHaveLength(before);
  });
});

describe('crawlHackerNewsViaManager', () => {
  it('searches the story by its URL, then reads its comments', async () => {
    const originalUrl = `https://example.com/${crypto.randomUUID()}`;
    const searchUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(originalUrl)}&restrictSearchableAttributes=url&tags=story`;
    const itemsUrl = `https://hn.algolia.com/api/v1/items/${crypto.randomUUID()}`;
    await configureCrawler('hn-search', { url: searchUrl }, { value: { type: 'data', result: { objectID: '1', itemsUrl } } });
    await configureCrawler('hn-items', { url: itemsUrl }, { value: { type: 'data', result: 'Top comments' } });

    expect(await crawlHackerNewsViaManager(environment, originalUrl)).toBe('Top comments');
  });

  it('degrades to an empty text when no story matches', async () => {
    const originalUrl = `https://example.com/${crypto.randomUUID()}`;
    const searchUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(originalUrl)}&restrictSearchableAttributes=url&tags=story`;
    await configureCrawler('hn-search', { url: searchUrl }, { value: { type: 'data', result: null } });

    expect(await crawlHackerNewsViaManager(environment, originalUrl)).toBe('');
  });
});
