/**
 * The hero: an episode card whose artwork IS the newscast.
 *
 * One vertical bar per spoken line, its height the line's duration and its
 * colour the anchor who says it — drawn straight from `parts[].segments`, so the
 * card costs zero extra payload and no two newscasts look alike. As playback
 * advances the bars behind the playhead flip to the accent, which makes the
 * card a progress display as well as artwork (design doc §7).
 *
 * The big play button sits on top because, before the first tap, this is the
 * ONLY transport on the page — the floating bar stays away until playback has
 * actually started.
 */

import { memo, useMemo } from 'react';
import styled from '@emotion/styled';
import { keyframes, useTheme } from '@emotion/react';
import type { PublicSharePart } from '../schemas/public-share-view.ts';
import { LIGHT_THEME } from '../themes/tokens.ts';
import { TransportGlyph } from './TransportGlyph.tsx';

/**
 * The accent is a light mustard in BOTH themes, so the glyph sitting on it is
 * dark ink in both — the one place a colour cannot follow the active theme.
 */
const ACCENT_INK = LIGHT_THEME.colours.textPrimary;

/*
   Geometry in viewBox units. The SVG is stretched to the card
   (preserveAspectRatio="none"), so the horizontal unit is a percentage of the
   card's width and the vertical one a percentage of its height.
 */
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
/** Ceiling on a bar's thickness, so a five-line newscast gets bars, not slabs. */
const WIDEST_BAR = 40;
/** Share of its slot a bar occupies before that ceiling applies. */
const BAR_SHARE = 0.55;
/** A part boundary is worth this many extra slots of silence. */
const PART_GAP_SLOTS = 1.5;
const SHORTEST_BAR = 14;
const TALLEST_BAR = 88;

interface WaveformBar {
  key: string;
  x: number;
  width: number;
  height: number;
  speaker: 1 | 2;
  /** Where this line starts on the WHOLE-newscast timeline, in milliseconds. */
  startMilliseconds: number;
}

/**
 * Bar heights are normalised against the longest line in the newscast rather
 * than against an absolute number of seconds: what the reader should see is the
 * RHYTHM of the conversation, and a newscast of uniformly short lines should
 * still fill the card.
 *
 * Widths adapt the other way round. The bars always span the card, but a short
 * newscast widens the GAPS rather than the bars themselves — five lines read as
 * a sparse rhythm chart instead of five slabs.
 */
function buildWaveform(parts: PublicSharePart[]): WaveformBar[] {
  const lineCount = parts.reduce((total, part) => total + part.segments.length, 0);
  if (lineCount === 0) {
    return [];
  }

  const longestMilliseconds = parts.reduce(
    (longest, part) =>
      part.segments.reduce(
        (innerLongest, segment) => Math.max(innerLongest, segment.durationMs),
        longest,
      ),
    1,
  );

  const slotCount = lineCount + Math.max(parts.length - 1, 0) * PART_GAP_SLOTS;
  const slot = VIEW_WIDTH / slotCount;
  const barWidth = Math.min(slot * BAR_SHARE, WIDEST_BAR);
  let x = 0;

  const bars: WaveformBar[] = [];
  let partStartMilliseconds = 0;

  parts.forEach((part, partArrayIndex) => {
    if (partArrayIndex > 0) {
      x += slot * PART_GAP_SLOTS;
    }
    for (const segment of part.segments) {
      const ratio = Math.min(Math.max(segment.durationMs, 0) / longestMilliseconds, 1);
      bars.push({
        key: `${partArrayIndex}-${segment.index}`,
        x: x + (slot - barWidth) / 2,
        width: barWidth,
        height: SHORTEST_BAR + (TALLEST_BAR - SHORTEST_BAR) * ratio,
        speaker: part.script[segment.index]?.speaker ?? 1,
        startMilliseconds: partStartMilliseconds + segment.startMs,
      });
      x += slot;
    }
    partStartMilliseconds += part.durationMs ?? 0;
  });

  return bars;
}

const equalise = keyframes`
  0%, 100% { transform: scaleY(0.35); }
  50% { transform: scaleY(1); }
`;

const Card = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 9.5rem;
  padding: 1.25rem;
  border-radius: 18px;
  overflow: hidden;
  background: ${(props) => props.theme.colours.surface};
  border: 1px solid ${(props) => props.theme.colours.border};
