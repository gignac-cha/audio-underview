import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import type { JobStatus } from '@audio-underview/newscast-core';
import { StageTracker } from './StageTracker.tsx';

const RUNNING: JobStatus = {
  id: 'job-running',
  stage: 'script',
  stageProgress: 0.4,
  overallProgress: 0.62,
  status: 'running',
  details: {
    timings: {
      'crawl-list': { startedAt: 1_000, finishedAt: 3_500, durationMs: 2_500 },
      script: { startedAt: 30_000 },
    },
    crawlList: { count: 2, titles: ['First article', 'Second article'], bytes: 27_546 },
    organize: {
      provider: 'google',
      model: 'gemini-2.5-flash',
      unitCount: 23,
      estimatedScriptCharacters: 11_700,
      partCount: 2,
      turnTargets: [50, 41],
    },
  },
};

describe('StageTracker', () => {
  test('keeps the header and both progress bars', async () => {
    const screen = await render(<StageTracker status={RUNNING} elapsedMilliseconds={95_000} />);

    await expect.element(page.getByRole('heading', { level: 3 })).toHaveTextContent('Write script');
    expect(screen.container.textContent).toContain('01:35');
    expect(screen.container.textContent).toContain('62%');
    await expect.element(page.getByRole('progressbar', { name: 'Overall progress' })).toHaveAttribute('aria-valuenow', '62');
    // The in-stage bar shows its own percentage next to the stage name
    expect(screen.container.textContent).toContain('40%');
  });

  test('shows the compact stage rows, live-timing the active one', async () => {
    await render(<StageTracker status={RUNNING} nowMilliseconds={42_400} />);

    expect(page.getByRole('button').elements()).toHaveLength(6);
    // Finished stages carry their recorded figures…
    expect(page.getByRole('button', { name: /Fetch list/ }).element().textContent).toBe('Fetch list2 articles · 26.9 KB2.5s');
    await expect.element(page.getByRole('button', { name: /Organize material/ })).toHaveTextContent('23 units · 2 parts');
    // …while the running stage counts up from its recorded start
    await expect.element(page.getByRole('button', { name: /Write script/ })).toHaveTextContent('12.4s');
    // Stages that have not run yet stay bare
    expect(page.getByRole('button', { name: /Merge audio/ }).element().textContent).toBe('Merge audio');
  });

  test('opens the pipeline graph from the header when the owner supplies a handler', async () => {
    const onOpenGraph = vi.fn();
    await render(<StageTracker status={RUNNING} onOpenGraph={onOpenGraph} />);

    await page.getByRole('button', { name: 'Graph' }).click();

    expect(onOpenGraph).toHaveBeenCalledTimes(1);
  });

  test('hides the graph button when no handler is supplied', async () => {
    await render(<StageTracker status={RUNNING} />);

    expect(page.getByRole('button', { name: 'Graph' }).query()).toBeNull();
  });
});
