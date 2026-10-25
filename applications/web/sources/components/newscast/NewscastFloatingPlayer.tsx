/**
 * The floating playback bar — the page's ONE audio surface, docked to the
 * bottom of the viewport so listening survives list browsing, detail switching,
 * and the New newscast panel. Listening is decoupled from inspection: the bar
 * binds to `playingJobID` and only an explicit Play elsewhere rebinds it.
 *
 * Anatomy: a caption strip (current spoken line, word spotlight — tap to open
 * the full-script dialog) above a transport row (play/pause · title, which
 * jumps the selection to the playing newscast · seek slider with times · full
 * script · close). The page remounts this component per newscast
 * (`key={jobID}`) so switching newscasts starts from clean playback state.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faList, faPause, faPlay, faXmark } from '@fortawesome/free-solid-svg-icons';
import type {
  NewscastPart,
  NewscastResult,
} from '@audio-underview/newscast-core';

import {
  CaptionLineView,
  FullScriptDialog,
  SPEAKER_LABELS,
  SpeakerTag,
} from './ScriptCaptions.tsx';

const Bar = styled.div`
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 90;
  background: var(--bg-surface);
  border-top: 1px solid var(--border-subtle);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.25);
  padding-bottom: env(safe-area-inset-bottom);
`;

const Inner = styled.div`
  max-width: 96rem;
  margin: 0 auto;
  padding: 0.75rem 1.25rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

/**
 * The caption strip is a passive display: tapping anywhere on it opens the
 * full-script dialog (word-level seeking lives there, where targets are big
 * enough). It shows a 3-line window — the previous and next lines truncated
 * and dimmed for context, the spoken line full with the word spotlight.
 */
const CaptionStrip = styled.button`
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  width: 100%;
  text-align: left;
  cursor: pointer;
  border-radius: 8px;
`;

/** A dimmed, single-row (ellipsized) neighbor line above/below the spoken one. */
const NeighborLine = styled.span`
  display: flex;
  gap: 0.625rem;
  align-items: baseline;
  padding: 0.125rem 0.75rem;
  opacity: 0.45;
  overflow: hidden;
`;

const NeighborText = styled.span`
  font-size: 0.8125rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Transport = styled.div`
  display: flex;
  align-items: center;
  gap: 0.875rem;
`;

const PlayButton = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  font-size: 1rem;
  background: var(--accent-primary);
  color: #ffffff;
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    filter: brightness(1.15);
  }
`;

const Middle = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
`;

const TitleButton = styled.button`
  align-self: flex-start;
  max-width: 100%;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;

  &:hover {
    color: var(--accent-primary);
  }
`;

/** Part transport chips (`Part 1 Part 2 Part 3`), shown only when parts.length > 1. */
const PartChips = styled.div`
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
`;

const PartChip = styled.button<{ active: boolean }>`
  flex-shrink: 0;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 700;
  font-family: var(--font-mono);
  cursor: pointer;
  color: ${(props) => (props.active ? '#ffffff' : 'var(--text-secondary)')};
  background: ${(props) => (props.active ? 'var(--accent-primary)' : 'var(--bg-deep)')};
  border: 1px solid
    ${(props) => (props.active ? 'var(--accent-primary)' : 'var(--border-subtle)')};
  transition: var(--transition-fast);

  &:hover {
    color: ${(props) => (props.active ? '#ffffff' : 'var(--text-primary)')};
  }
`;

const SeekRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.625rem;
`;

const Slider = styled.input`
  flex: 1;
  min-width: 0;
  accent-color: var(--accent-primary);
  cursor: pointer;
  height: 1.125rem;
`;

const TimeText = styled.span`
  flex-shrink: 0;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
`;

const IconButton = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 10px;
  font-size: 1rem;
  color: var(--text-secondary);
  cursor: pointer;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

/**
 * How long the between-parts transition sting plays before the next part starts.
 * Lyria clips are always a full 30-second clip, so playing one to its natural end
 * would leave a long, dead gap between parts; we cap it at 3s and move on. The
 * `ended`/`error` events still advance immediately when they fire first (a clip
 * shorter than the cap, or a load failure).
 */
const SIGNAL_PLAYBACK_MILLISECONDS = 3000;

/**
 * Hard ceiling on the whole signal phase. If the sting never produces ANY media
 * event (a stalled fetch yields no `timeupdate`, no `ended`, no `error`), the
 * player would otherwise hang between parts forever — after this long we give
 * up on the sting and advance regardless.
 */
