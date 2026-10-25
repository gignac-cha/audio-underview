import { useState } from 'react';
import styled from '@emotion/styled';
import type { CrawlerRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import type { StageRunSummary } from '../../hooks/use-scheduler-runs.ts';
import { AnswerFormDialog } from './AnswerFormDialog.tsx';
import { RunStatusBadge } from './RunStatusBadge.tsx';
import { StageRunDetail } from './StageRunDetail.tsx';
import { resolveStageRunDisplayName } from './stage-display-name.ts';

const List = styled.div`
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 0.75rem;
`;

const Item = styled.div`
  border-bottom: 1px solid var(--border-subtle);

  &:last-child {
    border-bottom: none;
  }
`;

const Row = styled.div`
  display: grid;
  grid-template-columns: 2rem 1fr 140px 80px;
  gap: 0.25rem 0.5rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;

  &:hover {
    background: var(--bg-surface);
  }

  &:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
`;

const Cell = styled.span`
  font-size: 0.8125rem;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const StageName = styled(Cell)`
  color: var(--text-primary);
  font-weight: 600;
`;

const Details = styled.div`
  grid-column: 2 / -1;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  font-size: 0.75rem;
  color: var(--text-muted);
`;

const StageError = styled.span`
  color: var(--status-error, #e53e3e);
  white-space: pre-wrap;
  word-break: break-all;
`;

const Actions = styled.div`
  grid-column: 2 / -1;
  display: flex;
`;

const AnswerButton = styled.button`
  padding: 0.25rem 0.75rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    opacity: 0.9;
  }

  &:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
`;

export function formatDateTime(dateString: string | null) {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return '-';
  const milliseconds = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function describeItems(stageRun: StageRunSummary): string | undefined {
  if (stageRun.items_total === null) return undefined;
  const items = `${stageRun.items_succeeded ?? 0}/${stageRun.items_total} items`;
  const failed = stageRun.items_failed ?? 0;
  return failed > 0 ? `${items} · ${failed} failed` : items;
}

function describeProgress(stageRun: StageRunSummary): string | undefined {
  const progress = stageRun.progress;
  if (progress === null) return undefined;
  const parts = [progress.message];
  if (progress.total !== null) {
    parts.push(`${progress.completed ?? 0}/${progress.total}`);
  }
  parts.push(formatDateTime(progress.reported_at));
  return parts.join(' · ');
}

interface StageRunListProperties {
  schedulerID: string;
  runID: string;
  stageRuns: StageRunSummary[];
  // The stages and crawlers as they are now, which name the stage runs
  stages: SchedulerStageRow[];
  crawlerMap: Map<string, CrawlerRow>;
}

export function StageRunList({ schedulerID, runID, stageRuns, stages, crawlerMap }: StageRunListProperties) {
  const [expandedStageRunID, setExpandedStageRunID] = useState<string>();
  const [answeringStageRunID, setAnsweringStageRunID] = useState<string>();
  // Looked up in the stage runs as they are now, so the dialog follows the stage run it was opened for
  const answeringStageRun = stageRuns.find((stageRun) => stageRun.id === answeringStageRunID);

  const toggleExpand = (stageRun: StageRunSummary) => {
    setExpandedStageRunID(expandedStageRunID === stageRun.id ? undefined : stageRun.id);
  };

  return (
    <List>
      {stageRuns.map((stageRun) => {
        const items = describeItems(stageRun);
        const progress = describeProgress(stageRun);

        return (
          <Item key={stageRun.id}>
            <Row
              role="button"
              tabIndex={0}
              aria-expanded={expandedStageRunID === stageRun.id}
              onClick={() => toggleExpand(stageRun)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggleExpand(stageRun);
                }
              }}
            >
              <Cell>{stageRun.stage_order}</Cell>
              <StageName>{resolveStageRunDisplayName(stageRun, stages, crawlerMap)}</StageName>
              <Cell>
                <RunStatusBadge status={stageRun.status} />
              </Cell>
              <Cell>{formatDuration(stageRun.started_at, stageRun.completed_at)}</Cell>
              {(items !== undefined || progress !== undefined || stageRun.error) && (
                <Details>
                  {items !== undefined && <span>{items}</span>}
                  {progress !== undefined && <span>{progress}</span>}
                  {stageRun.error && <StageError>{stageRun.error}</StageError>}
                </Details>
              )}
              {stageRun.status === 'waiting' && (
                <Actions>
                  {/* Inside the row, which toggles on a click or a key, so neither reaches it */}
                  <AnswerButton
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setAnsweringStageRunID(stageRun.id);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    Answer
                  </AnswerButton>
                </Actions>
              )}
            </Row>
            {expandedStageRunID === stageRun.id && (
              <StageRunDetail schedulerID={schedulerID} runID={runID} stageRun={stageRun} />
            )}
          </Item>
        );
      })}
      {answeringStageRun !== undefined && (
        <AnswerFormDialog
          schedulerID={schedulerID}
          runID={runID}
          stageRun={answeringStageRun}
          onOpenChange={(open) => {
            if (!open) setAnsweringStageRunID(undefined);
          }}
        />
      )}
    </List>
  );
}
