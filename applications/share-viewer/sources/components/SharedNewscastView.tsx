/**
 * The shared newscast itself: the waveform hero, title and byline, the
 * transcript, the folded-away credits, and the floating transport — all wired to
 * ONE audio element through `useSharePlayback`.
 *
 * The order is the argument (design doc §4): a stranger arriving from a
 * messenger link gets "what is this, how long is it, press here" before anything
 * else, and production credits wait until after they have read some of it.
 *
 * Split out of the page component so tests can mount it against a fixture
 * without a router or a network round trip.
 *
 * Read-only by construction: there is no regenerate, rename, resume, or delete
 * anywhere in this tree — not hidden behind a permission check, simply absent.
 */

import { useEffect, useRef, useState } from 'react';
import styled from '@emotion/styled';
import type { PublicShareView } from '../schemas/public-share-view.ts';
import { useSharePlayback } from '../playback/use-share-playback.ts';
import {
  SEEK_STEP_SECONDS,
  resolveShortcutAction,
} from '../playback/keyboard-shortcuts.ts';
import { totalDurationMilliseconds } from '../playback/timings.ts';
import { SharePlayer } from './SharePlayer.tsx';
import { ScriptFollower } from './ScriptFollower.tsx';
import { ShareMetadataCard } from './ShareMetadataCard.tsx';
import { WaveformEpisodeCard } from './WaveformEpisodeCard.tsx';
import { NewscastByline } from './NewscastByline.tsx';
import { ShareFooter } from './ShareFooter.tsx';

const Main = styled.main<{ withFloatingBar: boolean }>`
  max-width: 56rem;
  margin: 0 auto;
  /* The bottom padding keeps the end of the transcript scrollable above the
     fixed floating player bar — and gives that space back while the bar is
     still hidden, so the first screen has no unexplained gap. */
  padding: 1.5rem 1.25rem ${(props) => (props.withFloatingBar ? '11rem' : '3rem')};
  display: grid;
  gap: 1.25rem;
`;

const Heading = styled.header`
  display: grid;
  gap: 0.5rem;
`;

const Title = styled.h1`
  margin: 0;
  font-size: clamp(1.875rem, 5vw, 2.75rem);
  line-height: 1.2;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: ${(props) => props.theme.colours.textPrimary};
`;

export interface SharedNewscastViewProps {
  view: PublicShareView;
  /** Builds the MP3 URL for a 1-based part number. */
  partAudioUrl: (partIndex: number) => string;
  /** Only supplied when `view.hasSignalAudio` is true. */
  signalAudioUrl?: string;
}

export function SharedNewscastView({
  view,
  partAudioUrl,
  signalAudioUrl,
}: SharedNewscastViewProps) {
  const [followEnabled, setFollowEnabled] = useState(true);
  const playback = useSharePlayback({
    parts: view.parts,
    partAudioUrl,
    signalAudioUrl: view.hasSignalAudio ? signalAudioUrl : undefined,
    title: view.title,
  });

  /* Before the first play the hero button is the ONLY transport, so the first
     screen belongs entirely to the content. Once playback has started the bar
     slides up and then stays for the rest of the visit — including while
     paused, because by then the reader knows where the controls live. */
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  useEffect(() => {
    if (playback.isPlaying) {
      setHasStartedPlayback(true);
    }
  }, [playback.isPlaying]);

  /* The keydown listener is registered once; it reads the latest playback state
     through a ref so seeking works without re-subscribing every render. */
  const playbackRef = useRef(playback);
  playbackRef.current = playback;

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = resolveShortcutAction(event.code, target);
      if (action === null) {
        return;
      }

      event.preventDefault();
      const current = playbackRef.current;
      if (action === 'toggle-playback') {
        current.togglePlayback();
      } else if (action === 'seek-forward') {
        current.skipSeconds(SEEK_STEP_SECONDS);
      } else {
        current.skipSeconds(-SEEK_STEP_SECONDS);
      }
    };

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, []);

  const sharedBy = view.metadata.sharedBy;
  const sharerName = [sharedBy?.displayName, sharedBy?.email].find(
    (candidate): candidate is string => candidate !== undefined && candidate !== '',
  );

  return (
    <Main withFloatingBar={hasStartedPlayback}>
      <audio
        ref={playback.audioRef}
        src={playback.audioSource}
        preload="metadata"
        data-testid="share-audio"
        {...playback.audioHandlers}
      />

      <WaveformEpisodeCard
        parts={view.parts}
        overallSeconds={playback.overallSeconds}
        isPlaying={playback.isPlaying}
        onTogglePlayback={playback.togglePlayback}
      />

      <Heading>
        <Title>{view.title}</Title>
        <NewscastByline
          sharerName={sharerName}
          totalMilliseconds={totalDurationMilliseconds(view.parts)}
          partCount={view.parts.length}
          createdAt={view.metadata.createdAt}
        />
      </Heading>

      <ScriptFollower
        parts={view.parts}
        currentPartArrayIndex={playback.currentPartArrayIndex}
        activeLineIndex={playback.activeLineIndex}
        activeWordIndex={playback.activeWordIndex}
        isPlaying={playback.isPlaying}
        followEnabled={followEnabled}
        onFollowEnabledChange={setFollowEnabled}
        onSeekLine={playback.seekToLine}
        onSeekWord={playback.seekToWord}
      />

      <ShareMetadataCard metadata={view.metadata} />
      <ShareFooter title={view.title} />

      {hasStartedPlayback && (
        <SharePlayer
          parts={view.parts}
          currentPartArrayIndex={playback.currentPartArrayIndex}
          currentSeconds={playback.currentSeconds}
          isPlaying={playback.isPlaying}
          isSignalPhase={playback.isSignalPhase}
          playbackRate={playback.playbackRate}
          skipStepSeconds={SEEK_STEP_SECONDS}
          onTogglePlayback={playback.togglePlayback}
          onSeekOverallSeconds={playback.seekToOverallSeconds}
          onSkipSeconds={playback.skipSeconds}
          onCyclePlaybackRate={playback.cyclePlaybackRate}
          onSelectPart={playback.selectPart}
        />
      )}
    </Main>
  );
}
