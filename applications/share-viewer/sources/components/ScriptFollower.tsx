/**
 * The transcript, rendered as ONE continuous conversation across every part and
 * kept in step with the audio.
 *
 * The transcript is first-class reading matter, not a debug view of the audio,
 * so it obeys a STOPPED/PLAYING duality: while nothing is playing every line is
 * fully legible `textPrimary`, and only once audio is running does the spoken
 * line take the accent fill while the rest dims. A visitor who landed here to
 * skim before pressing play never sees greyed-out body text.
 *
 * On top of that: the spoken word is spotlit on a brightness gradient (only when
 * the part carries Whisper word timings); every line, word, and part divider is
 * a seek target — including lines in a part that is not currently loaded, which
 * is why every click carries its own `partArrayIndex`; and each anchor gets its
 * own voice colour (`speaker1` / `speaker2`) on the label and on the rule beside
 * the line being spoken.
 *
 * Auto-scroll is opt-out rather than forced: the manual toggle stays, and a
 * wheel or touch drag during follow releases it on the spot and offers a
 * "resume" chip, because a reader who scrolls back to re-read something should
 * not be yanked forward a moment later.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { keyframes } from '@emotion/react';
import styled from '@emotion/styled';
import type { PublicSharePart } from '../schemas/public-share-view.ts';
import { SPEAKER_LABELS } from '../constants.ts';
import {
  NO_ACTIVE_INDEX,
  findSegmentForLine,
  flattenScriptLines,
  formatDurationLabel,
  wordLevelForDistance,
} from '../playback/timings.ts';

/** Spotlight level (1 dimmest … 6 = the spoken word) mapped to opacity. */
const WORD_LEVEL_OPACITY: Record<number, number> = {
  1: 0.35,
  2: 0.5,
  3: 0.62,
  4: 0.75,
  5: 0.88,
  6: 1,
};

const COARSE_POINTER_QUERY = '(pointer: coarse)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * How long after an auto-scroll a wheel/touch event is still assumed to be the
 * tail of that same scroll rather than the reader taking over. Smooth scrolling
 * and iOS inertia both keep delivering events for a moment after the programmatic
 * command, and mistaking those for intervention would switch follow off exactly
 * when it is working correctly.
 */
export const FOLLOW_SCROLL_SETTLE_MILLISECONDS = 450;

function readMediaQueryMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(query).matches;
}

/**
 * A live media-query subscription. Kept live rather than sampled once because a
 * tablet can gain a mouse, and the motion preference can flip while the page is
 * open.
 */
function useMediaQueryMatches(query: string): boolean {
  const [matches, setMatches] = useState(() => readMediaQueryMatches(query));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const queryList = window.matchMedia(query);
    setMatches(queryList.matches);
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    queryList.addEventListener('change', handleChange);
    return () => queryList.removeEventListener('change', handleChange);
  }, [query]);

  return matches;
}

const Panel = styled.section`
  display: grid;
  gap: 0.75rem;
  /* The transcript keeps its own measure, narrower than the page: 44rem is
     around 40 Korean characters per line, the comfortable reading width. */
  width: 100%;
  max-width: 44rem;
  margin: 0 auto;
`;

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
`;

const PanelTitle = styled.h2`
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 700;
  color: ${(props) => props.theme.colours.textPrimary};
`;

const FollowToggle = styled.button<{ enabled: boolean }>`
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  color: ${(props) =>
    props.enabled ? props.theme.colours.surface : props.theme.colours.textSecondary};
  background: ${(props) =>
    props.enabled ? props.theme.colours.brandPrimary : props.theme.colours.surfaceAlternate};
  border: 1px solid
    ${(props) =>
      props.enabled ? props.theme.colours.brandPrimary : props.theme.colours.border};
`;

const Lines = styled.div`
  display: grid;
  gap: 0.25rem;
  padding: 0.5rem;
  border-radius: 14px;
  background: ${(props) => props.theme.colours.surface};
  border: 1px solid ${(props) => props.theme.colours.border};
`;

/** A rule across the column with the part's own label sitting inside it. */
const PartDivider = styled.div`
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 1rem 0.75rem 0.5rem;
`;

const PartDividerRule = styled.span`
  flex: 1;
  height: 1px;
  background: ${(props) => props.theme.colours.border};
`;

const PartDividerButton = styled.button`
  flex-shrink: 0;
  padding: 0.1875rem 0.5rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  color: ${(props) => props.theme.colours.textSecondary};
  transition: color 0.15s ease;

  &:hover {
    color: ${(props) => props.theme.colours.textPrimary};
  }