const SIGNAL_SAFETY_TIMEOUT_MILLISECONDS = 5000;

/** m:ss for the transport row (audio-player style, not telemetry style). */
function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** Imperative surface for the page: toggle play/pause from the detail hero. */
export interface NewscastFloatingPlayerHandle {
  toggle: () => void;
}

export interface NewscastFloatingPlayerProps {
  title: string;
  result: NewscastResult;
  /**
   * The audio URL without a part, which the worker answers with part 1. Used as
   * the `<audio>` src only for a result without `result.parts`.
   */
  audioURL: string;
  /**
   * Per-part audio URL builder (`partIndex` is 1-based). When present with
   * `result.parts`, the bar points its single `<audio>` at the CURRENT part's URL
   * instead of `audioURL`.
   */
  audioURLForPart?: (partIndex: number) => string;
  /**
   * Optional signal sound played BETWEEN parts before advancing. Left unset when
   * the newscast has no sting (the parts then advance immediately).
   */
  partTransitionAudioURL?: string;
  /** Close the bar (stops playback — the page clears `playingJobID`). */
  onClose: () => void;
  /** Jump the page selection to the playing newscast (bar title click). */
  onJumpToJob: () => void;
  /** Mirrors the audio element's play/pause state up to the page. */
  onPlayingChange: (isPlaying: boolean) => void;
}

export const NewscastFloatingPlayer = forwardRef<
  NewscastFloatingPlayerHandle,
  NewscastFloatingPlayerProps
