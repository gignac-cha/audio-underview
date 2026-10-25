/**
 * The running-newscast progress card: current stage headline + elapsed time,
 * overall progress bar, in-stage progress, and the compact stage rows (the same
 * rows the finished newscast's generation details renders, so a newscast reads
 * identically before and after it completes).
 */

import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClock, faDiagramProject } from '@fortawesome/free-solid-svg-icons';
import type { JobStatus } from '@audio-underview/newscast-core';

import { formatElapsed, formatPercent } from './formatting.ts';
import { STAGE_DESCRIPTIONS, STAGE_LABELS } from './stage-metadata.ts';
import { StageRowList } from './StageRow.tsx';

const Card = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  padding: 1.25rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
`;

const CurrentStage = styled.h3`
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
`;

const MetaGroup = styled.div`
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
`;

const Elapsed = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--text-secondary);
`;

const Percent = styled.span`
  font-weight: 700;
  color: var(--accent-primary);
`;

const Description = styled.p`
  margin: -0.375rem 0 0;
  font-size: 0.8125rem;
  color: var(--text-secondary);
`;

const Track = styled.div`
  height: 8px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.12);
  overflow: hidden;
`;

const Fill = styled.div<{ ratio: number }>`
  height: 100%;
  width: ${(props) => Math.round(props.ratio * 100)}%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
  transition: width 0.3s ease;
`;

const SubRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
`;

const SubTrack = styled.div`
  flex: 1;
  height: 4px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.12);
  overflow: hidden;
`;

const SubFill = styled.div<{ ratio: number }>`
  height: 100%;
  width: ${(props) => Math.round(props.ratio * 100)}%;
  background: var(--accent-primary);
  transition: width 0.3s ease;
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

export interface StageTrackerProps {
  status: JobStatus;
  elapsedMilliseconds?: number;
  /** Shared 1s wall-clock tick, used for the active stage row's live elapsed. */
  nowMilliseconds?: number;
  /** Supplied by the owner of the pipeline graph dialog; omit to hide the button. */
  onOpenGraph?: () => void;
}

export function StageTracker({
  status,
  elapsedMilliseconds,
  nowMilliseconds,
  onOpenGraph,
}: StageTrackerProps) {
  const isDone = status.status === 'done';
  return (
    <Card>
      <HeaderRow>
        <CurrentStage>{STAGE_LABELS[status.stage]}</CurrentStage>
        <MetaGroup>
          {elapsedMilliseconds !== undefined && (
            <Elapsed>
              <FontAwesomeIcon icon={faClock} aria-hidden={true} />
              {formatElapsed(elapsedMilliseconds)}
            </Elapsed>
          )}
          <Percent>{formatPercent(status.overallProgress)}</Percent>
          {onOpenGraph !== undefined && (
            <GraphButton type="button" onClick={onOpenGraph}>
              <FontAwesomeIcon icon={faDiagramProject} aria-hidden={true} />
              Graph
            </GraphButton>
          )}
        </MetaGroup>
      </HeaderRow>
      <Description>{STAGE_DESCRIPTIONS[status.stage]}</Description>
      <Track
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(status.overallProgress * 100)}
        aria-label="Overall progress"
      >
        <Fill ratio={status.overallProgress} />
      </Track>
      {!isDone && status.stage !== 'done' && (
        <SubRow>
          <span>{STAGE_LABELS[status.stage]}</span>
          <SubTrack>
            <SubFill ratio={status.stageProgress} />
          </SubTrack>
          <span>{formatPercent(status.stageProgress)}</span>
        </SubRow>
      )}
      <StageRowList status={status} nowMilliseconds={nowMilliseconds} />
    </Card>
  );
}