`;

/*
   The frame does the positioning and the SVG fills it. An <svg> is a replaced
   element, so an absolutely positioned one with all four insets set would keep
   its intrinsic 300x150 rather than stretch to the box.
 */
const WaveformFrame = styled.div`
  position: absolute;
  inset: 1.25rem;
`;

const Waveform = styled.svg`
  display: block;
  width: 100%;
  height: 100%;
`;

const PlayButton = styled.button`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3.75rem;
  height: 3.75rem;
  border-radius: 50%;
  cursor: pointer;
  color: ${ACCENT_INK};
  background: ${(props) => props.theme.colours.accent};
  box-shadow: 0 6px 18px rgba(21, 29, 42, 0.28);
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;

  &:hover {
    transform: scale(1.05);
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;

    &:hover {
      transform: none;
    }
  }
`;

const Equaliser = styled.span`
  position: absolute;
  top: 0.75rem;
  left: 0.875rem;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 0.875rem;
`;

const EqualiserBar = styled.span<{ delay: string }>`
  width: 3px;
  height: 100%;
  border-radius: 2px;
  transform-origin: bottom;
  background: ${(props) => props.theme.colours.accent};
  animation: ${equalise} 0.9s ease-in-out infinite;
  animation-delay: ${(props) => props.delay};

  @media (prefers-reduced-motion: reduce) {
    animation: none;
    transform: scaleY(0.6);
  }
`;

/**
 * Memoised on the COUNT of played bars rather than on the playhead: the audio
 * element fires `timeupdate` about four times a second, and a long newscast is
 * hundreds of rects. Redrawing only when the fill actually crosses another line
 * turns that into a handful of renders per minute.
 */
const WaveformBars = memo(function WaveformBars({
  bars,
  playedCount,
}: {
  bars: WaveformBar[];
  playedCount: number;
}) {
  const theme = useTheme();
  return (
    <WaveformFrame>
      <Waveform
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {bars.map((bar, index) => {
          const played = index < playedCount;
          const speakerColour =
            bar.speaker === 1 ? theme.colours.speaker1 : theme.colours.speaker2;
          return (
            <rect
              key={bar.key}
              x={bar.x}
              y={(VIEW_HEIGHT - bar.height) / 2}
              width={bar.width}
              height={bar.height}
              fill={played ? theme.colours.accent : speakerColour}
              opacity={played ? 1 : 0.75}
            />
          );
        })}
      </Waveform>
    </WaveformFrame>
  );
});

export interface WaveformEpisodeCardProps {
  parts: PublicSharePart[];
  /** Playhead on the whole-newscast timeline, in seconds. */
  overallSeconds: number;
  isPlaying: boolean;
  onTogglePlayback: () => void;
}

export function WaveformEpisodeCard({
  parts,
  overallSeconds,
  isPlaying,
  onTogglePlayback,
}: WaveformEpisodeCardProps) {
  const bars = useMemo(() => buildWaveform(parts), [parts]);

  // Strictly greater than zero: at rest the whole card must read as artwork, and
  // the first line starts at 0ms, so `<=` alone would pre-fill one bar.
  const elapsedMilliseconds = Math.max(overallSeconds, 0) * 1000;
  // A count rather than a per-bar flag, so the drawing memo only invalidates
  // when the fill actually reaches the next line. Bars are in playback order,
  // which is the order the parts and their segments arrive in.
  const playedCount =
    elapsedMilliseconds > 0
      ? bars.filter((bar) => bar.startMilliseconds <= elapsedMilliseconds).length
      : 0;

  return (
    <Card data-testid="waveform-episode-card">
      {bars.length > 0 && <WaveformBars bars={bars} playedCount={playedCount} />}

      {isPlaying && (
        <Equaliser aria-hidden="true" data-testid="playing-indicator">
          <EqualiserBar delay="0s" />
          <EqualiserBar delay="0.15s" />
          <EqualiserBar delay="0.3s" />
        </Equaliser>
      )}

      <PlayButton
        type="button"
        aria-label={isPlaying ? '뉴스캐스트 일시정지' : '뉴스캐스트 재생'}
        onClick={onTogglePlayback}
      >
        <TransportGlyph playing={isPlaying} size={26} />
      </PlayButton>
    </Card>
  );
}
