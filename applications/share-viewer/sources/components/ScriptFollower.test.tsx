/**
 * The transcript's own behaviour, driven directly rather than through the page,
 * so the states that matter can be held still: stopped with a line already
 * selected, playing, a coarse pointer, and a reader scrolling away mid-follow.
 *
 * Colours are asserted as computed values against the real tokens — the point of
 * the stopped/playing duality and of the two speaker colours is which colour
 * lands on the text, so a class-name comparison would not be evidence.
 */

import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithTheme } from '../tests/render-with-theme.tsx';
import { SAMPLE_SHARE_VIEW } from '../fixtures/sample-share-view.ts';
import type { PublicSharePart } from '../schemas/public-share-view.ts';
import { LIGHT_THEME } from '../themes/tokens.ts';
import { NO_ACTIVE_INDEX } from '../playback/timings.ts';
import { FOLLOW_SCROLL_SETTLE_MILLISECONDS, ScriptFollower } from './ScriptFollower.tsx';

const FIRST_LINE = '안녕하세요 오늘의 소식입니다';
const SECOND_LINE = '첫 소식부터 살펴보죠';
const THIRD_LINE = '이해가 새로운 병목이라는 주장입니다';

/** `#4f6a94` in the form `getComputedStyle` reports it back. */
function asRgb(hex: string): string {
  const [red, green, blue] = [0, 1, 2].map((index) =>
    parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16),
  );
  return `rgb(${red}, ${green}, ${blue})`;
}

function colourOf(node: Element): string {
  return window.getComputedStyle(node).color;
}

interface FollowerHarnessOptions {
  parts?: PublicSharePart[];
  currentPartArrayIndex?: number;
  activeLineIndex?: number;
  activeWordIndex?: number;
  isPlaying?: boolean;
  followEnabled?: boolean;
}

/**
 * `followEnabled` is owned by the parent in production, so the harness owns it
 * here too: the intervention tests only mean something if turning follow off
 * actually re-renders the component with it off.
 */
function renderFollower(options: FollowerHarnessOptions = {}) {
  const onSeekLine = vi.fn();
  const onSeekWord = vi.fn();
  const onFollowEnabledChange = vi.fn();

  function FollowerHarness() {
    const [followEnabled, setFollowEnabled] = useState(options.followEnabled ?? true);
    return (
      <ScriptFollower
        parts={options.parts ?? SAMPLE_SHARE_VIEW.parts}
        currentPartArrayIndex={options.currentPartArrayIndex ?? 0}
        activeLineIndex={options.activeLineIndex ?? NO_ACTIVE_INDEX}
        activeWordIndex={options.activeWordIndex ?? NO_ACTIVE_INDEX}
        isPlaying={options.isPlaying}
        followEnabled={followEnabled}
        onFollowEnabledChange={(enabled) => {
          onFollowEnabledChange(enabled);
          setFollowEnabled(enabled);
        }}
        onSeekLine={onSeekLine}
        onSeekWord={onSeekWord}
      />
    );
  }

  const result = renderWithTheme(<FollowerHarness />);
  return { ...result, onSeekLine, onSeekWord, onFollowEnabledChange };
}

