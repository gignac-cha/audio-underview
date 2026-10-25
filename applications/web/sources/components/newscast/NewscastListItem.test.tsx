import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import type { NewscastJobSummary } from '@audio-underview/newscast-core';
import { NewscastListItem } from './NewscastListItem.tsx';

const NOW = Date.parse('2026-07-14T05:00:00Z');

function job(overrides: Partial<NewscastJobSummary>): NewscastJobSummary {
  return {
    id: 'c3f487b3-51d7-44df-b1ac-44bd48647fca',
    status: 'running',
    stage: 'script',
    overallProgress: 0.47,
    createdAt: '2026-07-14T04:55:00.000+00:00',
    title: 'Why it is fine not to understand the whole codebase',
    ...overrides,
  };
}

describe('NewscastListItem', () => {
  test('renders a running newscast with live progress strip, stage label, relative time and badge', async () => {
    await render(<NewscastListItem job={job({})} selected={false} expanded={false} nowMilliseconds={NOW} onSelect={vi.fn()} />);

    await expect.element(page.getByText('Why it is fine not to understand the whole codebase')).toBeInTheDocument();
    await expect.element(page.getByText('Running')).toBeInTheDocument();
    await expect.element(page.getByText(/Write script · 47%/)).toBeInTheDocument();
    // createdAt is the ISO time of the database, five minutes before now
    await expect.element(page.getByText('5m ago')).toBeInTheDocument();
    await expect.element(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '47');
  });

  test('renders a done newscast with badge and no progressbar, falling back to a short ID title', async () => {
    await render(
      <NewscastListItem
        job={job({ status: 'done', stage: 'done', overallProgress: 1, title: null })}
        selected={false}
        expanded={false}
        nowMilliseconds={NOW}
        onSelect={vi.fn()}
      />,
    );

    await expect.element(page.getByText('Done')).toBeInTheDocument();
    await expect.element(page.getByText('Newscast c3f487b3')).toBeInTheDocument();
    expect(page.getByRole('progressbar').query()).toBeNull();
  });

  test('marks the selected row and forwards clicks', async () => {
    const onSelect = vi.fn();
    await render(<NewscastListItem job={job({})} selected={true} expanded={false} nowMilliseconds={NOW} onSelect={onSelect} />);

    const row = page.getByRole('button');
    await expect.element(row).toHaveAttribute('aria-current', 'true');
    await row.click();

    expect(onSelect).toHaveBeenCalledWith('c3f487b3-51d7-44df-b1ac-44bd48647fca');
  });

  test('renders inline children only when expanded', async () => {
    const screen = await render(
      <NewscastListItem job={job({})} selected={true} expanded={false} nowMilliseconds={NOW} onSelect={vi.fn()}>
        <div>inline detail</div>
      </NewscastListItem>,
    );
    expect(page.getByText('inline detail').query()).toBeNull();

    await screen.rerender(
      <NewscastListItem job={job({})} selected={true} expanded={true} nowMilliseconds={NOW} onSelect={vi.fn()}>
        <div>inline detail</div>
      </NewscastListItem>,
    );

    await expect.element(page.getByText('inline detail')).toBeInTheDocument();
  });
});
