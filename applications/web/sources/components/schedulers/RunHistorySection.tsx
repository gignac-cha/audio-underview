import { useState } from 'react';
import styled from '@emotion/styled';
import type { SchedulerRunRow } from '@audio-underview/supabase-connector';
import { useListRuns } from '../../hooks/use-scheduler-manager.ts';
import { RunStatusBadge } from './RunStatusBadge.tsx';

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
  grid-template-columns: 100px 1fr 120px;
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

function formatDateTime(dateString: string | null) {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return '-';
  const milliseconds = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

interface RunHistorySectionProperties {
  schedulerID: string;
}

export function RunHistorySection({ schedulerID }: RunHistorySectionProperties) {
  const { runs, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useListRuns(schedulerID);
  const [expandedRunID, setExpandedRunID] = useState<string | null>(null);

  const toggleExpand = (run: SchedulerRunRow) => {
    setExpandedRunID(expandedRunID === run.id ? null : run.id);
  };

  if (isLoading) return null;

  return (
    <Container>
      <SectionTitle>Run History</SectionTitle>

      {error ? (
        <ErrorMessage>Failed to load run history: {error.message}</ErrorMessage>
      ) : runs.length === 0 ? (
        <EmptyMessage>No runs yet.</EmptyMessage>
      ) : (
        <>
          <Table>
            <TableHeader>
              <Cell>Status</Cell>
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
                  <Cell>{formatDateTime(run.started_at)}</Cell>
                  <Cell>{formatDuration(run.started_at, run.completed_at)}</Cell>
                </TableRow>
                {expandedRunID === run.id && (
                  <ExpandedRow>
                    {run.error && (
                      <>
                        <ExpandedLabel>Error</ExpandedLabel>
                        <ExpandedContent>{run.error}</ExpandedContent>
                      </>
                    )}
                    {run.result && (
                      <>
                        <ExpandedLabel>Result</ExpandedLabel>
                        <ExpandedContent>{JSON.stringify(run.result, null, 2)}</ExpandedContent>
                      </>
                    )}
                    {!run.error && !run.result && (
                      <ExpandedContent>No additional details.</ExpandedContent>
                    )}
                  </ExpandedRow>
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
