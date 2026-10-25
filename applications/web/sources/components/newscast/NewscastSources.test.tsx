import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import type { Article } from '@audio-underview/newscast-core';
import { NewscastSources } from './NewscastSources.tsx';

const GEEKNEWS_ARTICLE: Article = {
  title: 'A GeekNews article',
  originalUrl: 'https://example.com/original',
  discussionUrl: 'https://news.hada.io/topic',
  content: 'Body',
};

const URL_ARTICLE: Article = {
  title: 'An article read from a URL',
  originalUrl: 'https://example.com/from-url',
  discussionUrl: '',
  content: 'Body',
};

const PASTED_ARTICLE: Article = {
  title: 'A pasted article',
  originalUrl: '',
  discussionUrl: '',
  content: 'Pasted body',
};

describe('NewscastSources', () => {
  test('renders the two source links for a GeekNews article', async () => {
    await render(<NewscastSources sources={[GEEKNEWS_ARTICLE]} />);

    await expect.element(page.getByRole('link', { name: /A GeekNews article/ })).toHaveAttribute('href', 'https://example.com/original');
    await expect.element(page.getByRole('link', { name: /GeekNews discussion/ })).toHaveAttribute('href', 'https://news.hada.io/topic');
    expect(page.getByText('Direct input').query()).toBeNull();
  });

  test('renders no discussion link for an article without one', async () => {
    await render(<NewscastSources sources={[URL_ARTICLE]} />);

    await expect.element(page.getByRole('link', { name: /An article read from a URL/ })).toHaveAttribute('href', 'https://example.com/from-url');
    expect(page.getByRole('link', { name: /GeekNews discussion/ }).query()).toBeNull();
    expect(page.getByRole('link').elements()).toHaveLength(1);
  });

  test.each([
    ['javascript:', 'javascript:alert(document.domain)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['a relative', '/settings'],
    ['an unreadable', 'not a url'],
  ])('links no %s URL, and shows the title as text', async (_, url) => {
    const { container } = await render(
      <NewscastSources sources={[{ title: 'A crawled article', originalUrl: url, discussionUrl: url, content: 'Body' }]} />,
    );

    await expect.element(page.getByText('A crawled article')).toBeInTheDocument();
    expect(page.getByRole('link').query()).toBeNull();
    expect(page.getByText('GeekNews discussion').query()).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
  });

  test('links the http URL of an article whose discussion URL is not http(s)', async () => {
    await render(
      <NewscastSources
        sources={[{ title: 'Half linked', originalUrl: 'http://example.com/a', discussionUrl: 'javascript:void(0)', content: 'Body' }]}
      />,
    );

    await expect.element(page.getByRole('link', { name: /Half linked/ })).toHaveAttribute('href', 'http://example.com/a');
    expect(page.getByRole('link').elements()).toHaveLength(1);
  });

  test('renders a "Direct input" badge and no links when both URLs are empty', async () => {
    await render(<NewscastSources sources={[PASTED_ARTICLE]} />);

    await expect.element(page.getByText('A pasted article')).toBeInTheDocument();
    await expect.element(page.getByText('Direct input')).toBeInTheDocument();
    expect(page.getByRole('link').query()).toBeNull();
  });
});
