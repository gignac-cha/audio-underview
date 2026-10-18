import styled from '@emotion/styled';
import { useListCrawlerRuns } from '../../hooks/use-crawler-runs.ts';
import type { CrawlerRunKind } from '../../schemas/crawler-runs.ts';
import { RunStatusBadge } from '../schedulers/RunStatusBadge.tsx';

const Table = styled.div`
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
`;

const RunRow = styled('button', {
  shouldForwardProp: (prop) => prop !== 'selected',
})<{ selected: boolean }>`
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr) 8.5rem 4.5rem;
  gap: 0.5rem;
  width: 100%;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--border-subtle);
  text-align: left;
  cursor: pointer;
  background: ${({ selected }) => (selected ? 'var(--accent-muted)' : 'transparent')};

  &:last-child {
    border-bottom: none;
  }

  &:hover {
    background: ${({ selected }) => (selected ? 'var(--accent-muted)' : 'var(--bg-deep)')};
  }

  &:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
`;

const HeaderRow = styled.div`
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr) 8.5rem 4.5rem;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: var(--bg-deep);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const Cell = styled.span`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ErrorCode = styled.span`
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Message = styled.p`
  margin: 0;
  padding: 1rem;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--text-muted);
`;

const ErrorMessage = styled(Message)`
  color: var(--color-error);
`;

const ActionRow = styled.div`
  display: flex;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
`;

const ActionButton = styled.button`
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

const KIND_LABELS: Record<CrawlerRunKind, string> = {
  direct: 'Direct',
  test: 'Test',
};

function formatDateTime(dateString: string) {
  return new Date(dateString).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startedAt: string, completedAt: string): string {
  const milliseconds = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(milliseconds)) return '-';
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

interface RunHistoryPanelProperties {
  // The crawler whose runs to list; null lists the test runs of crawlers that were not saved
  crawlerID: string | null;
  selectedRunID: string | undefined;
  onSelect: (runID: string) => void;
}

export function RunHistoryPanel({ crawlerID, selectedRunID, onSelect }: RunHistoryPanelProperties) {
  const { runs, isLoading, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useListCrawlerRuns(crawlerID);

  if (isLoading) {
    return <Message role="status">Loading run history...</Message>;
  }

  if (error) {
    return (
      <>
        <ErrorMessage role="alert">Failed to load run history: {error.message}</ErrorMessage>
        <ActionRow>
          <ActionButton type="button" onClick={() => refetch()}>
            Retry
          </ActionButton>
        </ActionRow>
      </>
    );
  }

  if (runs.length === 0) {
    return <Message>No runs yet.</Message>;
  }

  return (
    <>
      <Table>
        <HeaderRow aria-hidden="true">
          <span>Kind</span>
          <span>Status</span>
          <span>Started</span>
          <span>Duration</span>
        </HeaderRow>
        {runs.map((run) => (
          <RunRow
            key={run.id}
            type="button"
            selected={run.id === selectedRunID}
            aria-current={run.id === selectedRunID ? 'true' : undefined}
            onClick={() => onSelect(run.id)}
          >
            <Cell>{KIND_LABELS[run.kind]}</Cell>
            <Cell>
              <RunStatusBadge status={run.status} />
              {run.status === 'failed' && run.error_code && <ErrorCode>{run.error_code}</ErrorCode>}
            </Cell>
            <Cell>{formatDateTime(run.started_at)}</Cell>
            <Cell>{formatDuration(run.started_at, run.completed_at)}</Cell>
          </RunRow>
        ))}
      </Table>
      {hasNextPage && (
        <ActionRow>
          <ActionButton type="button" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading...' : 'Load More'}
          </ActionButton>
        </ActionRow>
      )}
    </>
  );
}
