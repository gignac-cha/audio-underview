/**
 * All playback state for one shared newscast, driving a SINGLE `<audio>`
 * element.
 *
 * Ported from the web app's NewscastFloatingPlayer, minus
 * everything an owner-only surface needed. Two behaviours are worth keeping in
 * mind when reading it:
 *
 * 1. The between-parts sting reuses the SAME element rather than a fresh
 *    `new Audio()`. Mobile autoplay policies only trust the element the reader
 *    originally activated; a second element's `play()` is rejected with no
 *    gesture, which used to silently kill auto-advance.
 * 2. Seeks are part-relative. Crossing a part boundary means switching `src`
 *    first and applying the offset once the new part reports metadata — hence
 *    `pendingSeekMillisecondsRef`. Callers that think in whole-newscast seconds
 *    (the unified scrubber, the ±10s buttons, the OS media controls) go through
 *    `seekToOverallSeconds`, which does that conversion in one place.
 * 3. Speed and Media Session are best-effort: a browser without the API, or a
 *    reader with storage denied, loses the feature and nothing else.
 *
 * Unlike the main application there is no autoplay on mount: a shared link that
 * started talking the moment it opened would be hostile (and blocked anyway).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicSharePart } from '../schemas/public-share-view.ts';
import { SITE_NAME } from '../constants.ts';
import {
  NO_ACTIVE_INDEX,
  elapsedMillisecondsAcrossParts,
  findActiveLineIndex,
  findActiveWordIndex,
  findSegmentForLine,
  resolveLineSeek,
  resolveTimelineSeek,
  resolveWordSeek,
  totalDurationMilliseconds,
} from './timings.ts';

/**
 * How long the transition sting plays before the next part starts. The
 * generated clips are always a full 30 seconds, so playing one to its natural
 * end would leave a dead gap between parts.
 */
export const SIGNAL_PLAYBACK_MILLISECONDS = 3000;

/**
 * Ceiling on the whole signal phase. A stalled fetch produces no `timeupdate`,
 * no `ended`, and no `error`, which would otherwise hang playback between parts
 * forever — after this long we give up on the sting and advance anyway.
 */
export const SIGNAL_SAFETY_TIMEOUT_MILLISECONDS = 5000;

/** The speeds the transport cycles through, in order. */
export const PLAYBACK_RATES: readonly number[] = [1, 1.25, 1.5, 2];

/**
 * The second (and last) localStorage key this application writes — the reader's
 * chosen speed, remembered the way every podcast player does. Named like
 * `THEME_STORAGE_KEY` so the app's whole storage footprint stays greppable.
 */
export const PLAYBACK_RATE_STORAGE_KEY = 'audio-underview:share-viewer:playback-rate';

/** Fallback skip distance when the platform's media UI does not name one. */
export const MEDIA_SESSION_SEEK_SECONDS = 10;

/** Artwork handed to the OS lock screen; served from `public/`. */
const MEDIA_SESSION_ARTWORK_PATH = '/icon-512.png';

/**
 * `navigator.mediaSession` where the platform has it. KakaoTalk's in-app WebView
 * and older Safari do not, and every call site treats that as "no lock-screen
 * integration" rather than an error.
 */
function readMediaSession(): MediaSession | undefined {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return undefined;
  }
  return navigator.mediaSession;
}

/** A remembered speed, or 1 when nothing valid is stored (or storage is denied). */
function readStoredPlaybackRate(): number {
  try {
    const raw = window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY);
    if (raw === null) {
      return 1;
    }
    const parsed = Number.parseFloat(raw);
    return PLAYBACK_RATES.includes(parsed) ? parsed : 1;
  } catch {
    return 1;
  }
}

export interface SharedPlaybackOptions {
  parts: PublicSharePart[];
  /** Builds the MP3 URL for a 1-based part number. */
  partAudioUrl: (partIndex: number) => string;
  /** URL of the between-parts sting, or undefined when the job has none. */
  signalAudioUrl?: string;
  /** Shown on the lock screen and in earphone controls. */
  title?: string;
}