`;

/**
 * A div rather than a button: the words inside it are themselves seek targets,
 * and interactive content nested in a button is invalid HTML (and unreachable
 * for assistive technology). Keyboard support is wired up explicitly instead.
 *
 * The left rule carries the speaker's colour and is present (transparent) on
 * every line so that becoming the spoken line never shifts the text sideways.
 */
const Line = styled.div<{ active: boolean; playing: boolean; speaker: 1 | 2 }>`
  display: flex;
  gap: 0.625rem;
  align-items: baseline;
  width: 100%;
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  border-left: 2px solid
    ${(props) =>
      props.active
        ? props.speaker === 1
          ? props.theme.colours.speaker1
          : props.theme.colours.speaker2
        : 'transparent'};
  cursor: pointer;
  background: ${(props) =>
    props.active && props.playing ? props.theme.colours.accentSoft : 'transparent'};
  transition: background 0.15s ease;

  &:hover {
    background: ${(props) => props.theme.colours.surfaceAlternate};
  }
`;

const SpeakerTag = styled.span<{ speaker: 1 | 2 }>`
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-weight: 700;
  color: ${(props) =>
    props.speaker === 1 ? props.theme.colours.speaker1 : props.theme.colours.speaker2};
`;

/**
 * `dimmed` is the whole of the stopped/playing duality: nothing is dimmed until
 * the audio is actually running.
 */
const LineText = styled.span<{ dimmed: boolean }>`
  font-size: 1.0625rem;
  line-height: 1.85;
  color: ${(props) =>
    props.dimmed ? props.theme.colours.textSecondary : props.theme.colours.textPrimary};
`;

/**
 * The spoken word. Two things are deliberate about its colour.
 *
 * It is `accentText`, not `accent`: at 17px on the light theme's accentSoft wash
 * the raw mustard measures 2.06 against the 4.5 AA needs, which is exactly the
 * case the doc bans (small mustard text on a light ground). `accentText` is the
 * same hue taken to reading lightness — see the measured table in tokens.ts.
 *
 * And it is gated on `dimmed`, i.e. on the audio actually running. Pausing
 * mid-line leaves `activeWordIndex` where it was, so without the gate one word
 * would stay coloured while stopped and break the rule that a stopped
 * transcript is uniformly `textPrimary`. Weight 700 does survive the pause: it
 * marks where the reader left off without touching legibility.
 */
const Word = styled.span<{ level: number; dimmed: boolean; seekable: boolean }>`
  opacity: ${(props) => (props.dimmed ? (WORD_LEVEL_OPACITY[props.level] ?? 1) : 1)};
  font-weight: ${(props) => (props.level === 6 ? 700 : 400)};
  color: ${(props) =>
    props.dimmed && props.level === 6 ? props.theme.colours.accentText : 'inherit'};
  cursor: ${(props) => (props.seekable ? 'pointer' : 'inherit')};
  transition: opacity 0.15s ease;
`;

const chipRise = keyframes`
  from { opacity: 0; transform: translate(-50%, 0.5rem); }
  to { opacity: 1; transform: translate(-50%, 0); }
`;

/**
 * Floats above the transport bar (which owns z-index 20) rather than inside the
 * transcript, because the reader who needs it has scrolled the spoken line off
 * screen. Mustard is allowed here under the single-meaning rule: the chip is
 * about where playback currently is.
 *
 * The offset clears the transport bar, which stands about 9rem tall including
 * its own bottom inset; the page reserves 11rem below the transcript for it.
 * If the bar ever grows, this is the number that has to grow with it.
 */
const ResumeFollowChip = styled.button`
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: max(10.25rem, calc(env(safe-area-inset-bottom) + 9.75rem));
  z-index: 21;
  padding: 0.4375rem 0.9375rem;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 700;
  cursor: pointer;
  color: ${(props) => props.theme.colours.accentInk};
  background: ${(props) => props.theme.colours.accent};
  box-shadow: 0 6px 18px rgba(21, 29, 42, 0.28);
  animation: ${chipRise} 0.2s ease;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

export interface ScriptFollowerProps {
  parts: PublicSharePart[];
  currentPartArrayIndex: number;
  activeLineIndex: number;
  activeWordIndex: number;
  /**
   * Whether the audio is actually running. Optional, and false by default, so
   * the transcript degrades to its fully legible reading state rather than to a
   * page of grey text when a caller has not wired it up yet.
   */
  isPlaying?: boolean;
  followEnabled: boolean;
  onFollowEnabledChange: (enabled: boolean) => void;
  onSeekLine: (partArrayIndex: number, lineIndex: number) => void;
  onSeekWord: (partArrayIndex: number, lineIndex: number, wordIndex: number) => void;
}

