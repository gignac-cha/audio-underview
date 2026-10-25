/**
 * One row of the Newscasts list: status icon + title + relative time + badge,
 * with a live bottom progress strip while the newscast is running — so every
 * newscast's state is visible in place, without selecting it.
 *
 * On narrow screens the page passes the selected newscast's detail as
 * `children`, which renders inline beneath the row (the accordion half of the
 * hybrid layout); on wide screens `children` stays empty and selection
 * highlights the row while the detail renders in the adjacent pane.
 */

import type { ReactNode } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleCheck,
  faCircleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import type { NewscastJobSummary } from '@audio-underview/newscast-core';

import { formatRelativeTime, formatPercent, parseCreatedAtMilliseconds, shortID } from './formatting.ts';
import { STAGE_LABELS, STATUS_BADGE, type StatusTone } from './stage-metadata.ts';

const TONE_COLORS: Record<StatusTone, string> = {
  done: 'var(--color-success)',
  running: 'var(--accent-primary)',
  error: 'var(--color-error)',
};

const pulse = keyframes`
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.8); }
`;

const Item = styled.li`
  list-style: none;
  margin: 0;
`;

const Row = styled.button<{ isSelected: boolean }>`
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.75rem 1rem 0.875rem;
  text-align: left;
  cursor: pointer;
  color: var(--text-primary);
  background: ${(props) => (props.isSelected ? 'var(--accent-muted)' : 'var(--bg-surface)')};
  border: 1px solid ${(props) => (props.isSelected ? 'var(--border-focus)' : 'var(--border-subtle)')};
  border-left: 3px solid
    ${(props) => (props.isSelected ? 'var(--accent-primary)' : 'transparent')};
  border-radius: 12px;
  transition: var(--transition-fast);
  overflow: hidden;

  &:hover {
    border-color: var(--border-focus);
  }
  &:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
`;

const StatusIcon = styled.span<{ tone: StatusTone }>`
  flex-shrink: 0;
  display: inline-flex;
  width: 1rem;
  justify-content: center;
  color: ${(props) => TONE_COLORS[props.tone]};
`;

const RunningDot = styled.span`
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 50%;
  background: var(--accent-primary);
  animation: ${pulse} 1.6s ease-in-out infinite;
`;

const Body = styled.span`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
`;

const Title = styled.span`
  font-size: 0.875rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Meta = styled.span`
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.71875rem;
  color: var(--text-muted);
  font-family: var(--font-mono);
`;

const StageNote = styled.span`
  color: var(--text-secondary);
`;

const Badge = styled.span<{ tone: StatusTone }>`
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-weight: 700;
  padding: 0.1875rem 0.5rem;
  border-radius: 6px;
  color: var(--text-primary);
  background: ${(props) =>
    props.tone === 'done'
      ? 'rgba(34, 197, 94, 0.2)'
      : props.tone === 'error'
        ? 'rgba(239, 68, 68, 0.2)'
        : 'rgba(99, 102, 241, 0.25)'};
`;

const equalize = keyframes`
  0%, 100% { transform: scaleY(0.35); }
  50% { transform: scaleY(1); }
`;

const PlayingIndicator = styled.span`
  flex-shrink: 0;
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 0.75rem;
`;

const PlayingIndicatorBar = styled.span<{ delaySeconds: number }>`
  width: 3px;
  height: 100%;
  border-radius: 1px;
  background: var(--accent-primary);
  transform-origin: bottom;
  animation: ${equalize} 1s ease-in-out infinite;
  animation-delay: ${(props) => props.delaySeconds}s;
`;

const ProgressStrip = styled.span`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(99, 102, 241, 0.15);
`;

const ProgressStripFill = styled.span<{ ratio: number }>`
  display: block;
  height: 100%;
  width: ${(props) => Math.round(props.ratio * 100)}%;
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
  transition: width 0.3s ease;
`;

const InlineDetail = styled.div`
  padding: 0.75rem 0 0.25rem 0.75rem;
  border-left: 2px solid var(--border-subtle);
  margin: 0.5rem 0 0.75rem 1rem;
`;

export interface NewscastListItemProps {
  job: NewscastJobSummary;
  selected: boolean;
  /** True when `children` (the inline detail) renders beneath this row. */
  expanded: boolean;
  /** True when this newscast is bound to the floating player bar. */
  isPlaying?: boolean;
  nowMilliseconds: number;
  onSelect: (jobID: string) => void;
  children?: ReactNode;
}

export function NewscastListItem({
  job,
  selected,
  expanded,
  isPlaying = false,
  nowMilliseconds,
  onSelect,
  children,
}: NewscastListItemProps) {
  const badge = STATUS_BADGE[job.status];
  const isRunning = job.status === 'running';
  const createdMilliseconds = parseCreatedAtMilliseconds(job.createdAt);

  return (
    <Item>
      <Row
        type="button"
        isSelected={selected}
        aria-current={selected ? 'true' : undefined}
        aria-expanded={expanded}
        onClick={() => onSelect(job.id)}
      >
        <StatusIcon tone={badge.tone} aria-hidden={true}>
          {job.status === 'done' ? (
            <FontAwesomeIcon icon={faCircleCheck} />
          ) : job.status === 'error' ? (
            <FontAwesomeIcon icon={faCircleExclamation} />
          ) : (
            <RunningDot />
          )}
        </StatusIcon>
        <Body>
          <Title>{job.title ?? `Newscast ${shortID(job.id)}`}</Title>
          <Meta>
            {createdMilliseconds !== undefined && <span>{formatRelativeTime(createdMilliseconds, nowMilliseconds)}</span>}
            {isRunning && (
              <StageNote>
                {STAGE_LABELS[job.stage]} · {formatPercent(job.overallProgress)}
              </StageNote>
            )}
          </Meta>
        </Body>
        {isPlaying && (
          <PlayingIndicator aria-label="Now playing" role="img">
            <PlayingIndicatorBar delaySeconds={0} />
            <PlayingIndicatorBar delaySeconds={0.25} />
            <PlayingIndicatorBar delaySeconds={0.5} />
          </PlayingIndicator>
        )}
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {isRunning && (
          <ProgressStrip
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(job.overallProgress * 100)}
            aria-label={`${STAGE_LABELS[job.stage]} progress`}
          >
            <ProgressStripFill ratio={job.overallProgress} />
          </ProgressStrip>
        )}
      </Row>
      {expanded && children !== undefined && <InlineDetail>{children}</InlineDetail>}
    </Item>
  );
}
