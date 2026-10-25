/**
 * One compact pipeline stage line — the single row shape shared by the running
 * tracker and the finished newscast's generation details:
 *
 *   ● Write script   117 turns                                    12.4s  ›
 *
 * state dot · stage label · ONE key metric · duration (live while active) ·
 * chevron. Everything else the old telemetry cards showed moved behind the row
 * into {@link StageDetailDialog}, which this row owns and opens on click.
 */

import { useState } from 'react';
import styled from '@emotion/styled';
import { css, keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons';
import type {
  JobDetails,
  JobStatus,
  NewscastStage,
} from '@audio-underview/newscast-core';

import { formatBytes, formatDuration, formatElapsed } from './formatting.ts';
import { jobSourceModeFor, skippedStageMetric } from './job-source-mode.ts';
import {
  STAGE_LABELS,
  WORKING_STAGES,
  stageStateFor,
  type StageState,
} from './stage-metadata.ts';
import { hasStageDetail, StageDetailDialog } from './StageDetailDialog.tsx';

/**
 * A stage's visual state in the row list. Extends the tracker's three-way state
 * with the two outcomes a finished newscast can have: `error` (the stage that
 * threw) and `skipped` (a stage the newscast never ran — legacy newscasts predate
 * `organize`, direct-input newscasts bypass the crawl stages, and a "read
 * verbatim" newscast bypasses organize and script as well).
 */
export type StageRowState = StageState | 'skipped' | 'error';

/**
 * Where `stage` sits in `status`, including the finished-only outcomes that
 * {@link stageStateFor} cannot express.
 */
export function stageRowStateFor(stage: NewscastStage, status: JobStatus): StageRowState {
  const isDone = status.status === 'done';
  const isError = status.status === 'error';
  // A stage the newscast's source mode never runs is skipped from the first read
  // on, not only once the newscast finishes — that is what stops a direct-input
  // newscast's crawl rows (and a verbatim one's organize/script rows) from looking
  // busy while it runs.
  if (skippedStageMetric(stage, jobSourceModeFor(status)) !== undefined) {
    return 'skipped';
  }
  if (isError && status.details?.failure?.stage === stage) {
    return 'error';
  }
  const state = stageStateFor(stage, status.stage, isDone);
  // A failed newscast is not still working on its current stage — it stopped there.
  if (isError && state === 'active') {
    return 'error';
  }
  // A completed newscast that recorded nothing for a stage never ran it.
  if (isDone && state === 'complete' && !hasStageDetail(stage, status.details)) {
    return 'skipped';
  }
  return state;
}

/**
 * The ONE number worth reading at a glance for each stage, e.g.
 * `23 units · 2 parts`. Undefined until the stage has produced its telemetry.
 * Exported so other pipeline views can reuse the exact same figures.
 */
export function stageKeyMetric(
  stage: NewscastStage,
  details: JobDetails | undefined,
): string | undefined {
  if (details === undefined) {
    return undefined;
  }
  const { crawlList, crawlArticles, organize, script, tts, merge, partsSummary } = details;
  switch (stage) {
    case 'crawl-list':
      return crawlList === undefined
        ? undefined
        : `${crawlList.count} article${crawlList.count === 1 ? '' : 's'} · ${formatBytes(crawlList.bytes)}`;
    case 'crawl-articles':
      return crawlArticles === undefined
        ? undefined
        : `${crawlArticles.articles.length} article${crawlArticles.articles.length === 1 ? '' : 's'} · ${formatBytes(crawlArticles.totalBytes)}`;
    case 'organize':
      if (organize !== undefined) {
        return `${organize.unitCount} unit${organize.unitCount === 1 ? '' : 's'} · ${organize.partCount} part${organize.partCount === 1 ? '' : 's'}`;
      }
      // Legacy newscasts have no organize telemetry, but their part count is
      // still recoverable from the rollup — better than showing nothing.
      return partsSummary === undefined || partsSummary.length === 0
        ? undefined
        : `${partsSummary.length} part${partsSummary.length === 1 ? '' : 's'}`;
    case 'script':
      return script === undefined ? undefined : `${script.turns} turns`;
    case 'tts':
      return tts === undefined
        ? undefined
        : `${tts.chunks} chunk${tts.chunks === 1 ? '' : 's'} · ${formatElapsed(tts.audioDurationMs)}`;
    case 'merge':
      return merge === undefined ? undefined : formatBytes(merge.mp3Bytes);
    default:
      return undefined;
  }
}

/**
 * The row's right-hand time: the recorded duration once the stage finished, the
 * live elapsed while it is running, and nothing before it starts.
 */
function stageDurationText(
  stage: NewscastStage,
  details: JobDetails | undefined,
  state: StageRowState,
  nowMilliseconds: number | undefined,
): string | undefined {
  const timing = details?.timings?.[stage];
  if (timing?.durationMs !== undefined) {
    return formatDuration(timing.durationMs);
  }
  if (state !== 'active') {
    // An unfinished timing on a stopped newscast would otherwise tick forever.
    return undefined;
  }
  if (timing?.startedAt !== undefined && nowMilliseconds !== undefined) {
    return formatDuration(Math.max(0, nowMilliseconds - timing.startedAt));
  }
  return 'running';
}

const blink = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
`;

const DOT_COLORS: Record<StageRowState, string> = {
  complete: 'var(--color-success)',
  active: 'var(--accent-primary)',
  error: 'var(--color-error)',
  pending: 'transparent',
  skipped: 'transparent',
};

/** Everything both row shapes share; only the interaction affordance differs. */
const rowShell = css`
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  text-align: left;
  padding: 0.5rem 0.875rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  transition: var(--transition-fast);
`;

const Row = styled.button`
  ${rowShell};
  cursor: pointer;

  &:hover {
    border-color: var(--accent-primary);
    background: var(--accent-muted);
  }
`;

/**
 * A stage the newscast never ran. Deliberately NOT a button: its detail dialog has
 * nothing to show — the skip label replaces the telemetry the dialog would
 * otherwise read — so offering a press would open an empty panel contradicting
 * the label right next to it. No chevron either, for the same reason.
 */
const SkippedRow = styled.div`
  ${rowShell};
  cursor: default;
  opacity: 0.6;
`;

const Dot = styled.span<{ state: StageRowState }>`
  flex-shrink: 0;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: ${(props) => DOT_COLORS[props.state]};
  border: ${(props) =>
    props.state === 'pending' || props.state === 'skipped'
      ? '1px solid var(--text-muted)'
      : 'none'};
  border-style: ${(props) => (props.state === 'skipped' ? 'dashed' : 'solid')};
  /* Emotion's css helper (not a plain template string) so the @keyframes rule
     is actually injected alongside the generated animation name. */
  ${(props) =>
    props.state === 'active'
      ? css`
          animation: ${blink} 1.6s ease-in-out infinite;
        `
      : undefined}
`;

const Label = styled.span<{ state: StageRowState }>`
  flex-shrink: 0;
  font-size: 0.8125rem;
  font-weight: ${(props) => (props.state === 'active' ? 700 : 400)};
  color: ${(props) =>
    props.state === 'pending' || props.state === 'skipped'
      ? 'var(--text-muted)'
      : 'var(--text-primary)'};
`;

const Metric = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 0.75rem;
  color: var(--text-secondary);
`;

/** Keeps the duration and chevron pinned right when there is no key metric. */
const Spacer = styled.span`
  flex: 1;
`;

const Duration = styled.span<{ state: StageRowState }>`
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.71875rem;
  color: ${(props) =>
    props.state === 'active' ? 'var(--accent-primary)' : 'var(--text-muted)'};
`;

const Chevron = styled.span`
  flex-shrink: 0;
  font-size: 0.6875rem;
  color: var(--text-muted);
`;

export interface StageRowProps {
  stage: NewscastStage;
  state: StageRowState;
  details?: JobDetails;
  /** Shared 1s wall-clock tick, used for the ACTIVE stage's live elapsed. */
  nowMilliseconds?: number;
  /**
   * Why this stage was never run ('Direct input' / 'Read verbatim'), which
   * REPLACES the telemetry metric: a direct-input newscast still records
   * `crawlList` telemetry for its list title, and showing that figure on a stage
   * that never crawled is exactly the confusion the skip label removes.
   */
  skippedMetric?: string;
}

export function StageRow({ stage, state, details, nowMilliseconds, skippedMetric }: StageRowProps) {
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const metric = skippedMetric ?? stageKeyMetric(stage, details);
  const duration = stageDurationText(stage, details, state, nowMilliseconds);
  const body = (
    <>
      <Dot state={state} aria-hidden={true} />
      <Label state={state}>{STAGE_LABELS[stage]}</Label>
      {metric !== undefined ? <Metric>{metric}</Metric> : <Spacer />}
      {duration !== undefined && <Duration state={state}>{duration}</Duration>}
    </>
  );

  if (state === 'skipped') {
    return <SkippedRow data-testid={`stage-row-${stage}`}>{body}</SkippedRow>;
  }

  return (
    <>
      <Row type="button" data-testid={`stage-row-${stage}`} onClick={() => setIsDetailOpen(true)}>
        {body}
        <Chevron>
          <FontAwesomeIcon icon={faChevronRight} aria-hidden={true} />
        </Chevron>
      </Row>
      <StageDetailDialog
        stage={stage}
        details={details}
        open={isDetailOpen}
        onOpenChange={setIsDetailOpen}
      />
    </>
  );
}

const RowList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
`;

export interface StageRowListProps {
  status: JobStatus;
  nowMilliseconds?: number;
}

/**
 * The full pipeline as compact rows — one per working stage, in pipeline order.
 * Shared verbatim by the running tracker and the finished newscast's details so
 * both surfaces read identically.
 */
export function StageRowList({ status, nowMilliseconds }: StageRowListProps) {
  const sourceMode = jobSourceModeFor(status);
  return (
    <RowList>
      {WORKING_STAGES.map((stage) => (
        <StageRow
          key={stage}
          stage={stage}
          state={stageRowStateFor(stage, status)}
          details={status.details}
          nowMilliseconds={nowMilliseconds}
          skippedMetric={skippedStageMetric(stage, sourceMode)}
        />
      ))}
    </RowList>
  );
}
