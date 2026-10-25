/**
 * The master list of newscasts — loading skeletons, an empty state, and one
 * {@link NewscastListItem} per newscast. On narrow screens the page passes the
 * selected newscast's detail via `inlineDetail`, rendered inside the selected row.
 */

import type { ReactNode } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import type { NewscastJobSummary } from '@audio-underview/newscast-core';

import { NewscastListItem } from './NewscastListItem.tsx';

const List = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
`;

const shimmer = keyframes`
  0% { opacity: 0.5; }
  50% { opacity: 1; }
  100% { opacity: 0.5; }
`;

const Skeleton = styled.li`
  list-style: none;
  height: 3.5rem;
  border-radius: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  animation: ${shimmer} 1.4s ease-in-out infinite;
`;

const EmptyState = styled.p`
  margin: 0;
  padding: 1.25rem;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px dashed var(--border-subtle);
  border-radius: 12px;
`;

const ErrorNote = styled.p`
  margin: 0;
  padding: 0.875rem 1rem;
  font-size: 0.8125rem;
  color: var(--color-error);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 12px;
`;

export interface NewscastListProps {
  jobs: NewscastJobSummary[];
  isLoading: boolean;
  error?: Error;
  selectedJobID?: string;
  /** The newscast bound to the floating player bar, if any (♪ row indicator). */
  playingJobID?: string;
  nowMilliseconds: number;
  onSelect: (jobID: string) => void;
  /** Rendered inside the SELECTED row (mobile accordion); omit on desktop. */
  inlineDetail?: ReactNode;
}

export function NewscastList({
  jobs,
  isLoading,
  error,
  selectedJobID,
  playingJobID,
  nowMilliseconds,
  onSelect,
  inlineDetail,
}: NewscastListProps) {
  if (error !== undefined) {
    return <ErrorNote role="alert">{error.message}</ErrorNote>;
  }
  if (isLoading) {
    return (
      <List aria-busy="true">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </List>
    );
  }
  if (jobs.length === 0) {
    return (
      <EmptyState>
        No newscasts yet — start one above and it appears here.
      </EmptyState>
    );
  }
  return (
    <List>
      {jobs.map((job) => {
        const selected = job.id === selectedJobID;
        const expanded = selected && inlineDetail !== undefined;
        return (
          <NewscastListItem
            key={job.id}
            job={job}
            selected={selected}
            expanded={expanded}
            isPlaying={job.id === playingJobID}
            nowMilliseconds={nowMilliseconds}
            onSelect={onSelect}
          >
            {expanded ? inlineDetail : undefined}
          </NewscastListItem>
        );
      })}
    </List>
  );
}