function stubMatchMedia(matchingQueries: string[]) {
  const original = window.matchMedia;
  const stub = (query: string) =>
    ({
      matches: matchingQueries.includes(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: stub,
  });
  return () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

let restoreMatchMedia: (() => void) | undefined;

afterEach(() => {
  restoreMatchMedia?.();
  restoreMatchMedia = undefined;
});

describe('stopped / playing duality', () => {
  it('keeps every line fully legible while nothing is playing', () => {
    // Line 3 of the fixture has no word timings, so all three lines stay as
    // plain text and the only variable left is the colour.
    renderFollower({ activeLineIndex: 2, isPlaying: false });

    for (const text of [FIRST_LINE, SECOND_LINE, THIRD_LINE]) {
      expect(colourOf(screen.getByText(text))).toBe(asRgb(LIGHT_THEME.colours.textPrimary));
    }
  });

  it('defaults to the legible state when the caller does not pass isPlaying', () => {
    renderFollower({ activeLineIndex: 2 });

    expect(colourOf(screen.getByText(FIRST_LINE))).toBe(
      asRgb(LIGHT_THEME.colours.textPrimary),
    );
  });

  it('dims everything but the spoken line once the audio is running', () => {
    renderFollower({ activeLineIndex: 2, isPlaying: true });

    expect(colourOf(screen.getByText(THIRD_LINE))).toBe(
      asRgb(LIGHT_THEME.colours.textPrimary),
    );
    for (const text of [FIRST_LINE, SECOND_LINE]) {
      expect(colourOf(screen.getByText(text))).toBe(
        asRgb(LIGHT_THEME.colours.textSecondary),
      );
    }
  });

  it('paints the spoken word in the readable mustard rather than the raw accent', () => {
    renderFollower({ activeLineIndex: 0, activeWordIndex: 0, isPlaying: true });

    const spokenWord = screen.getByText('안녕하세요');
    expect(colourOf(spokenWord)).toBe(asRgb(LIGHT_THEME.colours.accentText));
    // The fill colour would be 2.06:1 on the wash the word sits on.
    expect(colourOf(spokenWord)).not.toBe(asRgb(LIGHT_THEME.colours.accent));
  });

  it('drops the word colour on pause, where the spoken index lingers', () => {
    // Pausing mid-line leaves activeWordIndex pointing at a word; a stopped
    // transcript still has to be uniformly textPrimary.
    renderFollower({ activeLineIndex: 0, activeWordIndex: 0, isPlaying: false });

    const pausedWord = screen.getByText('안녕하세요');
    expect(colourOf(pausedWord)).toBe(asRgb(LIGHT_THEME.colours.textPrimary));
    expect(colourOf(pausedWord)).not.toBe(asRgb(LIGHT_THEME.colours.accent));
    expect(colourOf(pausedWord)).not.toBe(asRgb(LIGHT_THEME.colours.accentText));
    // The pause mark survives as weight alone, which costs no legibility.
    expect(window.getComputedStyle(pausedWord).fontWeight).toBe('700');
  });

  it('spotlights the spoken word at full opacity while stopped, and on the gradient while playing', () => {
    const { unmount } = renderFollower({ activeLineIndex: 0, activeWordIndex: 0 });
    expect(window.getComputedStyle(screen.getByText('소식입니다')).opacity).toBe('1');
    unmount();

    renderFollower({ activeLineIndex: 0, activeWordIndex: 0, isPlaying: true });
    expect(window.getComputedStyle(screen.getByText('소식입니다')).opacity).toBe('0.75');
  });
});

describe('reading measure and type scale', () => {
  it('holds the transcript to its own measure, narrower than the page around it', () => {
    renderFollower();

    expect(window.getComputedStyle(screen.getByRole('region', { name: '대본' })).maxWidth).toBe(
      '44rem',
    );
  });

  it('sets the transcript body at the scale it was designed for', () => {
    renderFollower();

    const style = window.getComputedStyle(screen.getByText(FIRST_LINE));
    expect(style.fontSize).toBe('1.0625rem');
    expect(style.lineHeight).toBe('1.85');
  });

  it('washes the spoken line in the accent only while the audio is running', () => {
    const { unmount } = renderFollower({ activeLineIndex: 0 });
    const stoppedLine = screen.getByRole('button', { name: `진행자1: ${FIRST_LINE}` });
    expect(window.getComputedStyle(stoppedLine).backgroundColor).not.toBe(
      asRgb(LIGHT_THEME.colours.accentSoft),
    );
    unmount();

    renderFollower({ activeLineIndex: 0, isPlaying: true });
    const playingLine = screen.getByRole('button', { name: `진행자1: ${FIRST_LINE}` });
    expect(window.getComputedStyle(playingLine).backgroundColor).toBe(
      asRgb(LIGHT_THEME.colours.accentSoft),
    );
  });
});

describe('speaker colours', () => {
  it('gives each anchor its own voice colour', () => {
    renderFollower();

    const [firstAnchorTag, secondAnchorTag] = [
      screen.getAllByText('진행자1')[0],
      screen.getAllByText('진행자2')[0],
    ];
    expect(colourOf(firstAnchorTag)).toBe(asRgb(LIGHT_THEME.colours.speaker1));
    expect(colourOf(secondAnchorTag)).toBe(asRgb(LIGHT_THEME.colours.speaker2));
  });

  it('rules the spoken line in the colour of whoever is speaking it', () => {
    const { unmount } = renderFollower({ activeLineIndex: 0, isPlaying: true });
    const anchorOneLine = screen.getByRole('button', { name: `진행자1: ${FIRST_LINE}` });
    expect(window.getComputedStyle(anchorOneLine).borderLeftColor).toBe(
      asRgb(LIGHT_THEME.colours.speaker1),
    );
    // An unspoken line keeps the rule but not the colour, so nothing shifts.
    const anchorTwoLine = screen.getByRole('button', { name: `진행자2: ${SECOND_LINE}` });
    expect(window.getComputedStyle(anchorTwoLine).borderLeftColor).not.toBe(
      asRgb(LIGHT_THEME.colours.speaker2),
    );
    unmount();

    renderFollower({ activeLineIndex: 1, isPlaying: true });
    expect(
      window.getComputedStyle(
        screen.getByRole('button', { name: `진행자2: ${SECOND_LINE}` }),
      ).borderLeftColor,
    ).toBe(asRgb(LIGHT_THEME.colours.speaker2));
  });
});

describe('part dividers', () => {
  it('labels each part with its length and seeks to the top of it', async () => {
    const user = userEvent.setup();
    const { onSeekLine } = renderFollower();

    const secondPartDivider = screen.getByRole('button', {
      name: '2부 · 9초, 처음부터 재생',
    });
    expect(secondPartDivider).toHaveTextContent('2부 · 9초');

    await user.click(secondPartDivider);

    expect(onSeekLine).toHaveBeenCalledWith(1, 0);
  });

  it('says minutes and seconds for a part of a realistic length', () => {
    const parts: PublicSharePart[] = SAMPLE_SHARE_VIEW.parts.map((part, index) => ({
      ...part,
      durationMs: index === 1 ? 252_000 : part.durationMs,
    }));
    renderFollower({ parts });

    expect(
      screen.getByRole('button', { name: '2부 · 4분 12초, 처음부터 재생' }),
    ).toBeInTheDocument();
  });
});

describe('pointer policy', () => {
  it('seeks to a word on a fine pointer', async () => {
    const user = userEvent.setup();
    const { onSeekLine, onSeekWord } = renderFollower({
      activeLineIndex: 0,
      activeWordIndex: 0,
    });

    await user.click(screen.getByText('오늘의'));

    expect(onSeekWord).toHaveBeenCalledWith(0, 0, 1);
    expect(onSeekLine).not.toHaveBeenCalled();
  });

  it('falls back to line seeking on a coarse pointer, where a word is too small to hit', async () => {
    restoreMatchMedia = stubMatchMedia(['(pointer: coarse)']);
    const user = userEvent.setup();
    const { onSeekLine, onSeekWord } = renderFollower({
      activeLineIndex: 0,
      activeWordIndex: 0,
    });

    await user.click(screen.getByText('오늘의'));

    expect(onSeekWord).not.toHaveBeenCalled();
    expect(onSeekLine).toHaveBeenCalledWith(0, 0);
  });
});

describe('follow intervention', () => {
  it('ignores the scroll it caused itself, then releases follow when the reader scrolls', () => {
    vi.useFakeTimers();
    try {
      const { onFollowEnabledChange } = renderFollower({
        activeLineIndex: 0,
        isPlaying: true,
      });

      // Still inside the settle window that the auto-scroll just opened.
      fireEvent.wheel(window);
      expect(onFollowEnabledChange).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: '따라가기 재개' })).toBeNull();

      vi.advanceTimersByTime(FOLLOW_SCROLL_SETTLE_MILLISECONDS + 50);
      fireEvent.wheel(window);

      expect(onFollowEnabledChange).toHaveBeenCalledWith(false);
      expect(screen.getByRole('button', { name: '따라가기 꺼짐' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '따라가기 재개' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases follow on a touch drag too', () => {
    vi.useFakeTimers();
    try {
      const { onFollowEnabledChange } = renderFollower({
        activeLineIndex: 0,
        isPlaying: true,
      });

      vi.advanceTimersByTime(FOLLOW_SCROLL_SETTLE_MILLISECONDS + 50);
      fireEvent.touchMove(window);

      expect(onFollowEnabledChange).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves follow alone while nothing is being spoken yet', () => {
    vi.useFakeTimers();
    try {
      const { onFollowEnabledChange } = renderFollower();

      vi.advanceTimersByTime(FOLLOW_SCROLL_SETTLE_MILLISECONDS + 50);
      fireEvent.wheel(window);

      expect(onFollowEnabledChange).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: '따라가기 재개' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores follow and scrolls back to the spoken line from the resume chip', () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.mocked(window.Element.prototype.scrollIntoView);
    try {
      const { onFollowEnabledChange } = renderFollower({
        activeLineIndex: 0,
        isPlaying: true,
      });

      vi.advanceTimersByTime(FOLLOW_SCROLL_SETTLE_MILLISECONDS + 50);
      fireEvent.wheel(window);
      scrollIntoView.mockClear();

      fireEvent.click(screen.getByRole('button', { name: '따라가기 재개' }));

      expect(onFollowEnabledChange).toHaveBeenLastCalledWith(true);
      expect(scrollIntoView).toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: '따라가기 재개' })).toBeNull();
      expect(screen.getByRole('button', { name: '따라가기 켜짐' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires the chip when follow is turned back on by hand', () => {
    vi.useFakeTimers();
    try {
      renderFollower({ activeLineIndex: 0, isPlaying: true });

      vi.advanceTimersByTime(FOLLOW_SCROLL_SETTLE_MILLISECONDS + 50);
      fireEvent.wheel(window);
      expect(screen.getByRole('button', { name: '따라가기 재개' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '따라가기 꺼짐' }));

      expect(screen.queryByRole('button', { name: '따라가기 재개' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrolls without animation when the reader asked for reduced motion', () => {
    restoreMatchMedia = stubMatchMedia(['(prefers-reduced-motion: reduce)']);
    const scrollIntoView = vi.mocked(window.Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();

    renderFollower({ activeLineIndex: 0, isPlaying: true });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
  });

  it('scrolls smoothly otherwise', () => {
    const scrollIntoView = vi.mocked(window.Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();

    renderFollower({ activeLineIndex: 0, isPlaying: true });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });
});
