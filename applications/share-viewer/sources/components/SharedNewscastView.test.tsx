/**
 * End-to-end-ish coverage of the listening surface against the fixture: the
 * transcript follows the audio, and every seek affordance resolves to the right
 * PART-RELATIVE offset — the boundary case the whole design turns on.
 *
 * The fixture is a two-part newscast of 12s + 9s, so 21s of unified timeline;
 * the numbers below are chosen to land on either side of the 12s boundary.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithTheme } from '../tests/render-with-theme.tsx';
import { SharedNewscastView } from './SharedNewscastView.tsx';
import { PLAYBACK_RATE_STORAGE_KEY } from '../playback/use-share-playback.ts';
import { LIGHT_THEME } from '../themes/tokens.ts';
import {
  SAMPLE_SHARE_VIEW,
  SAMPLE_SHARE_VIEW_WITHOUT_METADATA,
  SAMPLE_SINGLE_PART_SHARE_VIEW,
} from '../fixtures/sample-share-view.ts';

const partAudioUrl = (partIndex: number) =>
  `https://worker.test/share/token-abc/audio?part=${partIndex}`;
const signalAudioUrl = 'https://worker.test/share/token-abc/audio?part=signal';

function renderView(view = SAMPLE_SHARE_VIEW) {
  const result = renderWithTheme(
    <SharedNewscastView
      view={view}
      partAudioUrl={partAudioUrl}
      signalAudioUrl={signalAudioUrl}
    />,
  );
  const audio = screen.getByTestId('share-audio') as HTMLAudioElement;
  return { ...result, audio };
}

/** Moves the playhead and fires the event the component listens for. */
function playTo(audio: HTMLAudioElement, seconds: number) {
  audio.currentTime = seconds;
  fireEvent.timeUpdate(audio);
}

/**
 * jsdom never actually plays, so nothing fires `play` on its own — but the
 * floating transport only exists after the element reports playing at least
 * once, which is exactly what most of these tests need to reach.
 */
function beginPlayback(audio: HTMLAudioElement) {
  fireEvent.play(audio);
}

