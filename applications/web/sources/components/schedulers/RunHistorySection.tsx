import { useState } from 'react';
import styled from '@emotion/styled';
import type { CrawlerRow, SchedulerRunRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import { isInProgress, useGetRun, useListRuns } from '../../hooks/use-scheduler-runs.ts';
import { RunStatusBadge } from './RunStatusBadge.tsx';
import { StageRunList, formatDateTime, formatDuration } from './StageRunList.tsx';

const Container = styled.section`
  margin-bottom: 2rem;
`;

const SectionTitle = styled.h2`
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 1rem 0;
`;

const Table = styled.div`
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
`;

const TableRow = styled('div', {
  shouldForwardProp: (prop) => prop !== 'clickable',
})<{ clickable?: boolean }>`
  display: grid;
  grid-template-columns: 140px 100px 1fr 120px;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-subtle);
  cursor: ${({ clickable }) => (clickable ? 'pointer' : 'default')};

  &:last-child {
    border-bottom: none;
  }

  &:hover {
    background: ${({ clickable }) => (clickable ? 'var(--bg-surface)' : 'transparent')};
  }

  &:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
`;

const TableHeader = styled(TableRow)`
  background: var(--bg-surface);
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: default;

  &:hover {
    background: var(--bg-surface);
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

const ExpandedRow = styled.div`
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-deep);

  &:last-child {
    border-bottom: none;
  }
`;

const ExpandedLabel = styled.span`
  display: block;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 0.25rem;
  text-transform: uppercase;
`;

const ExpandedContent = styled.pre`
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  margin: 0 0 0.75rem 0;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
`;

const EmptyMessage = styled.p`
  text-align: center;
  padding: 2rem;
  color: var(--text-muted);
  font-size: 0.875rem;
