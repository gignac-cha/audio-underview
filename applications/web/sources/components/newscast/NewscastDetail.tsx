/**
 * Full detail of the selected newscast — one component for every lifecycle
 * state (running / done / failed), used identically by the desktop detail pane
 * and the mobile inline accordion (no separate "live" path).
 *
 * Audio does NOT play here: the hero Play button binds the newscast to the
 * page's floating player bar, so listening survives switching to other
 * newscasts. Captions belong to that playback surface, not this inspection pane.
 */

import { useState } from 'react';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faDiagramProject,
  faList,
  faPause,
  faPlay,
  faShareNodes,
} from '@fortawesome/free-solid-svg-icons';
import type { JobStatus, NewscastJobSummary } from '@audio-underview/newscast-core';

import { formatCreatedAt, parseCreatedAtMilliseconds } from './formatting.ts';
import { NewscastErrorPanel } from './NewscastErrorPanel.tsx';
import { NewscastShareDialog } from './NewscastShareDialog.tsx';
import { NewscastSources } from './NewscastSources.tsx';
import { NewscastTelemetry } from './NewscastTelemetry.tsx';
import { PipelineGraphDialog } from './PipelineGraphDialog.tsx';
import { FullScriptDialog } from './ScriptCaptions.tsx';
import { StageTracker } from './StageTracker.tsx';

const Wrapper = styled.section`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  animation: detail-fade-in 0.15s ease;

  @keyframes detail-fade-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
`;

const TitleBlock = styled.header`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
`;

const Title = styled.h2`
  margin: 0;
  font-size: 1.125rem;
  line-height: 1.4;
`;

const Subtitle = styled.p`
  margin: 0;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
`;

const SectionHeading = styled.h3`
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
`;

/** Section heading with a trailing action (the generation details' Graph button). */
const SectionHeadingRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
`;

/** Opens the read-only node graph of this newscast's actual pipeline shape. */
const GraphButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.1875rem 0.5rem;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  font-family: inherit;
  font-size: 0.71875rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    border-color: var(--accent-primary);
    background: var(--accent-muted);
  }
`;

const Note = styled.p`
  margin: 0;
  padding: 1.25rem;
  font-size: 0.8125rem;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
`;

const ErrorNote = styled(Note)`
  color: var(--color-error);
  border-color: rgba(239, 68, 68, 0.25);
`;

const PlayRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
`;

const PlayHero = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.75rem 1.375rem;
  border-radius: 12px;
  font-size: 0.875rem;
  font-weight: 700;
  background: var(--accent-primary);
  color: #ffffff;
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    filter: brightness(1.15);
  }
`;

const PlayHint = styled.span`
  font-size: 0.75rem;
  color: var(--text-muted);
`;

/**
 * Opens the read-only script preview — lets the dialogue be read before the
 * newscast is bound to the floating player. Sized to sit next to PlayHero (same
 * vertical padding) but styled as the secondary action, same border/hover
 * pattern as GraphButton.
 */
const ScriptButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.125rem;
  border-radius: 12px;
  border: 1px solid var(--border-subtle);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    border-color: var(--accent-primary);
    background: var(--accent-muted);
  }
`;

/**
 * Opens the "Share" dialog — only reachable once the newscast is `done`, same
 * visual weight as {@link ScriptButton}.
 */
const ShareButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.125rem;
  border-radius: 12px;
  border: 1px solid var(--border-subtle);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    border-color: var(--accent-primary);
    background: var(--accent-muted);
  }
`;

const PartList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
`;

const PartRow = styled.li`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.875rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
`;

const PartLabel = styled.span`
  font-size: 0.8125rem;
  font-weight: 700;