export function ScriptFollower({
  parts,
  currentPartArrayIndex,
  activeLineIndex,
  activeWordIndex,
  isPlaying = false,
  followEnabled,
  onFollowEnabledChange,
  onSeekLine,
  onSeekWord,
}: ScriptFollowerProps) {
  const activeLineRef = useRef<HTMLDivElement>(null);
  const [resumeChipVisible, setResumeChipVisible] = useState(false);
  const coarsePointer = useMediaQueryMatches(COARSE_POINTER_QUERY);
  const prefersReducedMotion = useMediaQueryMatches(REDUCED_MOTION_QUERY);
  const entries = flattenScriptLines(parts);
  const isMultiPart = parts.length > 1;
  const hasActiveLine = activeLineIndex !== NO_ACTIVE_INDEX;

  /* Timestamp until which scroll-ish events are treated as the tail of this
     component's own scrollIntoView rather than as the reader taking over. */
  const scrollSettledAtRef = useRef(0);

  const scrollToActiveLine = useCallback(() => {
    const node = activeLineRef.current;
    if (node === null) {
      return;
    }
    scrollSettledAtRef.current = Date.now() + FOLLOW_SCROLL_SETTLE_MILLISECONDS;
    node.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
  }, [prefersReducedMotion]);

  useEffect(() => {
    if (!followEnabled || !hasActiveLine) {
      return;
    }
    scrollToActiveLine();
  }, [
    followEnabled,
    hasActiveLine,
    activeLineIndex,
    currentPartArrayIndex,
    scrollToActiveLine,
  ]);

  /* Only listen while follow could actually yank the page: before playback has
     put a line on screen, scrolling is just reading and must not disable it. */
  useEffect(() => {
    if (!followEnabled || !hasActiveLine) {
      return;
    }
    const handleIntervention = () => {
      if (Date.now() < scrollSettledAtRef.current) {
        return;
      }
      onFollowEnabledChange(false);
      setResumeChipVisible(true);
    };
    window.addEventListener('wheel', handleIntervention, { passive: true });
    window.addEventListener('touchmove', handleIntervention, { passive: true });
    return () => {
      window.removeEventListener('wheel', handleIntervention);
      window.removeEventListener('touchmove', handleIntervention);
    };
  }, [followEnabled, hasActiveLine, onFollowEnabledChange]);

  /* Turning follow back on by any route — the chip or the manual toggle —
     retires the chip. */
  useEffect(() => {
    if (followEnabled) {
      setResumeChipVisible(false);
    }
  }, [followEnabled]);

  return (
    <Panel aria-label="대본">
      <PanelHeader>
        <PanelTitle>대본</PanelTitle>
        <FollowToggle
          type="button"
          enabled={followEnabled}
          aria-pressed={followEnabled}
          onClick={() => onFollowEnabledChange(!followEnabled)}
        >
          {followEnabled ? '따라가기 켜짐' : '따라가기 꺼짐'}
        </FollowToggle>
      </PanelHeader>

      <Lines>
        {entries.map((entry) => {
          const isActive =
            entry.partArrayIndex === currentPartArrayIndex &&
            entry.lineIndex === activeLineIndex;
          const words = isActive
            ? findSegmentForLine(parts[entry.partArrayIndex], entry.lineIndex)?.words
            : undefined;
          const key = `${entry.partArrayIndex}-${entry.lineIndex}`;
          const partLabel = `${entry.partNumber}부 · ${formatDurationLabel(
            parts[entry.partArrayIndex].durationMs,
          )}`;

          return (
            <div key={key}>
              {isMultiPart && entry.startsPart && (
                <PartDivider>
                  <PartDividerRule aria-hidden="true" />
                  <PartDividerButton
                    type="button"
                    aria-label={`${partLabel}, 처음부터 재생`}
                    onClick={() => onSeekLine(entry.partArrayIndex, 0)}
                  >
                    {partLabel}
                  </PartDividerButton>
                  <PartDividerRule aria-hidden="true" />
                </PartDivider>
              )}
              <Line
                role="button"
                tabIndex={0}
                active={isActive}
                playing={isPlaying}
                speaker={entry.line.speaker}
                aria-current={isActive}
                aria-label={`${SPEAKER_LABELS[entry.line.speaker]}: ${entry.line.text}`}
                ref={isActive ? activeLineRef : undefined}
                onClick={() => onSeekLine(entry.partArrayIndex, entry.lineIndex)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSeekLine(entry.partArrayIndex, entry.lineIndex);
                  }
                }}
              >
                <SpeakerTag speaker={entry.line.speaker}>
                  {SPEAKER_LABELS[entry.line.speaker]}
                </SpeakerTag>
                <LineText dimmed={isPlaying && !isActive}>
                  {words !== undefined && words.length > 0
                    ? words.map((word, wordIndex) => (
                        <Word
                          key={wordIndex}
                          dimmed={isPlaying}
                          seekable={!coarsePointer}
                          level={
                            activeWordIndex < 0
                              ? 2
                              : wordLevelForDistance(Math.abs(wordIndex - activeWordIndex))
                          }
                          onClick={
                            coarsePointer
                              ? undefined
                              : (event) => {
                                  event.stopPropagation();
                                  onSeekWord(
                                    entry.partArrayIndex,
                                    entry.lineIndex,
                                    wordIndex,
                                  );
                                }
                          }
                        >
                          {word.text}
                          {wordIndex < words.length - 1 ? ' ' : ''}
                        </Word>
                      ))
                    : entry.line.text}
                </LineText>
              </Line>
            </div>
          );
        })}
      </Lines>

      {resumeChipVisible && (
        <ResumeFollowChip
          type="button"
          onClick={() => {
            onFollowEnabledChange(true);
            setResumeChipVisible(false);
            scrollToActiveLine();
          }}
        >
          따라가기 재개
        </ResumeFollowChip>
      )}
    </Panel>
  );
}