describe('SharedNewscastView', () => {
  it('starts on part 1 and does not autoplay a stranger link', () => {
    const { audio } = renderView();
    expect(audio.getAttribute('src')).toContain('part=1');
    expect(audio.autoplay).toBe(false);
    expect(screen.getByRole('button', { name: '뉴스캐스트 재생' })).toBeInTheDocument();
  });

  it('keeps the floating transport away until playback has actually started', () => {
    const { audio } = renderView();

    expect(screen.queryByLabelText('재생 컨트롤')).not.toBeInTheDocument();

    beginPlayback(audio);

    expect(screen.getByLabelText('재생 컨트롤')).toBeInTheDocument();
    // Pausing must not take the controls away again.
    fireEvent.pause(audio);
    expect(screen.getByLabelText('재생 컨트롤')).toBeInTheDocument();
  });

  it('makes the hero button the only way to start', () => {
    renderView();

    expect(screen.getByRole('button', { name: '뉴스캐스트 재생' })).toBeInTheDocument();
    // The transport's own play button, which would be the second one.
    expect(screen.queryByRole('button', { name: '재생' })).toBeNull();
  });

  it('bylines the sharer, the length, the part count, and the date', () => {
    renderView();

    const byline = within(screen.getByTestId('newscast-byline'));
    expect(byline.getByText('차진혁님이 공유')).toBeInTheDocument();
    // 12s + 9s of fixture audio.
    expect(byline.getByText('21초')).toBeInTheDocument();
    expect(byline.getByText('2부')).toBeInTheDocument();
    expect(byline.getByText('2026년 8월 1일')).toBeInTheDocument();
  });

  it('keeps length and part count in the byline when no metadata was published', () => {
    renderView(SAMPLE_SHARE_VIEW_WITHOUT_METADATA);

    const byline = within(screen.getByTestId('newscast-byline'));
    expect(byline.queryByText(/님이 공유/)).not.toBeInTheDocument();
    expect(byline.queryByText(/년/)).not.toBeInTheDocument();
    expect(byline.getByText('21초')).toBeInTheDocument();
    expect(byline.getByText('2부')).toBeInTheDocument();
  });

  it('folds the production credits away below the transcript', () => {
    renderView();

    const credits = screen.getByLabelText('공개된 정보');
    expect(credits).not.toHaveAttribute('open');
    expect(screen.getByText('제작 정보')).toBeInTheDocument();
    // The sharer belongs to the byline now, not to the credits.
    expect(screen.queryByText('차진혁 · sharer@example.com')).not.toBeInTheDocument();
  });

  it('closes with the AI disclosure and no call to action', () => {
    renderView();

    expect(
      screen.getByText('이 뉴스캐스트는 AI가 기사를 요약해 생성한 오디오입니다.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /뉴스캐스트 만들기/ })).toBeNull();
  });

  it('moves the line highlight as the audio advances', () => {
    const { audio } = renderView();

    playTo(audio, 1.3);

    const firstLine = screen.getByRole('button', {
      name: '진행자1: 안녕하세요 오늘의 소식입니다',
    });
    expect(firstLine).toHaveAttribute('aria-current', 'true');

    playTo(audio, 5);

    expect(
      screen.getByRole('button', { name: '진행자2: 첫 소식부터 살펴보죠' }),
    ).toHaveAttribute('aria-current', 'true');
    expect(firstLine).toHaveAttribute('aria-current', 'false');
  });

  it('splits only the active line into individually styled words', () => {
    const { audio } = renderView();

    // Nothing is active before playback, so no line is word-split yet.
    expect(screen.queryByText('오늘의')).toBeNull();

    playTo(audio, 1.3);

    // The spoken word carries a different generated class than its neighbours,
    // which is the spotlight gradient in observable form. The class is captured
    // by value because React reuses the same DOM node as the spotlight moves.
    const spokenClassName = screen.getByText('오늘의').className;
    expect(spokenClassName).not.toBe(screen.getByText('소식입니다').className);

    // Advancing hands the spotlight to the next word, same styling.
    playTo(audio, 3);
    expect(screen.getByText('소식입니다').className).toBe(spokenClassName);
    expect(screen.getByText('오늘의').className).not.toBe(spokenClassName);

    // Once a later line takes over, the earlier one collapses back to plain text.
    playTo(audio, 5);
    expect(screen.queryByText('오늘의')).toBeNull();
  });

  it('degrades to line-level highlighting when a line has no word timings', () => {
    const { audio } = renderView();

    // Part 1 line 3 was never word-aligned by Whisper.
    playTo(audio, 8);

    const line = screen.getByRole('button', {
      name: '진행자1: 이해가 새로운 병목이라는 주장입니다',
    });
    expect(line).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByText('병목이라는')).toBeNull();
  });

  it('seeks within the current part when a line of that part is clicked', async () => {
    const user = userEvent.setup();
    const { audio } = renderView();

    await user.click(screen.getByRole('button', { name: '진행자2: 첫 소식부터 살펴보죠' }));

    expect(audio.currentTime).toBe(4);
    expect(audio.getAttribute('src')).toContain('part=1');
  });

  it('switches source first, then applies a part-relative offset, when the line is in another part', async () => {
    const user = userEvent.setup();
    const { audio } = renderView();

    await user.click(screen.getByRole('button', { name: '진행자1: 여기까지 듣겠습니다' }));

    // Part 2 line 1 starts 5s into PART 2 — not 17s into the newscast.
    expect(audio.getAttribute('src')).toContain('part=2');
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(5);
  });

  it('seeks to a word inside the active line', async () => {
    const user = userEvent.setup();
    const { audio } = renderView();

    playTo(audio, 0.1);
    await user.click(screen.getByText('오늘의'));

    expect(audio.currentTime).toBeCloseTo(1.2);
  });

  it('jumps parts from the part chips', async () => {
    const user = userEvent.setup();
    const { audio } = renderView();
    beginPlayback(audio);

    await user.click(screen.getByRole('button', { name: '2부 재생' }));

    expect(audio.getAttribute('src')).toContain('part=2');
    expect(screen.getByRole('button', { name: '2부 재생' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('plays the transition sting between parts and then advances', () => {
    vi.useFakeTimers();
    try {
      const { audio } = renderView();
      beginPlayback(audio);

      fireEvent.ended(audio);
      expect(audio.getAttribute('src')).toBe(signalAudioUrl);
      expect(screen.getByText('다음 파트로 넘어가는 중…')).toBeInTheDocument();

      // The sting is capped rather than played to its natural end.
      audio.currentTime = 3.5;
      fireEvent.timeUpdate(audio);

      expect(audio.getAttribute('src')).toContain('part=2');
      expect(screen.queryByText('다음 파트로 넘어가는 중…')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances with no sting when the newscast has none', () => {
    const withoutSignal = { ...SAMPLE_SHARE_VIEW, hasSignalAudio: false };
    const { audio } = renderView(withoutSignal);

    fireEvent.ended(audio);

    expect(audio.getAttribute('src')).toContain('part=2');
  });

  it('stops at the end of the last part', () => {
    const { audio } = renderView(SAMPLE_SINGLE_PART_SHARE_VIEW);
    beginPlayback(audio);

    fireEvent.ended(audio);

    expect(audio.getAttribute('src')).toContain('part=1');
    expect(screen.getByRole('button', { name: '재생' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '뉴스캐스트 재생' })).toBeInTheDocument();
  });

  it('hides part chips and the whole-newscast readout for a single-part newscast', () => {
    renderView(SAMPLE_SINGLE_PART_SHARE_VIEW);

    expect(screen.queryByRole('group', { name: '파트 선택' })).not.toBeInTheDocument();
    expect(screen.queryByText(/전체/)).not.toBeInTheDocument();
  });

  it('lets the reader turn auto-scroll off and back on', async () => {
    const user = userEvent.setup();
    renderView();

    const toggle = screen.getByRole('button', { name: '따라가기 켜짐' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await user.click(toggle);

    const offToggle = screen.getByRole('button', { name: '따라가기 꺼짐' });
    expect(offToggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(offToggle);
    expect(screen.getByRole('button', { name: '따라가기 켜짐' })).toBeInTheDocument();
  });

  it('exposes no owner controls', () => {
    renderView();

    for (const label of ['재생성', '삭제', '이름 변경', '재개', '공유 설정']) {
      expect(screen.queryByRole('button', { name: new RegExp(label) })).toBeNull();
    }
  });

  describe('waveform hero', () => {
    it('draws one bar per spoken line, coloured by anchor', () => {
      renderView();

      const bars = screen
        .getByTestId('waveform-episode-card')
        .querySelectorAll('rect');
      // Five lines across the two fixture parts.
      expect(bars).toHaveLength(5);
      expect(bars[0].getAttribute('fill')).toBe(LIGHT_THEME.colours.speaker1);
      expect(bars[1].getAttribute('fill')).toBe(LIGHT_THEME.colours.speaker2);
    });

    it('fills the bars behind the playhead and nothing before the first play', () => {
      const { audio } = renderView();
      const filledCount = () =>
        screen
          .getByTestId('waveform-episode-card')
          .querySelectorAll(`rect[fill="${LIGHT_THEME.colours.accent}"]`).length;

      expect(filledCount()).toBe(0);
      expect(screen.queryByTestId('playing-indicator')).toBeNull();

      beginPlayback(audio);
      playTo(audio, 5);

      // Lines starting at 0ms and 4000ms have been reached; 7500ms has not.
      expect(filledCount()).toBe(2);
      expect(screen.getByTestId('playing-indicator')).toBeInTheDocument();
    });
  });

  describe('unified timeline', () => {
    it('spans every part, so the slider maximum is the whole newscast', () => {
      const { audio } = renderView();
      beginPlayback(audio);

      const slider = screen.getByLabelText('재생 위치') as HTMLInputElement;
      expect(slider.max).toBe('21');
      expect(screen.getByText('0:21')).toBeInTheDocument();
    });

    it('draws one notch per part boundary, and none for a single part', () => {
      const { audio, unmount } = renderView();
      beginPlayback(audio);
      expect(screen.getAllByTestId('part-boundary-notch')).toHaveLength(1);

      unmount();

      const single = renderView(SAMPLE_SINGLE_PART_SHARE_VIEW);
      beginPlayback(single.audio);
      expect(screen.queryAllByTestId('part-boundary-notch')).toHaveLength(0);
    });

    it('converts a whole-newscast position inside part 1 into a plain seek', () => {
      const { audio } = renderView();
      beginPlayback(audio);

      fireEvent.change(screen.getByLabelText('재생 위치'), { target: { value: '5' } });

      expect(audio.getAttribute('src')).toContain('part=1');
      expect(audio.currentTime).toBe(5);
    });

    it('converts a position past the boundary into (part 2, part-relative offset)', () => {
      const { audio } = renderView();
      beginPlayback(audio);

      // 15s overall is 3s into part 2, because part 1 is 12s long.
      fireEvent.change(screen.getByLabelText('재생 위치'), { target: { value: '15' } });

      expect(audio.getAttribute('src')).toContain('part=2');
      fireEvent.loadedMetadata(audio);
      expect(audio.currentTime).toBe(3);
    });

    it('counts elapsed time across the parts already played', () => {
      const { audio } = renderView();
      beginPlayback(audio);

      fireEvent.change(screen.getByLabelText('재생 위치'), { target: { value: '15' } });
      fireEvent.loadedMetadata(audio);
      playTo(audio, 3);

      expect(screen.getByText('0:15')).toBeInTheDocument();
    });
  });

  describe('skip and speed', () => {
    it('skips ten seconds forward inside the current part', async () => {
      const user = userEvent.setup();
      const { audio } = renderView();
      beginPlayback(audio);

      await user.click(screen.getByRole('button', { name: '10초 앞으로' }));

      expect(audio.currentTime).toBe(10);
    });

    it('skips backwards across a part boundary', async () => {
      const user = userEvent.setup();
      const { audio } = renderView();
      beginPlayback(audio);

      await user.click(screen.getByRole('button', { name: '2부 재생' }));
      await user.click(screen.getByRole('button', { name: '10초 뒤로' }));

      // 12s (start of part 2) minus 10s lands 2s into part 1.
      expect(audio.getAttribute('src')).toContain('part=1');
      fireEvent.loadedMetadata(audio);
      expect(audio.currentTime).toBe(2);
    });

    it('moves the same ten seconds from the arrow keys', () => {
      const { audio } = renderView();
      beginPlayback(audio);

      fireEvent.keyDown(window, { code: 'ArrowRight' });

      expect(audio.currentTime).toBe(10);
    });

    it('cycles the speed, applies it to the element, and remembers it', async () => {
      const user = userEvent.setup();
      const first = renderView();
      beginPlayback(first.audio);

      await user.click(screen.getByRole('button', { name: '재생 속도 1배' }));
      expect(screen.getByRole('button', { name: '재생 속도 1.25배' })).toBeInTheDocument();
      expect(first.audio.playbackRate).toBe(1.25);

      await user.click(screen.getByRole('button', { name: '재생 속도 1.25배' }));
      await user.click(screen.getByRole('button', { name: '재생 속도 1.5배' }));
      await user.click(screen.getByRole('button', { name: '재생 속도 2배' }));
      expect(screen.getByRole('button', { name: '재생 속도 1배' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '재생 속도 1배' }));
      expect(window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY)).toBe('1.25');

      first.unmount();
      const second = renderView();
      beginPlayback(second.audio);
      expect(screen.getByRole('button', { name: '재생 속도 1.25배' })).toBeInTheDocument();
    });
  });

  describe('re-sharing', () => {
    it('copies the address to the clipboard when there is no share sheet', async () => {
      const user = userEvent.setup();
      renderView();

      await user.click(screen.getByRole('button', { name: '링크 복사' }));

      expect(await window.navigator.clipboard.readText()).toBe(window.location.href);
      expect(screen.getByRole('button', { name: '복사됨' })).toBeInTheDocument();
    });

    it('prefers the platform share sheet where one exists', async () => {
      const user = userEvent.setup();
      const share = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(window.navigator, 'share', {
        configurable: true,
        writable: true,
        value: share,
      });
      try {
        renderView();

        await user.click(screen.getByRole('button', { name: '링크 복사' }));

        expect(share).toHaveBeenCalledWith({
          title: '이해가 새로운 병목이다',
          url: window.location.href,
        });
      } finally {
        Reflect.deleteProperty(window.navigator, 'share');
      }
    });
  });

  describe('media session', () => {
    it('publishes metadata, handlers, and a whole-newscast position', () => {
      const session = {
        metadata: null as unknown,
        playbackState: 'none',
        setActionHandler: vi.fn(),
        setPositionState: vi.fn(),
      };
      Object.defineProperty(window.navigator, 'mediaSession', {
        configurable: true,
        writable: true,
        value: session,
      });
      vi.stubGlobal(
        'MediaMetadata',
        class {
          title: string;
          artist: string;
          constructor(init: { title: string; artist: string }) {
            this.title = init.title;
            this.artist = init.artist;
          }
        },
      );

      try {
        const { audio } = renderView();

        expect(session.metadata).toMatchObject({
          title: '이해가 새로운 병목이다',
          artist: 'Audio Underview',
        });
        const registered = session.setActionHandler.mock.calls.map(([action]) => action);
        expect(registered).toEqual(
          expect.arrayContaining(['play', 'pause', 'seekbackward', 'seekforward', 'seekto']),
        );

        beginPlayback(audio);
        playTo(audio, 4);

        expect(session.playbackState).toBe('playing');
        expect(session.setPositionState).toHaveBeenLastCalledWith({
          duration: 21,
          position: 4,
          playbackRate: 1,
        });
      } finally {
        vi.unstubAllGlobals();
        Reflect.deleteProperty(window.navigator, 'mediaSession');
      }
    });

    it('renders normally where the platform has no media session', () => {
      expect('mediaSession' in window.navigator).toBe(false);
      const { audio } = renderView();

      beginPlayback(audio);

      expect(screen.getByLabelText('재생 컨트롤')).toBeInTheDocument();
    });
  });
});