`;

const PartDuration = styled.span`
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--text-muted);
`;

/** m:ss for a part's audio length (player-style, non-padded minutes). */
function formatPartDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export interface NewscastDetailProps {
  status?: JobStatus;
  /** The newscast's list summary — supplies title and createdAt (JobStatus has neither). */
  summary?: NewscastJobSummary;
  /** Set only while the newscast is playable (done, with parts). */
  audioURL?: string;
  isLoading: boolean;
  error?: Error;
  /** Shared 1s wall-clock tick from the page, for the elapsed timer. */
  nowMilliseconds: number;
  /** True when THIS newscast is the one bound to the floating player bar. */
  isPlayingThisJob?: boolean;
  /** True while the floating player's audio is actually playing. */
  isAudioPlaying?: boolean;
  /** Bind this newscast to the floating player, or toggle it when already bound. */
  onPlayToggle?: () => void;
}

export function NewscastDetail({
  status,
  summary,
  audioURL,
  isLoading,
  error,
  nowMilliseconds,
  isPlayingThisJob = false,
  isAudioPlaying = false,
  onPlayToggle,
}: NewscastDetailProps) {
  // Declared before the early returns so the hook order stays unconditional.
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [isScriptOpen, setIsScriptOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);

  if (error !== undefined) {
    return <ErrorNote role="alert">{error.message}</ErrorNote>;
  }
  if (status === undefined) {
    return <Note>{isLoading ? 'Loading newscast…' : 'Select a newscast.'}</Note>;
  }

  const createdMilliseconds = summary !== undefined ? parseCreatedAtMilliseconds(summary.createdAt) : undefined;
  const elapsedMilliseconds =
    status.status === 'running' && createdMilliseconds !== undefined
      ? Math.max(0, nowMilliseconds - createdMilliseconds)
      : undefined;

  // The list summary already resolves a title override, so it comes first; the
  // detail's own override and the first source's title cover the rest.
  const displayTitle =
    summary?.title ?? status.details?.titleOverride ?? status.result?.sources[0]?.title ?? 'Newscast';

  return (
    <Wrapper>
      <TitleBlock>
        <Title>{displayTitle}</Title>
        {summary !== undefined && <Subtitle>{formatCreatedAt(summary.createdAt)}</Subtitle>}
      </TitleBlock>

      {status.status === 'error' && <NewscastErrorPanel status={status} />}

      {status.status === 'running' && (
        <StageTracker
          status={status}
          elapsedMilliseconds={elapsedMilliseconds}
          nowMilliseconds={nowMilliseconds}
          onOpenGraph={() => setIsGraphOpen(true)}
        />
      )}

      {status.status === 'done' && status.result !== undefined && audioURL !== undefined && (
        <>
          <PlayRow>
            <PlayHero type="button" onClick={onPlayToggle}>
              <FontAwesomeIcon
                icon={isPlayingThisJob && isAudioPlaying ? faPause : faPlay}
                aria-hidden={true}
              />
              {isPlayingThisJob ? (isAudioPlaying ? 'Pause' : 'Resume') : 'Play newscast'}
            </PlayHero>
            <ScriptButton type="button" aria-label="Read the script" onClick={() => setIsScriptOpen(true)}>
              <FontAwesomeIcon icon={faList} aria-hidden={true} />
              Script
            </ScriptButton>
            <ShareButton type="button" aria-label="Share" onClick={() => setIsShareOpen(true)}>
              <FontAwesomeIcon icon={faShareNodes} aria-hidden={true} />
              Share
            </ShareButton>
            {isPlayingThisJob && <PlayHint>Playing in the bottom bar</PlayHint>}
          </PlayRow>
          {status.result.parts !== undefined && status.result.parts.length > 0 && (
            <>
              <SectionHeading>Parts</SectionHeading>
              <PartList>
                {status.result.parts.map((part) => (
                  <PartRow key={part.index}>
                    <PartLabel>Part {part.index}</PartLabel>
                    <PartDuration>{formatPartDuration(part.durationMs)}</PartDuration>
                  </PartRow>
                ))}
              </PartList>
            </>
          )}
          <SectionHeading>Sources</SectionHeading>
          <NewscastSources sources={status.result.sources} />
        </>
      )}

      {/* A running newscast already shows these very rows inside the tracker, so
          the section would only duplicate them until the newscast settles. */}
      {status.status !== 'running' && status.details !== undefined && (
        <>
          <SectionHeadingRow>
            <SectionHeading>Generation details</SectionHeading>
            <GraphButton type="button" onClick={() => setIsGraphOpen(true)}>
              <FontAwesomeIcon icon={faDiagramProject} aria-hidden={true} />
              Graph
            </GraphButton>
          </SectionHeadingRow>
          <NewscastTelemetry status={status} />
        </>
      )}

      <PipelineGraphDialog
        status={status}
        open={isGraphOpen}
        onOpenChange={setIsGraphOpen}
      />

      {status.result !== undefined && (
        <FullScriptDialog
          preview={true}
          lines={status.result.script}
          segments={status.result.segments}
          parts={status.result.parts}
          activeIndex={-1}
          activeWordIndex={-1}
          open={isScriptOpen}
          onOpenChange={setIsScriptOpen}
        />
      )}

      {/* Mounted only once actually opened: NewscastShareDialog fetches and
          authenticates on mount, which no other NewscastDetail state needs — a
          done newscast that never opens "Share" should cost nothing. */}
      {isShareOpen && (
        <NewscastShareDialog jobID={status.id} open={isShareOpen} onOpenChange={setIsShareOpen} />
      )}
    </Wrapper>
  );
}
