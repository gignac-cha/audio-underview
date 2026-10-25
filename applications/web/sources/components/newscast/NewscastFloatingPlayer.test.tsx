import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import type { NewscastResult } from '@audio-underview/newscast-core';
import { NewscastFloatingPlayer } from './NewscastFloatingPlayer.tsx';

const RESULT: NewscastResult = {
  sources: [],
  script: [
    { speaker: 1, text: 'This is the first line.' },
    { speaker: 2, text: 'This is the second line.' },
    { speaker: 1, text: 'This is the third line.' },
    { speaker: 2, text: 'This is the fourth line.' },
    { speaker: 1, text: 'This is the fifth line.' },
  ],
  segments: [
    { index: 0, startMs: 0, durationMs: 1000 },
    { index: 1, startMs: 1000, durationMs: 1000 },
    { index: 2, startMs: 2000, durationMs: 1000 },
    { index: 3, startMs: 3000, durationMs: 1000 },
    { index: 4, startMs: 4000, durationMs: 1000 },
  ],
  audioKey: 'test-audio',
};

/** URL builder mirroring `audioURLForJobPart` — one URL per 1-based part index. */
function partAudioURL(partIndex: number, token = 'media-token-1'): string {
  return `http://localhost:6666/newscasts/job-x/audio?part=${partIndex}&token=${token}`;
}

function makePart(index: number) {
  return {
    index,
    audioKey: `job-x/part-${index}`,
    durationMs: 60_000,
    script: [
      { speaker: 1 as const, text: `Part ${index}, first line.` },
      { speaker: 2 as const, text: `Part ${index}, second line.` },
    ],
    segments: [
      { index: 0, startMs: 0, durationMs: 1000 },
      { index: 1, startMs: 1000, durationMs: 1000 },
    ],
  };
}

const MULTI_PART_RESULT: NewscastResult = {
  sources: [],
  // Top-level aggregate fields — present for old readers but unused when `parts` is
  script: makePart(1).script,
  segments: makePart(1).segments,
  audioKey: 'job-x/part-1',
  parts: [makePart(1), makePart(2), makePart(3)],
};

async function renderPlayer(overrides: { onClose?: () => void; onJumpToJob?: () => void } = {}) {
  return await render(
    <NewscastFloatingPlayer
      title="Test newscast"
      result={RESULT}
      audioURL="about:blank"
      onClose={overrides.onClose ?? (() => undefined)}
      onJumpToJob={overrides.onJumpToJob ?? (() => undefined)}
      onPlayingChange={() => undefined}
    />,
  );
}

async function renderMultiPartPlayer(options: { partTransitionAudioURL?: string; audioURLForPart?: (partIndex: number) => string } = {}) {
  const screen = await render(
    <NewscastFloatingPlayer
      title="Multi-part newscast"
      result={MULTI_PART_RESULT}
      audioURL="about:blank"
      audioURLForPart={options.audioURLForPart ?? partAudioURL}
      partTransitionAudioURL={options.partTransitionAudioURL}
      onClose={() => undefined}
      onJumpToJob={() => undefined}
      onPlayingChange={() => undefined}
    />,
  );
  const audio = screen.container.querySelector('audio');
  if (audio === null) {
    throw new Error('expected an <audio> element');
  }
  return { screen, audio };
}

function endAudio(audio: HTMLAudioElement) {
  audio.dispatchEvent(new Event('ended'));
}