export interface SharePlayback {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  /** Whatever the single element should currently be pointed at. */
  audioSource: string;
  isPlaying: boolean;
  /** True while the transition sting occupies the element. */
  isSignalPhase: boolean;
  currentPartArrayIndex: number;
  currentPart: PublicSharePart;
  /** Playhead inside the current part, in seconds. */
  currentSeconds: number;
  /** Current part's duration in seconds, once the element reports it. */
  partDurationSeconds: number;
  activeLineIndex: number;
  activeWordIndex: number;
  /** Playhead on the WHOLE-newscast timeline, in seconds. */
  overallSeconds: number;
  /** Every part's duration summed, in seconds. */
  overallDurationSeconds: number;
  /** Current speed multiplier, remembered across visits. */
  playbackRate: number;
  togglePlayback: () => void;
  seekWithinPart: (seconds: number) => void;
  /** Seeks by whole-newscast position, crossing parts as needed. */
  seekToOverallSeconds: (seconds: number) => void;
  /** Moves the playhead by ±seconds along the whole-newscast timeline. */
  skipSeconds: (deltaSeconds: number) => void;
  cyclePlaybackRate: () => void;
  selectPart: (partArrayIndex: number) => void;
  seekToLine: (partArrayIndex: number, lineIndex: number) => void;
  seekToWord: (partArrayIndex: number, lineIndex: number, wordIndex: number) => void;
  /** Handlers to spread onto the `<audio>` element. */
  audioHandlers: {
    onTimeUpdate: () => void;
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLAudioElement>) => void;
    onPlay: () => void;
    onPause: () => void;
    onEnded: () => void;
    onError: () => void;
  };
}

