import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router';
import { page } from 'vitest/browser';
import type { JobStatus, NewscastPart } from '@audio-underview/newscast-core';
import { NewscastDetail } from './NewscastDetail.tsx';

function makePart(index: number): NewscastPart {
  return {
    index,
    audioKey: `job-done/part-${index}`,
    durationMs: 61_000,
    script: [
      { speaker: 1, text: `Part ${index}, first line.` },
      { speaker: 2, text: `Part ${index}, second line.` },
    ],
    segments: [
      { index: 0, startMs: 0, durationMs: 1000 },
      { index: 1, startMs: 1000, durationMs: 1000 },
    ],
  };
}

const RUNNING_JOB: JobStatus = {
  id: 'job-running',
  stage: 'script',
  stageProgress: 0.4,
  overallProgress: 0.5,
  status: 'running',
  details: { titleOverride: 'A corrected title' },
};

const ERROR_JOB: JobStatus = {
  id: 'job-error',
  stage: 'script',
  stageProgress: 0,
  overallProgress: 0,
  status: 'error',
  error: 'The script could not be written',
};

const DONE_JOB: JobStatus = {
  id: 'job-done',
  stage: 'done',
  stageProgress: 1,
  overallProgress: 1,
  status: 'done',
  result: {
    sources: [],
    script: makePart(1).script,
    segments: makePart(1).segments,
    audioKey: 'job-done/part-1',
    parts: [makePart(1)],
  },
};

const DONE_MULTI_PART_JOB: JobStatus = {
  ...DONE_JOB,
  id: 'job-done-multi',
  result: { ...DONE_JOB.result!, parts: [makePart(1), makePart(2)] },
};

describe('NewscastDetail — a done newscast', () => {
  test('offers Play, the script and Share, and lists the parts', async () => {
    await render(<NewscastDetail status={DONE_MULTI_PART_JOB} audioURL="about:blank" isLoading={false} nowMilliseconds={0} />);

    await expect.element(page.getByRole('button', { name: 'Play newscast' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Read the script' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    await expect.element(page.getByText('Part 1', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('Part 2', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('1:01').first()).toBeInTheDocument();
  });

  test('opens the full script in a dialog, unbound to playback, with Host 1 and Host 2', async () => {
    await render(<NewscastDetail status={DONE_JOB} audioURL="about:blank" isLoading={false} nowMilliseconds={0} />);

    await page.getByRole('button', { name: 'Read the script' }).click();

    const dialog = page.getByRole('dialog', { name: 'Full script' });
    await expect.element(dialog).toHaveTextContent('Part 1, first line.');
    await expect.element(dialog).toHaveTextContent('Part 1, second line.');
    await expect.element(dialog).toHaveTextContent('Host 1');
    await expect.element(dialog).toHaveTextContent('Host 2');
  });

  test('shows a part divider for a multi-part result', async () => {
    await render(<NewscastDetail status={DONE_MULTI_PART_JOB} audioURL="about:blank" isLoading={false} nowMilliseconds={0} />);

    await page.getByRole('button', { name: 'Read the script' }).click();

    const dialog = page.getByRole('dialog', { name: 'Full script' });
    await expect.element(dialog).toHaveTextContent('— Part 1 —');
    await expect.element(dialog).toHaveTextContent('— Part 2 —');
    await expect.element(dialog).toHaveTextContent('Part 2, first line.');
  });

  test('offers no playback while the newscast has no audio URL', async () => {
    await render(<NewscastDetail status={DONE_JOB} isLoading={false} nowMilliseconds={0} />);

    expect(page.getByRole('button', { name: 'Play newscast' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Share' }).query()).toBeNull();
  });

  test('binds the hero to the player through onPlayToggle', async () => {
    const onPlayToggle = vi.fn();
    await render(
      <NewscastDetail
        status={DONE_JOB}
        audioURL="about:blank"
        isLoading={false}
        nowMilliseconds={0}
        isPlayingThisJob={true}
        isAudioPlaying={true}
        onPlayToggle={onPlayToggle}
      />,
    );

    await page.getByRole('button', { name: 'Pause' }).click();

    expect(onPlayToggle).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText('Playing in the bottom bar')).toBeInTheDocument();
  });
});

describe('NewscastDetail — running and failed newscasts', () => {
  test('shows the title override and the stage tracker, without the script or Share', async () => {
    await render(<NewscastDetail status={RUNNING_JOB} isLoading={false} nowMilliseconds={0} />);

    await expect.element(page.getByRole('heading', { name: 'A corrected title' })).toBeInTheDocument();
    await expect.element(page.getByRole('progressbar', { name: 'Overall progress' })).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Read the script' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Share' }).query()).toBeNull();
  });

  test('shows the error panel without the script or Share', async () => {
    await render(
      <MemoryRouter>
        <NewscastDetail status={ERROR_JOB} isLoading={false} nowMilliseconds={0} />
      </MemoryRouter>,
    );

    await expect.element(page.getByRole('alert').getByText('Failed at Write script')).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Read the script' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Share' }).query()).toBeNull();
  });

  test('says what to do before a newscast is selected', async () => {
    await render(<NewscastDetail isLoading={false} nowMilliseconds={0} />);

    await expect.element(page.getByText('Select a newscast.')).toBeInTheDocument();
  });
});