describe('NewscastFloatingPlayer', () => {
  test('shows a compact caption window (current line + neighbor), not the whole script', async () => {
    await renderPlayer();

    await expect.element(page.getByText('This is the first line.')).toBeInTheDocument();
    // Before playback the focus is line 0, so line 1 appears as the dimmed next-line neighbor
    await expect.element(page.getByText('This is the second line.')).toBeInTheDocument();
    expect(page.getByText('This is the fifth line.').query()).toBeNull();
  });

  test('names the speakers Host 1 and Host 2', async () => {
    await renderPlayer();

    await expect.element(page.getByText('Host 1').first()).toBeInTheDocument();
    await expect.element(page.getByText('Host 2').first()).toBeInTheDocument();
  });

  test('opens the full script in a dialog and closes back to the compact bar', async () => {
    await renderPlayer();

    await page.getByRole('button', { name: 'Full script' }).click();

    const dialog = page.getByRole('dialog', { name: 'Full script' });
    await expect.element(dialog).toHaveTextContent('This is the first line.');
    await expect.element(dialog).toHaveTextContent('This is the fifth line.');

    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
    expect(page.getByText('This is the fifth line.').query()).toBeNull();
  });

  test('invokes onClose from the close-player button', async () => {
    const onClose = vi.fn();
    await renderPlayer({ onClose });

    await page.getByRole('button', { name: 'Close player' }).click();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('invokes onJumpToJob when the title is clicked', async () => {
    const onJumpToJob = vi.fn();
    await renderPlayer({ onJumpToJob });

    await page.getByRole('button', { name: 'Test newscast' }).click();

    expect(onJumpToJob).toHaveBeenCalledTimes(1);
  });

  test('plays a result without parts from the audio URL, with no part chips', async () => {
    const screen = await renderPlayer();

    expect(screen.container.querySelector('audio')?.getAttribute('src')).toBe('about:blank');
    expect(page.getByRole('button', { name: 'Play part 1' }).query()).toBeNull();
    expect(page.getByRole('group', { name: 'Parts' }).query()).toBeNull();
  });

  test('binds the audio to the current part and shows a chip per part', async () => {
    const { audio } = await renderMultiPartPlayer();

    expect(audio.getAttribute('src')).toBe(partAudioURL(1));
    await expect.element(page.getByText('Part 1, first line.')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Play part 1' })).toHaveAttribute('aria-current', 'true');
    await expect.element(page.getByRole('button', { name: 'Play part 2' })).toHaveTextContent('Part 2');
    await expect.element(page.getByRole('button', { name: 'Play part 3' })).toBeInTheDocument();
  });

  test('advances to the next part when the current part audio ends, then stops on the last', async () => {
    const { audio } = await renderMultiPartPlayer();

    endAudio(audio);
    await expect.poll(() => audio.getAttribute('src')).toBe(partAudioURL(2));
    await expect.element(page.getByText('Part 2, first line.')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Play part 2' })).toHaveAttribute('aria-current', 'true');

    endAudio(audio);
    await expect.poll(() => audio.getAttribute('src')).toBe(partAudioURL(3));

    // Part 3 is the last part: ending it does NOT wrap around
    endAudio(audio);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(audio.getAttribute('src')).toBe(partAudioURL(3));
  });

  test('plays the signal through the SAME audio element between parts, then the next part', async () => {
    // The sting reuses the user-activated element: mobile autoplay policies reject play() on a
    // freshly constructed Audio element without a gesture. The bogus data URI fails fast, which
    // takes the error → advance path; the 3s cap and the natural end share the same handler.
    const signalURL = 'data:audio/wav;base64,AAAA';
    const { screen, audio } = await renderMultiPartPlayer({ partTransitionAudioURL: signalURL });
    expect(audio.getAttribute('src')).toBe(partAudioURL(1));
    // The sting fails so fast that its src may be gone before a poll sees it, so every src is recorded
    const sources: (string | null)[] = [];
    new MutationObserver(() => sources.push(audio.getAttribute('src'))).observe(audio, {
      attributes: true,
      attributeFilter: ['src'],
    });

    endAudio(audio);
    // Exactly once: the racing finish events must not skip ahead to part 3
    await expect.poll(() => audio.getAttribute('src')).toBe(partAudioURL(2));
    await expect.element(page.getByRole('button', { name: 'Play part 2' })).toHaveAttribute('aria-current', 'true');
    expect(sources).toEqual([signalURL, partAudioURL(2)]);
    expect(screen.container.querySelectorAll('audio')).toHaveLength(1);

    endAudio(audio);
    await expect.poll(() => audio.getAttribute('src')).toBe(partAudioURL(3));
    expect(sources).toEqual([signalURL, partAudioURL(2), signalURL, partAudioURL(3)]);
    expect(screen.container.querySelectorAll('audio')).toHaveLength(1);
  });

  test('keeps the URL of the playing part when the media token is refreshed', async () => {
    // A changed src makes the browser restart the track from 0:00, so the held URL must not change
    let token = 'media-token-1';
    const { screen, audio } = await renderMultiPartPlayer({
      audioURLForPart: (partIndex) => partAudioURL(partIndex, token),
    });
    expect(audio.getAttribute('src')).toBe(partAudioURL(1, 'media-token-1'));

    token = 'media-token-2';
    await screen.rerender(
      <NewscastFloatingPlayer
        title="Multi-part newscast"
        result={MULTI_PART_RESULT}
        audioURL="about:blank"
        audioURLForPart={(partIndex) => partAudioURL(partIndex, token)}
        onClose={() => undefined}
        onJumpToJob={() => undefined}
        onPlayingChange={() => undefined}
      />,
    );
    expect(audio.getAttribute('src')).toBe(partAudioURL(1, 'media-token-1'));

    // The part that starts after the refresh is built with the new token
    endAudio(audio);
    await expect.poll(() => audio.getAttribute('src')).toBe(partAudioURL(2, 'media-token-2'));
  });

  test('switches parts from a transport chip click, from that part start', async () => {
    const { audio } = await renderMultiPartPlayer();

    await page.getByRole('button', { name: 'Play part 3' }).click();

    await expect.poll(() => audio.getAttribute('src')).toBe(partAudioURL(3));
    await expect.element(page.getByText('Part 3, first line.')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Play part 3' })).toHaveAttribute('aria-current', 'true');
    await expect.element(page.getByRole('button', { name: 'Play part 1' })).toHaveAttribute('aria-current', 'false');
  });

  test('shows every part under its header in the full-script dialog', async () => {
    await renderMultiPartPlayer();

    await page.getByRole('button', { name: 'Full script' }).click();

    const dialog = page.getByRole('dialog', { name: 'Full script' });
    await expect.element(dialog).toHaveTextContent('— Part 1 —');
    await expect.element(dialog).toHaveTextContent('— Part 2 —');
    await expect.element(dialog).toHaveTextContent('— Part 3 —');
    await expect.element(dialog).toHaveTextContent('Part 2, first line.');
    await expect.element(dialog).toHaveTextContent('Part 3, second line.');
  });

  test('publishes media-session metadata with the part number, tracking part changes', async () => {
    const { screen } = await renderMultiPartPlayer();

    expect(navigator.mediaSession.metadata?.title).toBe('Multi-part newscast — Part 1');
    expect(navigator.mediaSession.metadata?.artist).toBe('Audio Underview');

    await page.getByRole('button', { name: 'Play part 2' }).click();
    await expect.poll(() => navigator.mediaSession.metadata?.title).toBe('Multi-part newscast — Part 2');

    // Closing the player also clears the OS media notification metadata
    await screen.unmount();
    expect(navigator.mediaSession.metadata).toBeNull();
  });

  test('publishes media-session metadata without a part suffix for a result without parts', async () => {
    const screen = await renderPlayer();

    expect(navigator.mediaSession.metadata?.title).toBe('Test newscast');
    expect(navigator.mediaSession.metadata?.artist).toBe('Audio Underview');
    await screen.unmount();
  });
});
