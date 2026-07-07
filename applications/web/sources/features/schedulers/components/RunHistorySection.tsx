import type { SchedulerRun } from '@audio-underview/schemas';
import { useState } from 'react';
import { useListRuns } from '../../../api/schedulers.ts';
import { Button } from '../../../components/Button.tsx';
import { Section } from '../../../components/Section.tsx';
import { formatDateTime, formatDuration } from '../../../tools/format.ts';
import { RunStatusBadge } from './RunStatusBadge.tsx';
import styles from './RunHistorySection.module.css';

const RunDetails = ({ run }: { run: SchedulerRun }) => {
  if (run.error !== null && run.error.length > 0) {
    return <pre className={styles.detailError}>{run.error}</pre>;
  }
  if (run.result !== undefined && run.result !== null) {
    return <pre className={styles.detailResult}>{JSON.stringify(run.result, null, 2)}</pre>;
  }
  return <p className={styles.detailEmpty}>No additional details.</p>;
};

export const RunHistorySection = ({ schedulerID }: { schedulerID: string }) => {
  const { runs, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useListRuns(schedulerID);
  const [expandedID, setExpandedID] = useState<string | null>(null);

  // 로딩 중엔 섹션 자체 미표시 (스펙 §4.5.5).
  if (isLoading) {
    return null;
  }

  return (
    <Section title="Run history" padded={false}>
      {error !== undefined ? (
        <p className={styles.message}>Failed to load run history: {error.message}</p>
      ) : runs.length === 0 ? (
        <p className={styles.message}>No runs yet.</p>
      ) : (
        <>
          <div className={styles.table} role="table">
            <div className={styles.headRow} role="row">
              <span role="columnheader">Status</span>
              <span role="columnheader">Started</span>
              <span role="columnheader">Duration</span>
            </div>
            {runs.map((run) => {
              const expanded = expandedID === run.id;
              return (
                <div key={run.id} className={styles.rowGroup}>
                  <div
                    className={styles.row}
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={() => {
                      setExpandedID(expanded ? null : run.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setExpandedID(expanded ? null : run.id);
                      }
                    }}
                  >
                    <span>
                      <RunStatusBadge status={run.status} />
                    </span>
                    <span className={styles.started}>
                      {run.started_at === null ? '-' : formatDateTime(run.started_at)}
                    </span>
                    <span className={styles.duration}>
                      {formatDuration(run.started_at, run.completed_at)}
                    </span>
                  </div>
                  {expanded && (
                    <div className={styles.details}>
                      <RunDetails run={run} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {hasNextPage && (
            <div className={styles.loadMore}>
              <Button
                variant="ghost"
                size="small"
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load More'}
              </Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
};
