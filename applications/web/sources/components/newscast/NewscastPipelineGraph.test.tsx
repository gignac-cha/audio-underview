import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import type { JobDetails, JobStatus, NewscastPart } from '@audio-underview/newscast-core';
import { NewscastPipelineGraph } from './NewscastPipelineGraph.tsx';
import { PipelineGraphDialog } from './PipelineGraphDialog.tsx';

/** State attribute of one graph node, or null when the node is not drawn. */
function nodeState(container: HTMLElement, id: string): string | null {
  const node = container.querySelector(`[data-node-id="${id}"]`);
  return node === null ? null : node.getAttribute('data-node-state');
}

function nodeText(container: HTMLElement, id: string): string {
  return container.querySelector(`[data-node-id="${id}"]`)?.textContent ?? '';
}

function hasEdge(container: HTMLElement, from: string, to: string): boolean {
  return container.querySelector(`[data-edge="${from}->${to}"]`) !== null;
}

/** Canvas position of one node, read back off its `translate(x,y)`: y is the stage depth, x the lane. */
function nodePosition(container: HTMLElement, id: string): { x: number; y: number } {
  const transform = container.querySelector(`[data-node-id="${id}"]`)?.getAttribute('transform') ?? '';
  const match = /^translate\((-?[\d.]+),(-?[\d.]+)\)$/.exec(transform);
  if (match === null) {
    throw new Error(`node ${id} has no translate transform (got "${transform}")`);
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

function makePart(index: number): NewscastPart {
  return {
    index,
    audioKey: `job-multi/part-${index}`,
    script: [
      { speaker: 1, text: `Part ${index}, first line.` },
      { speaker: 2, text: `Part ${index}, second line.` },
    ],
    segments: [{ index: 0, startMs: 0, durationMs: 1_000 }],
    durationMs: 480_000,
  };
}

const CRAWLED_SOURCE = {
  title: 'A GeekNews article',
  originalUrl: 'https://example.com/article',
  discussionUrl: 'https://news.hada.io/topic?id=1',
  content: 'The original article.',
};

const CRAWL_DETAILS: JobDetails = {
  crawlList: { count: 1, titles: [CRAWLED_SOURCE.title], bytes: 27_500 },
  crawlArticles: {
    articles: [{ title: CRAWLED_SOURCE.title, originalBytes: 20_000, geeknewsBytes: 5_000, hackerNewsBytes: 2_500 }],
    totalBytes: 27_500,
  },
};

/** A finished three-part newscast that also generated a transition sting. */
const MULTI_PART_DONE: JobStatus = {
  id: 'job-multi',
  stage: 'done',
  stageProgress: 1,
  overallProgress: 1,
  status: 'done',
  result: {
    sources: [CRAWLED_SOURCE],
    script: [],
    segments: [],
    audioKey: 'job-multi/part-1',
    parts: [makePart(1), makePart(2), makePart(3)],
    signalAudioKey: 'job-multi/signal',
  },
  details: {
    ...CRAWL_DETAILS,
    organize: {
      provider: 'google',
      model: 'gemini-2.5-flash',
      unitCount: 23,
      estimatedScriptCharacters: 11_700,
      partCount: 3,
      turnTargets: [50, 50, 50],
    },
    script: { provider: 'google', model: 'gemini-2.5-flash', turns: 150, characters: 11_700 },
    tts: { chunks: 21, audioDurationMs: 1_440_000 },
    merge: { mp3Bytes: 19_000_000, aligned: true },
    partsSummary: [
      { index: 1, turns: 50, characters: 3_900, audioDurationMs: 480_000 },
      { index: 2, turns: 50, characters: 3_900, audioDurationMs: 480_000 },
      { index: 3, turns: 50, characters: 3_900, audioDurationMs: 480_000 },
    ],
    signal: { generated: true, bytes: 480_000 },
  },
};

/** A finished newscast built from pasted text — the crawl stages never ran. */
const PASTED_DONE: JobStatus = {
  id: 'job-pasted',
  stage: 'done',
  stageProgress: 1,
  overallProgress: 1,
  status: 'done',
  result: {
    sources: [{ title: 'Pasted text', originalUrl: '', discussionUrl: '', content: 'Body' }],
    script: [],
    segments: [],
    audioKey: 'job-pasted/part-1',
    parts: [makePart(1)],
  },
  details: {
    organize: {
      provider: 'google',
      model: 'gemini-2.5-flash',
      unitCount: 9,
      estimatedScriptCharacters: 3_170,
      partCount: 1,
      turnTargets: [41],
    },
    script: { provider: 'google', model: 'gemini-2.5-flash', turns: 41, characters: 3_170 },
    tts: { chunks: 6, audioDurationMs: 388_000 },
    merge: { mp3Bytes: 5_600_000, aligned: true },
  },
};

/** A two-part newscast caught mid-synthesis. */
const RUNNING_TTS: JobStatus = {
  id: 'job-running',
  stage: 'tts',
  stageProgress: 0.5,
  overallProgress: 0.6,
  status: 'running',
  details: {
    ...CRAWL_DETAILS,
    organize: {
      provider: 'google',
      model: 'gemini-2.5-flash',
      unitCount: 16,
      estimatedScriptCharacters: 7_800,
      partCount: 2,
      turnTargets: [50, 50],
    },
    script: { provider: 'google', model: 'gemini-2.5-flash', turns: 100, characters: 7_800 },
  },
};

/** A row written before multi-part support: no `parts`, no organize telemetry. */
const LEGACY_DONE: JobStatus = {
  id: 'job-legacy',
  stage: 'done',
  stageProgress: 1,
  overallProgress: 1,
  status: 'done',
  result: {
    sources: [CRAWLED_SOURCE],
    script: [{ speaker: 1, text: 'The one line of a legacy script.' }],
    segments: [{ index: 0, startMs: 0, durationMs: 1_000 }],
    audioKey: 'job-legacy',
  },
  details: {
    ...CRAWL_DETAILS,
    script: { provider: 'anthropic', model: 'claude-sonnet-4', turns: 41, characters: 3_170 },
    tts: { chunks: 6, audioDurationMs: 388_000 },
    merge: { mp3Bytes: 5_600_000, aligned: false },
  },
};

/**
 * A finished "read verbatim" newscast. It carries the explicit `details.customArticle` flag AND
 * `crawlList` telemetry — the worker still records the list for the running title — which is
 * exactly the combination the old heuristic got wrong.
 */
const VERBATIM_DONE: JobStatus = {
  id: 'job-verbatim',
  stage: 'done',
  stageProgress: 1,
  overallProgress: 1,
  status: 'done',
  result: {
    sources: [{ title: 'A verbatim script', originalUrl: '', discussionUrl: '', content: 'Script' }],
    script: [],
    segments: [],
    audioKey: 'job-verbatim/part-1',
    parts: [makePart(1)],
  },
  details: {
    customArticle: { verbatim: true },
    crawlList: { count: 1, titles: ['A verbatim script'], bytes: 1_400 },
    tts: { chunks: 4, audioDurationMs: 240_000 },
    merge: { mp3Bytes: 3_200_000, aligned: true },
  },
};

/** The same newscast mid-synthesis — the skips must show before it finishes too. */
const VERBATIM_RUNNING: JobStatus = {
  id: 'job-verbatim-running',
  stage: 'tts',
  stageProgress: 0.4,
  overallProgress: 0.7,
  status: 'running',
  details: {
    customArticle: { verbatim: true },
    crawlList: { count: 1, titles: ['A verbatim script'], bytes: 1_400 },
  },
};

describe('NewscastPipelineGraph', () => {
  test('draws one script→tts→merge lane per part plus the signal node (multi-part done)', async () => {
    const { container } = await render(<NewscastPipelineGraph status={MULTI_PART_DONE} />);

    for (const partNumber of [1, 2, 3]) {
      expect(nodeState(container, `script-${partNumber}`)).toBe('done');
      expect(nodeState(container, `tts-${partNumber}`)).toBe('done');
      expect(nodeState(container, `merge-${partNumber}`)).toBe('done');
      expect(hasEdge(container, 'organize', `script-${partNumber}`)).toBe(true);
      expect(hasEdge(container, `script-${partNumber}`, `tts-${partNumber}`)).toBe(true);
      expect(hasEdge(container, `tts-${partNumber}`, `merge-${partNumber}`)).toBe(true);
      expect(hasEdge(container, `merge-${partNumber}`, 'finalize')).toBe(true);
    }
    expect(nodeState(container, 'script-4')).toBeNull();
    expect(nodeText(container, 'script-2')).toContain('Write script Part 2');

    // The sting branches off organize and rejoins at finalize
    expect(nodeState(container, 'signal')).toBe('done');
    expect(hasEdge(container, 'organize', 'signal')).toBe(true);
    expect(hasEdge(container, 'signal', 'finalize')).toBe(true);

    expect(nodeText(container, 'organize')).toContain('23 units · 3 parts');
    expect(nodeText(container, 'script-2')).toContain('50 turns');
    expect(nodeText(container, 'tts-2')).toContain('08:00');
    expect(nodeText(container, 'finalize')).toContain('3 parts');
    expect(nodeState(container, 'finalize')).toBe('done');

    // The lanes are parallel along X, with the sting parked past the last part
    const scriptLanes = [1, 2, 3].map((partNumber) => nodePosition(container, `script-${partNumber}`));
    expect(scriptLanes[0].y).toBe(scriptLanes[1].y);
    expect(scriptLanes[1].y).toBe(scriptLanes[2].y);
    expect(scriptLanes[0].x).toBeLessThan(scriptLanes[1].x);
    expect(scriptLanes[1].x).toBeLessThan(scriptLanes[2].x);
    expect(nodePosition(container, 'signal').x).toBeGreaterThan(scriptLanes[2].x);

    // …and the pipeline itself runs down Y, crawl at the top, finalize last
    const depths = ['crawl-list', 'crawl-articles', 'organize', 'script-1', 'tts-1', 'merge-1', 'finalize'].map(
      (id) => nodePosition(container, id).y,
    );
    for (let index = 1; index < depths.length; index += 1) {
      expect(depths[index]).toBeGreaterThan(depths[index - 1]);
    }

    // The spine is centered over the lanes it fans out to
    expect(nodePosition(container, 'organize').x).toBe(scriptLanes[1].x);
  });

  test('marks the crawl nodes as skipped "Direct input" for a pasted newscast', async () => {
    const { container } = await render(<NewscastPipelineGraph status={PASTED_DONE} />);

    expect(nodeState(container, 'crawl-list')).toBe('skipped');
    expect(nodeState(container, 'crawl-articles')).toBe('skipped');
    expect(nodeText(container, 'crawl-list')).toContain('Direct input');
    expect(nodeText(container, 'crawl-articles')).toContain('Direct input');

    expect(nodeState(container, 'organize')).toBe('done');
    expect(nodeState(container, 'script-1')).toBe('done');
    expect(nodeState(container, 'script-2')).toBeNull();
    expect(nodeState(container, 'signal')).toBeNull();
  });

  test('marks organize and script as skipped "Read verbatim" for a verbatim newscast', async () => {
    const { container } = await render(<NewscastPipelineGraph status={VERBATIM_DONE} />);

    expect(nodeState(container, 'organize')).toBe('skipped');
    expect(nodeState(container, 'script-1')).toBe('skipped');
    expect(nodeText(container, 'organize')).toContain('Read verbatim');
    expect(nodeText(container, 'script-1')).toContain('Read verbatim');

    // Only the flag is trusted, even though the newscast carries crawlList telemetry
    expect(nodeState(container, 'crawl-list')).toBe('skipped');
    expect(nodeState(container, 'crawl-articles')).toBe('skipped');
    expect(nodeText(container, 'crawl-list')).toContain('Direct input');
    expect(nodeText(container, 'crawl-list')).not.toContain('1 article');

    expect(nodeState(container, 'tts-1')).toBe('done');
    expect(nodeState(container, 'merge-1')).toBe('done');
    expect(nodeState(container, 'finalize')).toBe('done');
  });

  test('shows the verbatim skips while the newscast is still running, not only once done', async () => {
    const { container } = await render(<NewscastPipelineGraph status={VERBATIM_RUNNING} />);

    expect(nodeState(container, 'crawl-list')).toBe('skipped');
    expect(nodeState(container, 'crawl-articles')).toBe('skipped');
    expect(nodeState(container, 'organize')).toBe('skipped');
    expect(nodeState(container, 'script-1')).toBe('skipped');
    expect(nodeState(container, 'tts-1')).toBe('active');
  });

  test('draws a running verbatim newscast’s real lanes from the recorded partCount', async () => {
    const { container } = await render(
      <NewscastPipelineGraph
        status={{
          ...VERBATIM_RUNNING,
          details: { ...VERBATIM_RUNNING.details, customArticle: { verbatim: true, partCount: 3 } },
        }}
      />,
    );

    for (const partNumber of [1, 2, 3]) {
      expect(nodeState(container, `tts-${partNumber}`)).toBe('active');
      expect(nodeState(container, `merge-${partNumber}`)).toBe('pending');
      expect(hasEdge(container, `merge-${partNumber}`, 'finalize')).toBe(true);
    }
    expect(nodeState(container, 'tts-4')).toBeNull();
  });

  test('stays at one lane for a verbatim newscast created before partCount shipped', async () => {
    const { container } = await render(<NewscastPipelineGraph status={VERBATIM_RUNNING} />);

    expect(nodeState(container, 'tts-1')).toBe('active');
    expect(nodeState(container, 'tts-2')).toBeNull();
  });

  test('keeps the legacy inference for a pasted newscast with no recorded flag', async () => {
    const { container } = await render(<NewscastPipelineGraph status={PASTED_DONE} />);

    expect(nodeState(container, 'crawl-list')).toBe('skipped');
    expect(nodeState(container, 'organize')).toBe('done');
    expect(nodeState(container, 'script-1')).toBe('done');
    expect(nodeText(container, 'organize')).toContain('9 units');
    expect(nodeText(container, 'organize')).not.toContain('Read verbatim');
  });

  test('highlights every lane node of the current stage while running', async () => {
    const { container } = await render(<NewscastPipelineGraph status={RUNNING_TTS} />);

    expect(nodeState(container, 'tts-1')).toBe('active');
    expect(nodeState(container, 'tts-2')).toBe('active');
    expect(nodeState(container, 'script-1')).toBe('done');
    expect(nodeState(container, 'script-2')).toBe('done');
    expect(nodeState(container, 'crawl-list')).toBe('done');
    expect(nodeState(container, 'merge-1')).toBe('pending');
    expect(nodeState(container, 'merge-2')).toBe('pending');
    expect(nodeState(container, 'finalize')).toBe('pending');

    // No sting telemetry yet → no node, and turn targets stand in for actuals
    expect(nodeState(container, 'signal')).toBeNull();
    expect(nodeText(container, 'script-1')).toContain('~50 turns');
  });

  test('renders a legacy (part-less) newscast as a single lane with no signal node', async () => {
    const { container } = await render(<NewscastPipelineGraph status={LEGACY_DONE} />);

    expect(nodeState(container, 'script-1')).toBe('done');
    expect(nodeState(container, 'script-2')).toBeNull();
    expect(nodeState(container, 'tts-2')).toBeNull();
    expect(nodeState(container, 'signal')).toBeNull();

    expect(nodeState(container, 'crawl-list')).toBe('done');
    expect(nodeText(container, 'crawl-list')).toContain('1 article');

    expect(nodeText(container, 'script-1')).toContain('41 turns');
    expect(nodeText(container, 'tts-1')).toContain('6 chunks · 06:28');
    expect(nodeText(container, 'merge-1')).toContain('5.3 MB');
  });

  test('pans and zooms through one inner group carrying the d3 transform', async () => {
    const { container } = await render(<NewscastPipelineGraph status={MULTI_PART_DONE} />);

    const viewport = container.querySelector('[data-testid="pipeline-graph-viewport"]');
    expect(viewport).not.toBeNull();
    const fitted = viewport?.getAttribute('transform') ?? '';
    expect(fitted).toMatch(/^translate\([-\d.]+,[-\d.]+\) scale\([\d.]+\)$/);

    // Edges are d3-generated cubics, vertically tangent: each control point sits directly below/above
    // its own endpoint and the target is further down the canvas
    const edgePath = container.querySelector('[data-edge="organize->script-1"]')?.getAttribute('d') ?? '';
    expect(edgePath).toMatch(/^M[\d.,]+C[\d.,]+$/);
    const [startX, startY, control1X, , control2X, , endX, endY] = edgePath
      .split(/[MC,]/)
      .filter((piece) => piece.length > 0)
      .map(Number);
    expect(control1X).toBe(startX);
    expect(control2X).toBe(endX);
    expect(endY).toBeGreaterThan(startY);

    // A wheel gesture reaches d3.zoom and comes back out as a new transform
    page
      .getByTestId('pipeline-graph-canvas')
      .element()
      .dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
    await expect.poll(() => viewport?.getAttribute('transform')).not.toBe(fitted);
  });

  test('paints the failed stage as an error node and leaves later stages pending', async () => {
    const failed: JobStatus = {
      ...RUNNING_TTS,
      status: 'error',
      error: 'TTS chunk 3 failed',
      details: {
        ...RUNNING_TTS.details,
        failure: { stage: 'tts', message: 'TTS chunk 3 failed', at: '2026-07-24T00:00:00.000Z' },
      },
    };
    const { container } = await render(<NewscastPipelineGraph status={failed} />);

    expect(nodeState(container, 'tts-1')).toBe('error');
    expect(nodeState(container, 'tts-2')).toBe('error');
    expect(nodeState(container, 'script-1')).toBe('done');
    expect(nodeState(container, 'merge-1')).toBe('pending');
    expect(nodeState(container, 'finalize')).toBe('pending');
  });
});

describe('PipelineGraphDialog', () => {
  test('renders the graph in a titled modal only while open', async () => {
    const screen = await render(<PipelineGraphDialog status={MULTI_PART_DONE} open={false} onOpenChange={() => undefined} />);
    expect(page.getByText('Pipeline graph').query()).toBeNull();

    await screen.rerender(<PipelineGraphDialog status={MULTI_PART_DONE} open={true} onOpenChange={() => undefined} />);

    await expect.element(page.getByRole('dialog', { name: 'Pipeline graph' })).toBeVisible();
    await expect.element(page.getByTestId('pipeline-graph-canvas')).toBeInTheDocument();
  });

  test('asks the caller to close when the close button is pressed', async () => {
    const onOpenChange = vi.fn();
    await render(<PipelineGraphDialog status={MULTI_PART_DONE} open={true} onOpenChange={onOpenChange} />);

    await page.getByRole('button', { name: 'Close', exact: true }).click();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