>(function NewscastFloatingPlayer(
  {
    title,
    result,
    audioURL,
    audioURLForPart,
    partTransitionAudioURL,
    onClose,
    onJumpToJob,
    onPlayingChange,
  },
  ref,
) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scriptDialogOpen, setScriptDialogOpen] = useState(false);
  // 0-based index into `parts`. Advances on `ended`, or jumps on a chip click.
  const [currentPartIndex, setCurrentPartIndex] = useState(0);
  // True while the between-parts sting occupies the ONE <audio> element. The
  // sting reuses the main element (not a fresh `new Audio()`) because mobile
  // autoplay policies only trust the element the user originally activated —
  // a fresh element's play() gets rejected with no gesture and the hand-off
  // silently died (the original "auto-advance stopped" bug).
  const [isSignalPhase, setIsSignalPhase] = useState(false);
  // Exactly-once guard for finishing the current signal phase (the 3s cap,
  // `ended`, `error`, and the safety timeout can all race for it).
  const signalFinishedRef = useRef(false);

  // A result without `result.parts` is shown as a single synthetic part built from
  // the top-level fields, so every downstream code path (audio src, captions,
  // chips, dialog) is uniformly part-shaped. `durationMs` is unused for playback
  // (the audio element owns duration), so 0 is harmless.
  const parts: NewscastPart[] = result.parts ?? [
    {
      index: 1,
      audioKey: result.audioKey,
      script: result.script,
      segments: result.segments,
      durationMs: 0,
    },
  ];
  const usePartURLs = result.parts !== undefined && audioURLForPart !== undefined;
  const currentPart = parts[currentPartIndex] ?? parts[0];
  const isLastPart = currentPartIndex >= parts.length - 1;

  const segments = currentPart.segments;
  const lines = currentPart.script;
  // Multi-part results point the single <audio> at the current part; a result
  // without parts (and the defensive no-builder case) keeps `audioURL`.
  // During the signal phase, the SAME element temporarily hosts the sting.
  //
  // A part's URL is built ONCE, when the part starts, and held for as long as
  // the part plays. The builder appends a media token that the page refreshes
  // in the background, and a changed `src` makes the browser drop its buffer
  // and restart the track from 0:00 — which is exactly what listeners saw
  // ("rewinds to the start of the part"). A URL built before the token landed
  // carries none and is not held, so the tokened rebuild replaces it before
  // anything could play. The map lives per mount; the page remounts this
  // component per newscast.
  const heldAudioURLsRef = useRef(new Map<string, string>());
  const holdAudioURL = (key: string, build: () => string): string => {
    const held = heldAudioURLsRef.current.get(key);
    if (held !== undefined) {
      return held;
    }
    const built = build();
    if (built.includes('token=')) {
      heldAudioURLsRef.current.set(key, built);
    }
    return built;
  };
  const currentPartAudioURL = usePartURLs
    ? holdAudioURL(`part:${currentPart.index}`, () =>
        (audioURLForPart as (partIndex: number) => string)(currentPart.index),
      )
    : holdAudioURL('whole', () => audioURL);
  const currentAudioURL =
    isSignalPhase && partTransitionAudioURL !== undefined
      ? partTransitionAudioURL
      : currentPartAudioURL;

  // Play the current part from its start. Skipped on first mount — the
  // `<audio autoPlay>` attribute already starts part 1, so calling play() here
  // would race it; every LATER part change (chip click / auto-advance) plays.
  const isFirstPartRender = useRef(true);
  useEffect(() => {
    // A new part's segments differ, so drop stale caption/word highlights until
    // the first timeupdate of the new audio recomputes them.
    setActiveIndex(-1);
    setActiveWordIndex(-1);
    setCurrentTime(0);
    lastTimeMillisecondsRef.current = 0;
    if (isFirstPartRender.current) {
      isFirstPartRender.current = false;
      return;
    }
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    // The src attribute already changed with this render; play the new part.
    void audio.play().catch(() => undefined);
  }, [currentPartIndex]);

  // Surface the newscast in the OS media notification. Without metadata,
  // Android/Chrome falls back to the page title + origin; with it, the bold line
  // is the newscast title (suffixed with the part number when there are several)
  // and the dim line is the app name. Cleared on unmount so closing the player
  // also clears the notification.
  useEffect(() => {
    if (!('mediaSession' in navigator)) {
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: parts.length > 1 ? `${title} — Part ${currentPart.index}` : title,
      artist: 'Audio Underview',
    });
    return () => {
      navigator.mediaSession.metadata = null;
    };
  }, [title, currentPart.index, parts.length]);

  // Let the media notification's play/pause buttons drive the same single
  // <audio> element the bar owns, keeping page and notification in sync.
  useEffect(() => {
    if (!('mediaSession' in navigator)) {
      return;
    }
    navigator.mediaSession.setActionHandler('play', () => {
      void audioRef.current?.play().catch(() => undefined);
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      audioRef.current?.pause();
    });
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
    };
  }, []);

  // Drive the signal phase on the main element: play the sting (this render
  // just swapped it into `src`) and arm the stall safety net.
  useEffect(() => {
    if (!isSignalPhase) {
      return;
    }
    const audio = audioRef.current;
    if (audio !== null) {
      void audio.play().catch(() => finishSignalPhase());
    }
    const safety = setTimeout(() => finishSignalPhase(), SIGNAL_SAFETY_TIMEOUT_MILLISECONDS);
    return () => clearTimeout(safety);
  }, [isSignalPhase]);

  // A seek target (ms) to apply once the NEXT part's audio reports its metadata
  // — set when a full-script line in another part is clicked. null = play from 0.
  const pendingSeekMillisecondsRef = useRef<number | null>(null);

  // Safety net under the held URLs above: if the src of the SAME part still
  // changes (a rebuilt URL), the browser has already reset to 0:00 by the time
  // this effect runs, so queue the last known position to be restored when the
  // new load reports its metadata. Part changes and the sting are excluded —
  // those are meant to start from 0.
  const lastTimeMillisecondsRef = useRef(0);
  // Mirror the slider's time into the ref from an effect (not from the
  // timeupdate handler) so the swap effect below reads the last position
  // without re-running on every tick.
  useEffect(() => {
    lastTimeMillisecondsRef.current = currentTime * 1000;
  }, [currentTime]);
  const appliedSourceRef = useRef<{ partIndex: number; url: string } | null>(null);
  useEffect(() => {
    const previous = appliedSourceRef.current;
    appliedSourceRef.current = { partIndex: currentPart.index, url: currentAudioURL };
    if (
      isSignalPhase ||
      previous === null ||
      previous.partIndex !== currentPart.index ||
      previous.url === currentAudioURL ||
      previous.url === partTransitionAudioURL
    ) {
      return;
    }
    if (lastTimeMillisecondsRef.current > 0) {
      pendingSeekMillisecondsRef.current = lastTimeMillisecondsRef.current;
    }
  }, [currentAudioURL, currentPart.index, isSignalPhase, partTransitionAudioURL]);

  useImperativeHandle(ref, () => ({
    toggle: () => {
      const audio = audioRef.current;
      if (audio === null) {
        return;
      }
      if (audio.paused) {
        if (audio.ended) {
          audio.currentTime = 0;
        }
        void audio.play();
      } else {
        audio.pause();
      }
    },
  }));

  // Advance to the next part (its src change + the part effect start playback).
  const advanceToNextPart = () => {
    if (isLastPart) {
      return;
    }
    pendingSeekMillisecondsRef.current = null;
    setCurrentPartIndex(currentPartIndex + 1);
  };

  /**
   * End the signal phase and hand off to the next part, exactly once — the 3s
   * cap, the clip's natural `ended`, a load/playback `error`, and the safety
   * timeout can all race for this.
   */
  const finishSignalPhase = () => {
    if (signalFinishedRef.current) {
      return;
    }
    signalFinishedRef.current = true;
    setIsSignalPhase(false);
    advanceToNextPart();
  };

  // Auto-advance when a part's audio ends: stop on the last part, otherwise move
  // on — playing the transition sting (capped) through the SAME element first.
  const handleEnded = () => {
    if (isSignalPhase) {
      // The sting clip itself finished before the 3s cap.
      finishSignalPhase();
      return;
    }
    if (isLastPart) {
      setPlaying(false);
      return;
    }
    if (partTransitionAudioURL !== undefined) {
      signalFinishedRef.current = false;
      setIsSignalPhase(true);
      return;
    }
    advanceToNextPart();
  };

  // Chip click: play the picked part from its start.
  const selectPart = (partArrayIndex: number) => {
    if (partArrayIndex === currentPartIndex) {
      const audio = audioRef.current;
      if (audio !== null) {
        audio.currentTime = 0;
        void audio.play().catch(() => undefined);
      }
      return;
    }
    pendingSeekMillisecondsRef.current = null;
    setCurrentPartIndex(partArrayIndex);
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    if (isSignalPhase) {
      // Cap the sting (Lyria clips run a full 30s) and keep the part's
      // captions/slider frozen while it plays.
      if (audio.currentTime * 1000 >= SIGNAL_PLAYBACK_MILLISECONDS) {
        finishSignalPhase();
      }
      return;
    }
    setCurrentTime(audio.currentTime);
    const currentMilliseconds = audio.currentTime * 1000;
    const active = segments.find(
      (segment) =>
        currentMilliseconds >= segment.startMs && currentMilliseconds < segment.startMs + segment.durationMs,
    );
    setActiveIndex(active !== undefined ? active.index : -1);
    const wordIndex =
      active?.words !== undefined
        ? active.words.findIndex(
            (word) => currentMilliseconds >= word.startMs && currentMilliseconds < word.endMs,
          )
        : -1;
    setActiveWordIndex(wordIndex);
  };

  const setPlaying = (playing: boolean) => {
    setIsPlaying(playing);
    onPlayingChange(playing);
  };

  const seekToLine = (index: number) => {
    const audio = audioRef.current;
    const segment = segments.find((candidate) => candidate.index === index);
    if (audio === null || segment === undefined) {
      return;
    }
    audio.currentTime = segment.startMs / 1000;
  };

  // Full-script line click in ANOTHER part: switch to it, then seek to that
  // line once the new part's metadata lands (handled in onLoadedMetadata).
  const seekToPartLine = (partArrayIndex: number, lineIndex: number) => {
    if (partArrayIndex === currentPartIndex) {
      seekToLine(lineIndex);
      return;
    }
    const targetSegment = parts[partArrayIndex]?.segments.find(
      (candidate) => candidate.index === lineIndex,
    );
    pendingSeekMillisecondsRef.current = targetSegment !== undefined ? targetSegment.startMs : 0;
    setCurrentPartIndex(partArrayIndex);
  };

  const seekToWord = (event: React.MouseEvent, startMs: number) => {
    event.stopPropagation();
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    audio.currentTime = startMs / 1000;
  };

  const handleSeekInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    audio.currentTime = Number(event.target.value);
  };

  // Focus = the spoken line, or the first line before playback starts. The
  // strip shows a 3-line window around it: dimmed truncated neighbors give the
  // conversation context, the spoken line carries the word spotlight.
  const focusIndex = activeIndex >= 0 ? activeIndex : 0;
  const focusLine = lines[focusIndex];
  const previousLine = lines[focusIndex - 1];
  const nextLine = lines[focusIndex + 1];
  const focusWords = segments[focusIndex]?.words;
  const wordTracked = focusWords !== undefined && focusWords.length > 0;

  return (
    <Bar>
      <audio
        ref={audioRef}
        src={currentAudioURL}
        autoPlay
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={(event) => {
          if (isSignalPhase) {
            // The sting's 30s metadata must not clobber the part's duration
            // display; the slider stays frozen on the part during the phase.
            return;
          }
          setDuration(event.currentTarget.duration);
          // Apply a cross-part line seek that was queued before this part loaded.
          if (pendingSeekMillisecondsRef.current !== null) {
            event.currentTarget.currentTime = pendingSeekMillisecondsRef.current / 1000;
            pendingSeekMillisecondsRef.current = null;
          }
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={handleEnded}
        onError={() => {
          // A sting that fails to load must not strand playback between parts.
          if (isSignalPhase) {
            finishSignalPhase();
          }
        }}
      />

      <Inner>
        {focusLine !== undefined && (
          <CaptionStrip
            type="button"
            aria-label="Open full script"
            onClick={() => setScriptDialogOpen(true)}
          >
            {previousLine !== undefined && (
              <NeighborLine>
                <SpeakerTag speaker={previousLine.speaker}>
                  {SPEAKER_LABELS[previousLine.speaker]}
                </SpeakerTag>
                <NeighborText>{previousLine.text}</NeighborText>
              </NeighborLine>
            )}
            <CaptionLineView
              line={focusLine}
              index={focusIndex}
              active={activeIndex === focusIndex}
              isCurrent={true}
              emphasis={true}
              segmentWords={focusWords}
              activeWordIndex={activeWordIndex}
              wordTracked={wordTracked}
              onLineClick={() => setScriptDialogOpen(true)}
            />
            {nextLine !== undefined && (
              <NeighborLine>
                <SpeakerTag speaker={nextLine.speaker}>
                  {SPEAKER_LABELS[nextLine.speaker]}
                </SpeakerTag>
                <NeighborText>{nextLine.text}</NeighborText>
              </NeighborLine>
            )}
          </CaptionStrip>
        )}

        <Transport>
          <PlayButton
            type="button"
            aria-label={isPlaying ? 'Pause' : 'Play'}
            onClick={() => {
              const audio = audioRef.current;
              if (audio === null) {
                return;
              }
              if (audio.paused) {
                if (audio.ended) {
                  audio.currentTime = 0;
                }
                void audio.play();
              } else {
                audio.pause();
              }
            }}
          >
            <FontAwesomeIcon icon={isPlaying ? faPause : faPlay} />
          </PlayButton>

          <Middle>
            <TitleButton type="button" onClick={onJumpToJob}>
              {title}
            </TitleButton>
            {parts.length > 1 && (
              <PartChips role="group" aria-label="Parts">
                {parts.map((part, partArrayIndex) => (
                  <PartChip
                    key={part.index}
                    type="button"
                    active={partArrayIndex === currentPartIndex}
                    aria-label={`Play part ${part.index}`}
                    aria-current={partArrayIndex === currentPartIndex}
                    onClick={() => selectPart(partArrayIndex)}
                  >
                    Part {part.index}
                  </PartChip>
                ))}
              </PartChips>
            )}
            <SeekRow>
              <TimeText>{formatPlaybackTime(currentTime)}</TimeText>
              <Slider
                type="range"
                min={0}
                max={duration > 0 ? duration : 0}
                step={0.1}
                value={Math.min(currentTime, duration > 0 ? duration : 0)}
                aria-label="Seek"
                onChange={handleSeekInput}
              />
              <TimeText>{formatPlaybackTime(duration)}</TimeText>
            </SeekRow>
          </Middle>

          <IconButton
            type="button"
            aria-label="Full script"
            onClick={() => setScriptDialogOpen(true)}
          >
            <FontAwesomeIcon icon={faList} />
          </IconButton>
          <IconButton type="button" aria-label="Close player" onClick={onClose}>
            <FontAwesomeIcon icon={faXmark} />
          </IconButton>
        </Transport>
      </Inner>

      <FullScriptDialog
        lines={lines}
        segments={segments}
        activeIndex={activeIndex}
        activeWordIndex={activeWordIndex}
        open={scriptDialogOpen}
        onOpenChange={setScriptDialogOpen}
        onSeekLine={seekToLine}
        onSeekWord={seekToWord}
        parts={parts.length > 1 ? parts : undefined}
        currentPartIndex={currentPartIndex}
        onSeekPartLine={seekToPartLine}
      />
    </Bar>
  );
});