`;

const ErrorMessage = styled.p`
  text-align: center;
  padding: 2rem;
  color: var(--status-error, #e53e3e);
  font-size: 0.875rem;
`;

const LoadMoreContainer = styled.div`
  display: flex;
  justify-content: center;
  margin-top: 1rem;
`;

const LoadMoreButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    border-color: var(--border-focus);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const TRIGGER_LABELS: Record<SchedulerRunRow['triggered_by'], string> = {
  manual: 'Manual',
  schedule: 'Scheduled',
};

const Notice = styled.p`
  margin: 0 0 0.75rem 0;
  font-size: 0.8125rem;
  color: var(--text-muted);
`;

interface RunDetailsProperties {
  schedulerID: string;
  run: SchedulerRunRow;
  stages: SchedulerStageRow[];
  crawlerMap: Map<string, CrawlerRow>;
  refreshIntervalMilliseconds?: number;
}

function RunDetails({ schedulerID, run, stages, crawlerMap, refreshIntervalMilliseconds }: RunDetailsProperties) {
  const {
    run: cachedDetail,
    isLoading,
    hasReadSinceOpened,
    error: detailError,
  } = useGetRun(schedulerID, run.id, { refreshIntervalMilliseconds });
  // A detail from an earlier opening that still says the run goes on is older than the row of the
  // list that says it ended, so the row is shown until the read of this opening arrives
  const isListNewer =
    cachedDetail !== undefined && !hasReadSinceOpened && isInProgress(cachedDetail.status) && !isInProgress(run.status);
  // Whether it was so when the run was opened. Decided once: a poll of the list that lands before the
  // read must not take the stages back from a detail that is already on screen with an open stage run
  const [wasListNewerWhenOpened] = useState(isListNewer);
  const detail = wasListNewerWhenOpened && !hasReadSinceOpened ? undefined : cachedDetail;
  // The detail is newer than the row of the list once it is read
  const shown = isListNewer ? run : (cachedDetail ?? run);
  const stageRuns = detail?.stage_runs ?? [];
  const hasResult = shown.result !== undefined && shown.result !== null;
  // A failed refresh keeps the earlier answer, which stays on screen with a notice until the next one
  const failedToLoad = detailError !== undefined && detail === undefined;
  const refreshError = detail === undefined ? undefined : detailError;
  const isReading = isLoading || (wasListNewerWhenOpened && !hasReadSinceOpened && !failedToLoad);
  const hasStagesSection = isReading || failedToLoad || refreshError !== undefined || stageRuns.length > 0;

  return (
    <ExpandedRow>
      {hasStagesSection && (
        <>
          <ExpandedLabel>Stages</ExpandedLabel>
          {isReading ? (
            <Notice>Loading stages...</Notice>
          ) : failedToLoad ? (
            <Notice>Failed to load stages: {detailError.message}</Notice>
          ) : (
            <>
              {refreshError && <Notice>Could not refresh stages: {refreshError.message}</Notice>}
              {stageRuns.length > 0 && (
                <StageRunList
                  schedulerID={schedulerID}
                  runID={run.id}
                  stageRuns={stageRuns}
                  stages={stages}
                  crawlerMap={crawlerMap}
                />
              )}
            </>
          )}
        </>
      )}
      {shown.error && (
        <>
          <ExpandedLabel>Error</ExpandedLabel>
          <ExpandedContent>{shown.error}</ExpandedContent>
        </>
      )}
      {hasResult && (
        <>
          <ExpandedLabel>Result</ExpandedLabel>
          <ExpandedContent>{JSON.stringify(shown.result, null, 2)}</ExpandedContent>
        </>
      )}
      {!hasStagesSection && !shown.error && !hasResult && (
        <ExpandedContent>No additional details.</ExpandedContent>
      )}
    </ExpandedRow>
  );
}

interface RunHistorySectionProperties {
  schedulerID: string;
  // The stages and crawlers as they are now, which name the stage runs of an expanded run
  stages: SchedulerStageRow[];
  crawlerMap: Map<string, CrawlerRow>;
  expandedRunID: string | undefined;
  onExpandedRunIDChange: (runID: string | undefined) => void;
  // How often a run that is pending or running is read again; every 5 seconds without it
  refreshIntervalMilliseconds?: number;
}

export function RunHistorySection({
  schedulerID,
  stages,
  crawlerMap,
  expandedRunID,
  onExpandedRunIDChange,
  refreshIntervalMilliseconds,
}: RunHistorySectionProperties) {
  const { runs, isLoading, error, refreshError, hasNextPage, fetchNextPage, isFetchingNextPage } = useListRuns(
    schedulerID,
    { refreshIntervalMilliseconds },
  );

  const toggleExpand = (run: SchedulerRunRow) => {
    onExpandedRunIDChange(expandedRunID === run.id ? undefined : run.id);
  };

  if (isLoading) return null;

  return (
    <Container>
      <SectionTitle>Run History</SectionTitle>

      {/* A failed refresh keeps the runs, the expanded run and its open stage run, and only says so */}
      {refreshError && <Notice>Could not refresh run history: {refreshError.message}</Notice>}

      {error ? (
        <ErrorMessage>Failed to load run history: {error.message}</ErrorMessage>
      ) : runs.length === 0 ? (
        <EmptyMessage>No runs yet.</EmptyMessage>
      ) : (
        <>
          <Table>
            <TableHeader>
              <Cell>Status</Cell>
              <Cell>Trigger</Cell>
              <Cell>Started</Cell>
              <Cell>Duration</Cell>
            </TableHeader>
            {runs.map((run) => (
              <div key={run.id}>
                <TableRow
                  clickable
                  role="button"
                  tabIndex={0}
                  aria-expanded={expandedRunID === run.id}
                  onClick={() => toggleExpand(run)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleExpand(run);
                    }
                  }}
                >
                  <Cell>
                    <RunStatusBadge status={run.status} />
                  </Cell>
                  <Cell>{TRIGGER_LABELS[run.triggered_by]}</Cell>
                  <Cell>{formatDateTime(run.started_at ?? run.scheduled_for)}</Cell>
                  <Cell>{formatDuration(run.started_at, run.completed_at)}</Cell>
                </TableRow>
                {expandedRunID === run.id && (
                  <RunDetails
                    schedulerID={schedulerID}
                    run={run}
                    stages={stages}
                    crawlerMap={crawlerMap}
                    refreshIntervalMilliseconds={refreshIntervalMilliseconds}
                  />
                )}
              </div>
            ))}
          </Table>
          {hasNextPage && (
            <LoadMoreContainer>
              <LoadMoreButton onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? 'Loading...' : 'Load More'}
              </LoadMoreButton>
            </LoadMoreContainer>
          )}
        </>
      )}
    </Container>
  );
}