export function useSharePlayback({
  parts,
  partAudioUrl,
  signalAudioUrl,
  title,
}: SharedPlaybackOptions): SharePlayback {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentPartArrayIndex, setCurrentPartArrayIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSignalPhase, setIsSignalPhase] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [partDurationSeconds, setPartDurationSeconds] = useState(0);
  const [activeLineIndex, setActiveLineIndex] = useState(NO_ACTIVE_INDEX);
  const [activeWordIndex, setActiveWordIndex] = useState(NO_ACTIVE_INDEX);
  const [playbackRate, setPlaybackRate] = useState(readStoredPlaybackRate);

  // Exactly-once guard for ending a signal phase: the 3s cap, the clip's own
  // `ended`, a load `error`, and the safety timeout all race for it.
  const signalFinishedRef = useRef(false);
  const pendingSeekMillisecondsRef = useRef<number | null>(null);
  /*
     Which part the "a new part means keep listening" effect last acted on.
     A plain "is this the first render?" boolean is not enough: refs survive the
     mount / unmount / remount that StrictMode performs in development, so the
     second mount would look like a part change and start playing a stranger's
     link on load. Comparing the part index instead makes the effect idempotent.
   */
  const startedPartRef = useRef<number | null>(null);

  const currentPart = parts[currentPartArrayIndex] ?? parts[0];
  const isLastPart = currentPartArrayIndex >= parts.length - 1;

  const partSource = partAudioUrl(currentPart.index);
  const audioSource =
    isSignalPhase && signalAudioUrl !== undefined ? signalAudioUrl : partSource;

  const advanceToNextPart = useCallback(() => {
    if (isLastPart) {
      return;
    }
    pendingSeekMillisecondsRef.current = null;
    setCurrentPartArrayIndex((index) => index + 1);
  }, [isLastPart]);

  const finishSignalPhase = useCallback(() => {
    if (signalFinishedRef.current) {
      return;
    }
    signalFinishedRef.current = true;
    setIsSignalPhase(false);
    advanceToNextPart();
  }, [advanceToNextPart]);

  // Every part change except the very first render starts playback of the new
  // part — a part only ever changes from an explicit reader action (chip, line
  // click) or from auto-advance, both of which mean "keep listening".
  useEffect(() => {
    setActiveLineIndex(NO_ACTIVE_INDEX);
    setActiveWordIndex(NO_ACTIVE_INDEX);
    setCurrentSeconds(0);
    if (startedPartRef.current === currentPartArrayIndex) {
      return;
    }
    const isFirstPart = startedPartRef.current === null;
    startedPartRef.current = currentPartArrayIndex;
    if (isFirstPart) {
      return;
    }
    // The src attribute already changed with this render.
    void audioRef.current?.play().catch(() => undefined);
  }, [currentPartArrayIndex]);

  // Drive the signal phase: this render just swapped the sting into `src`, so
  // play it and arm the stall safety net.
  useEffect(() => {
    if (!isSignalPhase) {
      return;
    }
    void audioRef.current?.play().catch(() => finishSignalPhase());
    const safety = setTimeout(() => finishSignalPhase(), SIGNAL_SAFETY_TIMEOUT_MILLISECONDS);
    return () => clearTimeout(safety);
  }, [isSignalPhase, finishSignalPhase]);

  /*
     `defaultPlaybackRate` matters as much as `playbackRate` here: the media
     load algorithm resets the live rate to the default one every time `src`
     changes, and this element swaps source on every part boundary. Setting only
     the live rate would silently drop the reader back to 1× at each part.
   */
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    audio.defaultPlaybackRate = playbackRate;
    audio.playbackRate = playbackRate;
  }, [playbackRate, audioSource]);

  const cyclePlaybackRate = useCallback(() => {
    setPlaybackRate((rate) => {
      const nextIndex = (PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length;
      const next = PLAYBACK_RATES[nextIndex];
      try {
        window.localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(next));
      } catch {
        // A denied storage quota must not cost the reader the speed change.
      }
      return next;
    });
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    if (isSignalPhase) {
      // Cap the sting and keep the part's captions and slider frozen meanwhile.
      if (audio.currentTime * 1000 >= SIGNAL_PLAYBACK_MILLISECONDS) {
        finishSignalPhase();
      }
      return;
    }
    setCurrentSeconds(audio.currentTime);
    const currentMilliseconds = audio.currentTime * 1000;
    const lineIndex = findActiveLineIndex(currentPart.segments, currentMilliseconds);
    setActiveLineIndex(lineIndex);
    setActiveWordIndex(
      findActiveWordIndex(findSegmentForLine(currentPart, lineIndex), currentMilliseconds),
    );
  }, [currentPart, isSignalPhase, finishSignalPhase]);

  const handleLoadedMetadata = useCallback(
    (event: React.SyntheticEvent<HTMLAudioElement>) => {
      if (isSignalPhase) {
        // The sting's own 30s duration must not clobber the part's readout.
        return;
      }
      const element = event.currentTarget;
      element.playbackRate = playbackRateRef.current;
      setPartDurationSeconds(Number.isFinite(element.duration) ? element.duration : 0);
      if (pendingSeekMillisecondsRef.current !== null) {
        element.currentTime = pendingSeekMillisecondsRef.current / 1000;
        pendingSeekMillisecondsRef.current = null;
      }
    },
    [isSignalPhase],
  );

  const handleEnded = useCallback(() => {
    if (isSignalPhase) {
      finishSignalPhase();
      return;
    }
    if (isLastPart) {
      setIsPlaying(false);
      return;
    }
    if (signalAudioUrl !== undefined) {
      signalFinishedRef.current = false;
      setIsSignalPhase(true);
      return;
    }
    advanceToNextPart();
  }, [isSignalPhase, isLastPart, signalAudioUrl, finishSignalPhase, advanceToNextPart]);

  const handleError = useCallback(() => {
    // A sting that fails to load must not strand playback between parts.
    if (isSignalPhase) {
      finishSignalPhase();
    }
  }, [isSignalPhase, finishSignalPhase]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    if (audio.paused) {
      if (audio.ended) {
        audio.currentTime = 0;
      }
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  }, []);

  const seekWithinPart = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    audio.currentTime = seconds;
    setCurrentSeconds(seconds);
  }, []);

  const selectPart = useCallback(
    (partArrayIndex: number) => {
      if (partArrayIndex === currentPartArrayIndex) {
        const audio = audioRef.current;
        if (audio !== null) {
          audio.currentTime = 0;
          void audio.play().catch(() => undefined);
        }
        return;
      }
      pendingSeekMillisecondsRef.current = null;
      setCurrentPartArrayIndex(partArrayIndex);
    },
    [currentPartArrayIndex],
  );

  /**
   * Applies a resolved seek target: same part → seek now; another part → queue
   * the part-relative offset and switch, letting `onLoadedMetadata` finish it.
   */
  const applySeekTarget = useCallback(
    (partArrayIndex: number, offsetMilliseconds: number) => {
      if (partArrayIndex === currentPartArrayIndex) {
        seekWithinPart(offsetMilliseconds / 1000);
        return;
      }
      pendingSeekMillisecondsRef.current = offsetMilliseconds;
      setCurrentPartArrayIndex(partArrayIndex);
    },
    [currentPartArrayIndex, seekWithinPart],
  );

  const seekToLine = useCallback(
    (partArrayIndex: number, lineIndex: number) => {
      const target = resolveLineSeek(parts, partArrayIndex, lineIndex);
      applySeekTarget(target.partArrayIndex, target.offsetMilliseconds);
    },
    [parts, applySeekTarget],
  );

  const seekToWord = useCallback(
    (partArrayIndex: number, lineIndex: number, wordIndex: number) => {
      const target = resolveWordSeek(parts, partArrayIndex, lineIndex, wordIndex);
      applySeekTarget(target.partArrayIndex, target.offsetMilliseconds);
    },
    [parts, applySeekTarget],
  );

  /*
     The unified timeline lives here rather than in the transport: the reader
     thinks in "somewhere in the 8 minutes", and exactly one place should know
     that this maps onto a part index plus a part-relative offset.
   */
  const seekToOverallSeconds = useCallback(
    (seconds: number) => {
      const target = resolveTimelineSeek(parts, seconds * 1000);
      applySeekTarget(target.partArrayIndex, target.offsetMilliseconds);
    },
    [parts, applySeekTarget],
  );

  const overallDurationSeconds = totalDurationMilliseconds(parts) / 1000;
  const overallSeconds =
    elapsedMillisecondsAcrossParts(parts, currentPartArrayIndex, currentSeconds * 1000) /
    1000;

  const skipSeconds = useCallback(
    (deltaSeconds: number) => {
      const audio = audioRef.current;
      // During the sting the element's clock belongs to the sting, not the part.
      const partMilliseconds =
        (audio !== null && !isSignalPhase ? audio.currentTime : currentSeconds) * 1000;
      const elapsed = elapsedMillisecondsAcrossParts(
        parts,
        currentPartArrayIndex,
        partMilliseconds,
      );
      seekToOverallSeconds((elapsed + deltaSeconds * 1000) / 1000);
    },
    [parts, currentPartArrayIndex, currentSeconds, isSignalPhase, seekToOverallSeconds],
  );

  // Lock screen and earphone controls. Absent on platforms without the API
  // (KakaoTalk's in-app WebView among them), where the page simply keeps its
  // on-screen transport and nothing else changes.
  useEffect(() => {
    const session = readMediaSession();
    if (session === undefined || typeof MediaMetadata !== 'function') {
      return;
    }
    try {
      session.metadata = new MediaMetadata({
        title: title ?? SITE_NAME,
        artist: SITE_NAME,
        artwork: [
          { src: MEDIA_SESSION_ARTWORK_PATH, sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch {
      // Artwork or metadata rejected: the transport is still fully usable.
    }
  }, [title]);

  /* Bound once, through refs: both callbacks change identity on every
     `timeupdate`, and re-registering platform action handlers four times a
     second is churn the OS media UI does not need. */
  const skipSecondsRef = useRef(skipSeconds);
  skipSecondsRef.current = skipSeconds;
  const seekToOverallSecondsRef = useRef(seekToOverallSeconds);
  seekToOverallSecondsRef.current = seekToOverallSeconds;

  useEffect(() => {
    const session = readMediaSession();
    if (session === undefined || typeof session.setActionHandler !== 'function') {
      return;
    }
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      [
        'play',
        () => {
          void audioRef.current?.play().catch(() => undefined);
        },
      ],
      [
        'pause',
        () => {
          audioRef.current?.pause();
        },
      ],
      [
        'seekbackward',
        (details) =>
          skipSecondsRef.current(-(details.seekOffset ?? MEDIA_SESSION_SEEK_SECONDS)),
      ],
      [
        'seekforward',
        (details) =>
          skipSecondsRef.current(details.seekOffset ?? MEDIA_SESSION_SEEK_SECONDS),
      ],
      [
        'seekto',
        (details) => {
          if (details.seekTime !== undefined && details.seekTime !== null) {
            seekToOverallSecondsRef.current(details.seekTime);
          }
        },
      ],
    ];

    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // An action this browser does not know about throws; the rest still bind.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Same asymmetry on teardown.
        }
      }
    };
  }, []);

  useEffect(() => {
    const session = readMediaSession();
    if (session === undefined) {
      return;
    }
    session.playbackState = isPlaying ? 'playing' : 'paused';
    if (typeof session.setPositionState !== 'function' || overallDurationSeconds <= 0) {
      return;
    }
    try {
      session.setPositionState({
        duration: overallDurationSeconds,
        position: Math.min(Math.max(overallSeconds, 0), overallDurationSeconds),
        playbackRate,
      });
    } catch {
      // Rejected position states are not worth interrupting playback over.
    }
  }, [isPlaying, overallSeconds, overallDurationSeconds, playbackRate]);

  return {
    audioRef,
    audioSource,
    isPlaying,
    isSignalPhase,
    currentPartArrayIndex,
    currentPart,
    currentSeconds,
    partDurationSeconds:
      partDurationSeconds > 0 ? partDurationSeconds : currentPart.durationMs / 1000,
    activeLineIndex,
    activeWordIndex,
    overallSeconds,
    overallDurationSeconds,
    playbackRate,
    togglePlayback,
    seekWithinPart,
    seekToOverallSeconds,
    skipSeconds,
    cyclePlaybackRate,
    selectPart,
    seekToLine,
    seekToWord,
    audioHandlers: {
      onTimeUpdate: handleTimeUpdate,
      onLoadedMetadata: handleLoadedMetadata,
      onPlay: () => setIsPlaying(true),
      onPause: () => setIsPlaying(false),
      onEnded: handleEnded,
      onError: handleError,
    },
  };
}
