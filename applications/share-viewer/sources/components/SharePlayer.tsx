/**
 * The transport: play/pause, ±10초, a speed cycle, and ONE seek bar spanning the
 * whole newscast. Rendered as a floating bar fixed to the bottom of the
 * viewport, like the main application's player — the transcript scrolls behind
 * it.
 *
 * The slider is deliberately the WHOLE-newscast timeline even though the audio
 * element only ever holds one part: readers think in "somewhere in the eight
 * minutes", and part boundaries are an implementation detail of how the audio
 * was rendered. The boundaries are still drawn as notches, and the part chips
 * survive as a secondary jump control; the conversion from a whole-newscast
 * position back to (part, offset) happens in `useSharePlayback`.
 *
 * The bar does not exist until playback has started once — the hero card owns
 * the first tap (design doc §4), and its parent decides when to mount this.
 */

import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import type { PublicSharePart } from '../schemas/public-share-view.ts';
import { LIGHT_THEME } from '../themes/tokens.ts';
import {
  elapsedMillisecondsAcrossParts,
  formatPlaybackTime,
  partBoundaryFractions,
  totalDurationMilliseconds,
} from '../playback/timings.ts';
import { TransportGlyph } from './TransportGlyph.tsx';

/** Dark ink for glyphs sitting on the accent, which is mustard in both themes. */
const ACCENT_INK = LIGHT_THEME.colours.textPrimary;

const riseUp = keyframes`
  from { transform: translate(-50%, 120%); opacity: 0; }
  to { transform: translate(-50%, 0); opacity: 1; }
`;

const Panel = styled.section`
  position: fixed;
  bottom: max(0.875rem, env(safe-area-inset-bottom));
  left: 50%;
  transform: translateX(-50%);
  width: min(53.5rem, calc(100% - 1.5rem));
  z-index: 20;
  display: grid;
  gap: 0.625rem;
  padding: 0.875rem 1.125rem 1rem;
  border-radius: 16px;
  background: ${(props) => props.theme.colours.surface};
  border: 1px solid ${(props) => props.theme.colours.border};
  box-shadow: 0 10px 30px rgba(21, 29, 42, 0.22);
  animation: ${riseUp} 0.2s ease-out;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const TransportRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const PlayButton = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  cursor: pointer;
  color: ${ACCENT_INK};
  background: ${(props) => props.theme.colours.accent};
  transition: filter 0.15s ease;

  &:hover {
    filter: brightness(1.06);
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const SkipButton = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 44px tap target, per the accessibility checklist in design doc §10. */
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  cursor: pointer;
  color: ${(props) => props.theme.colours.textSecondary};

  &:hover {
    color: ${(props) => props.theme.colours.textPrimary};
    background: ${(props) => props.theme.colours.surfaceAlternate};
  }
`;

const RateButton = styled.button`
  flex-shrink: 0;
  margin-left: auto;
  min-width: 3.25rem;
  height: 2.25rem;
  padding: 0 0.625rem;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  color: ${(props) => props.theme.colours.textPrimary};
  background: ${(props) => props.theme.colours.surfaceAlternate};
  border: 1px solid ${(props) => props.theme.colours.border};
`;

const SeekRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.625rem;
`;

const SliderShell = styled.div`
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
`;

const Slider = styled.input`
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  height: 1.125rem;
  margin: 0;
  cursor: pointer;
  background: transparent;
  accent-color: ${(props) => props.theme.colours.accent};
`;

/**
 * Chapter marks, YouTube-style. Drawn ON TOP of the slider — a mark hidden
 * behind the track would be no mark at all — but with pointer events off, so
 * the slider still owns every drag. `surface` is the one colour that reads
 * against both the accent fill and the empty track, in either theme.
 */
const Notch = styled.span<{ fraction: number }>`
  position: absolute;
  top: 50%;
  left: ${(props) => props.fraction * 100}%;
  z-index: 2;
  width: 2px;
  height: 0.5rem;
  transform: translate(-50%, -50%);
  pointer-events: none;
  background: ${(props) => props.theme.colours.surface};
`;

const TimeText = styled.span`
  flex-shrink: 0;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: ${(props) => props.theme.colours.textSecondary};
`;

const PartChips = styled.div`
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
`;

const PartChip = styled.button<{ selected: boolean }>`
  padding: 0.1875rem 0.625rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 700;
  cursor: pointer;
  color: ${(props) =>
    props.selected ? props.theme.colours.surface : props.theme.colours.textSecondary};
  background: ${(props) =>
    props.selected ? props.theme.colours.brandPrimary : props.theme.colours.surfaceAlternate};
  border: 1px solid
    ${(props) =>
      props.selected ? props.theme.colours.brandPrimary : props.theme.colours.border};

  &:hover {
    color: ${(props) =>
      props.selected ? props.theme.colours.surface : props.theme.colours.textPrimary};
  }
`;

const SignalNotice = styled.p`
  margin: 0;
  font-size: 0.75rem;
  color: ${(props) => props.theme.colours.accent};
`;

/** ±N seconds, drawn as a circular arrow around the number. */
function SkipGlyph({ forward, seconds }: { forward: boolean; seconds: number }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g transform={forward ? undefined : 'translate(24, 0) scale(-1, 1)'}>
        <path
          d="M12 5V2L16.5 6L12 10V7a5.5 5.5 0 1 0 5.5 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <text
        x="12"
        y="15.5"
        textAnchor="middle"
        fontSize="8"
        fontWeight="700"
        fill="currentColor"
      >
        {seconds}
      </text>
    </svg>
  );
}

export interface SharePlayerProps {
  parts: PublicSharePart[];
  currentPartArrayIndex: number;
  /** Playhead inside the current part, in seconds. */
  currentSeconds: number;
  isPlaying: boolean;
  isSignalPhase: boolean;
  playbackRate: number;
  /** How far one ± button moves the playhead. */
  skipStepSeconds: number;
  onTogglePlayback: () => void;
  /** Receives a position on the WHOLE-newscast timeline, in seconds. */
  onSeekOverallSeconds: (seconds: number) => void;
  onSkipSeconds: (deltaSeconds: number) => void;
  onCyclePlaybackRate: () => void;
  onSelectPart: (partArrayIndex: number) => void;
}

export function SharePlayer({
  parts,
  currentPartArrayIndex,
  currentSeconds,
  isPlaying,
  isSignalPhase,
  playbackRate,
  skipStepSeconds,
  onTogglePlayback,
  onSeekOverallSeconds,
  onSkipSeconds,
  onCyclePlaybackRate,
  onSelectPart,
}: SharePlayerProps) {
  const totalSeconds = totalDurationMilliseconds(parts) / 1000;
  const elapsedSeconds = Math.min(
    elapsedMillisecondsAcrossParts(parts, currentPartArrayIndex, currentSeconds * 1000) /
      1000,
    totalSeconds,
  );
  const boundaries = partBoundaryFractions(parts);
  const rateLabel = `${playbackRate}×`;

  return (
    <Panel aria-label="재생 컨트롤">
      <TransportRow>
        <SkipButton
          type="button"
          aria-label={`${skipStepSeconds}초 뒤로`}
          onClick={() => onSkipSeconds(-skipStepSeconds)}
        >
          <SkipGlyph forward={false} seconds={skipStepSeconds} />
        </SkipButton>
        <PlayButton
          type="button"
          aria-label={isPlaying ? '일시정지' : '재생'}
          onClick={onTogglePlayback}
        >
          <TransportGlyph playing={isPlaying} />
        </PlayButton>
        <SkipButton
          type="button"
          aria-label={`${skipStepSeconds}초 앞으로`}
          onClick={() => onSkipSeconds(skipStepSeconds)}
        >
          <SkipGlyph forward={true} seconds={skipStepSeconds} />
        </SkipButton>
        <RateButton
          type="button"
          aria-label={`재생 속도 ${playbackRate}배`}
          onClick={onCyclePlaybackRate}
        >
          {rateLabel}
        </RateButton>
      </TransportRow>

      <SeekRow>
        <TimeText>{formatPlaybackTime(elapsedSeconds)}</TimeText>
        <SliderShell>
          {boundaries.map((fraction) => (
            <Notch
              key={fraction}
              fraction={fraction}
              aria-hidden="true"
              data-testid="part-boundary-notch"
            />
          ))}
          <Slider
            type="range"
            min={0}
            max={totalSeconds}
            step={0.1}
            value={Math.max(Math.min(elapsedSeconds, totalSeconds), 0)}
            aria-label="재생 위치"
            aria-valuetext={`${formatPlaybackTime(elapsedSeconds)} / ${formatPlaybackTime(totalSeconds)}`}
            onChange={(event) => onSeekOverallSeconds(Number(event.target.value))}
          />
        </SliderShell>
        <TimeText>{formatPlaybackTime(totalSeconds)}</TimeText>
      </SeekRow>

      {parts.length > 1 && (
        <PartChips role="group" aria-label="파트 선택">
          {parts.map((part, partArrayIndex) => (
            <PartChip
              key={part.index}
              type="button"
              selected={partArrayIndex === currentPartArrayIndex}
              aria-current={partArrayIndex === currentPartArrayIndex}
              aria-label={`${part.index}부 재생`}
              onClick={() => onSelectPart(partArrayIndex)}
            >
              {part.index}부
            </PartChip>
          ))}
        </PartChips>
      )}

      {isSignalPhase && <SignalNotice>다음 파트로 넘어가는 중…</SignalNotice>}
    </Panel>
  );
}
