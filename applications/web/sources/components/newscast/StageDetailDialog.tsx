/**
 * Full per-stage telemetry in a modal dialog — the detail behind a compact
 * {@link StageRow}. Everything the old telemetry cards showed (model, tokens,
 * byte accounting, title lists, per-part rollup, timings, the degraded flag)
 * lives here so the row itself can stay one scannable line.
 *
 * Every field is optional and simply omitted when absent, so a RUNNING newscast
 * shows exactly what the pipeline has accumulated so far — there is no separate
 * "live" rendering path to keep in sync.
 */

import styled from '@emotion/styled';
import * as Dialog from '@radix-ui/react-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import type {
  JobDetails,
  NewscastStage,
  StageTiming,
} from '@audio-underview/newscast-core';

import {
  formatBytes,
  formatDuration,
  formatElapsed,
  formatTokens,
} from './formatting.ts';
import { STAGE_DESCRIPTIONS, STAGE_LABELS } from './stage-metadata.ts';

const Overlay = styled(Dialog.Overlay)`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 100;
`;

const Content = styled(Dialog.Content)`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 101;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 1.25rem;
  width: 92vw;
  max-width: 34rem;
  max-height: 80vh;
  box-shadow: var(--shadow-md);
`;

const DialogHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.25rem;
`;

const DialogTitle = styled(Dialog.Title)`
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
`;

const CloseButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: 8px;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

const DialogDescription = styled(Dialog.Description)`
  margin: 0 0 0.75rem;
  font-size: 0.75rem;
  color: var(--text-muted);
`;

const Scroller = styled.div`
  overflow-y: auto;
  min-height: 0;
  padding-right: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const Metrics = styled.p`
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-secondary);
`;

const Mono = styled.p`
  margin: 0;
  font-size: 0.71875rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
`;

/** Red pill flagging that organize degraded to a single-part fallback. */
const DegradedBadge = styled.span`
  align-self: flex-start;
  font-size: 0.6875rem;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--color-error);
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 999px;
  padding: 0.0625rem 0.5rem;
`;

const GroupHeading = styled.h4`
  margin: 0.375rem 0 0;
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
`;

const ItemList = styled.ul`
  margin: 0;
  padding-left: 1.1rem;
`;

const TitleItem = styled.li`
  font-size: 0.75rem;
  line-height: 1.6;
`;

const ArticleItem = styled.li`
  font-size: 0.75rem;
  line-height: 1.6;

  & > span.bytes {
    display: block;
    font-family: var(--font-mono);
    color: var(--text-muted);
  }
  & > span.degraded {
    display: block;
    font-family: var(--font-mono);
    color: var(--color-error);
  }
`;

const FailureBlock = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.08);
  border-radius: 10px;
  font-size: 0.75rem;
  color: var(--color-error);
  word-break: break-word;
`;

const EmptyNote = styled.p`
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-muted);
`;

/** Local clock time for a stage boundary (the dialog is the "when exactly" view). */
function formatClock(milliseconds: number): string {
  return new Date(milliseconds).toLocaleTimeString('en-US');
}

/** `duration 15.2s` / `running` plus the wall-clock boundaries, when recorded. */
function TimingLines({ timing }: { timing: StageTiming | undefined }) {
  if (timing === undefined) {
    return null;
  }
  const boundaries: string[] = [];
  if (timing.startedAt !== undefined) {
    boundaries.push(`started ${formatClock(timing.startedAt)}`);
  }
  if (timing.finishedAt !== undefined) {
    boundaries.push(`finished ${formatClock(timing.finishedAt)}`);
  }
  return (
    <>
      {timing.durationMs !== undefined ? (
        <Mono>duration {formatDuration(timing.durationMs)}</Mono>
      ) : timing.startedAt !== undefined ? (
        <Mono>running</Mono>
      ) : null}
      {boundaries.length > 0 && <Mono>{boundaries.join(' · ')}</Mono>}
    </>
  );
}

/** True when this stage has anything at all to show (details or timing). */
export function hasStageDetail(
  stage: NewscastStage,
  details: JobDetails | undefined,
): boolean {
  if (details === undefined) {
    return false;
  }
  if (details.timings?.[stage] !== undefined) {
    return true;
  }
  if (details.failure?.stage === stage) {
    return true;
  }
  switch (stage) {
    case 'crawl-list':
      return details.crawlList !== undefined;
    case 'crawl-articles':
      return details.crawlArticles !== undefined;
    case 'organize':
      // The per-part rollup is shown here too: organize is the stage that
      // planned the parts, so it is where a reader looks for them.
      return details.organize !== undefined || details.partsSummary !== undefined;
    case 'script':
      return details.script !== undefined || details.scriptRequest !== undefined;
    case 'tts':
      return details.tts !== undefined;
    case 'merge':
      return details.merge !== undefined || details.signal !== undefined;
    default:
      return false;
  }
}

function StageBody({
  stage,
  details,
}: {
  stage: NewscastStage;
  details: JobDetails;
}) {
  const {
    crawlList,
    crawlArticles,
    organize,
    script,
    scriptRequest,
    tts,
    merge,
    partsSummary,
    signal,
  } = details;

  if (stage === 'crawl-list' && crawlList !== undefined) {
    return (
      <>
        <Metrics>
          {crawlList.count} article{crawlList.count === 1 ? '' : 's'} ·{' '}
          {formatBytes(crawlList.bytes)}
        </Metrics>
        {crawlList.titles.length > 0 && (
          <>
            <GroupHeading>Titles</GroupHeading>
            <ItemList>
              {crawlList.titles.map((title, index) => (
                <TitleItem key={index}>{title}</TitleItem>
              ))}
            </ItemList>
          </>
        )}
      </>
    );
  }

  if (stage === 'crawl-articles' && crawlArticles !== undefined) {
    return (
      <>
        <Metrics>
          {formatBytes(crawlArticles.totalBytes)} total ·{' '}
          {crawlArticles.articles.length} article
          {crawlArticles.articles.length === 1 ? '' : 's'}
        </Metrics>
        {crawlArticles.articles.length > 0 && (
          <>
            <GroupHeading>Per-article sizes</GroupHeading>
            <ItemList>
              {crawlArticles.articles.map((article, index) => (
                <ArticleItem key={index}>
                  {article.title}
                  <span className="bytes">
                    original{' '}
                    {article.originalBytes > 0 ? formatBytes(article.originalBytes) : 'none'}
                    {' · '}geeknews{' '}
                    {article.geeknewsBytes > 0 ? formatBytes(article.geeknewsBytes) : 'none'}
                    {' · '}hn{' '}
                    {article.hackerNewsBytes > 0
                      ? formatBytes(article.hackerNewsBytes)
                      : 'none'}
                  </span>
                  {article.degradations !== undefined &&
                    article.degradations.map((reason, reasonIndex) => (
                      <span className="degraded" key={reasonIndex}>
                        ⚠ {reason}
                      </span>
                    ))}
                </ArticleItem>
              ))}
            </ItemList>
          </>
        )}
      </>
    );
  }

  if (stage === 'organize') {
    return (
      <>
        {organize !== undefined && (
          <>
            <Metrics>
              {organize.model} · {organize.unitCount} unit
              {organize.unitCount === 1 ? '' : 's'} · {organize.partCount} part
              {organize.partCount === 1 ? '' : 's'} ·{' '}
              {formatTokens(organize.estimatedScriptCharacters)} est chars
            </Metrics>
            {organize.turnTargets.length > 0 && (
              <Mono>turn targets {organize.turnTargets.join(' · ')}</Mono>
            )}
            {/* Length preset factor — shown only when it actually scaled the
                sizing (≠ 1), so a default 'standard' run stays clean. */}
            {organize.lengthFactor !== undefined && organize.lengthFactor !== 1 && (
              <Mono>length ×{organize.lengthFactor}</Mono>
            )}
            {(organize.promptTokens !== undefined ||
              organize.completionTokens !== undefined) && (
              <Mono>
                prompt {formatTokens(organize.promptTokens ?? 0)} · completion{' '}
                {formatTokens(organize.completionTokens ?? 0)} tokens
              </Mono>
            )}
            {organize.degraded === true && (
              <DegradedBadge>⚠ degraded → single part</DegradedBadge>
            )}
          </>
        )}
        {partsSummary !== undefined && partsSummary.length > 0 && (
          <>
            <GroupHeading>Parts</GroupHeading>
            <ItemList>
              {partsSummary.map((part) => (
                <TitleItem key={part.index}>
                  Part {part.index} · {part.turns} turn{part.turns === 1 ? '' : 's'} ·{' '}
                  {formatTokens(part.characters)} chars ·{' '}
                  {formatElapsed(part.audioDurationMs)}
                </TitleItem>
              ))}
            </ItemList>
          </>
        )}
      </>
    );
  }

  if (stage === 'script') {
    return (
      <>
        {script !== undefined && (
          <>
            <Metrics>
              {script.model} · {script.turns} turns · {formatTokens(script.characters)} chars
            </Metrics>
            {(script.promptTokens !== undefined ||
              script.completionTokens !== undefined) && (
              <Mono>
                prompt {formatTokens(script.promptTokens ?? 0)} · completion{' '}
                {formatTokens(script.completionTokens ?? 0)} tokens
              </Mono>
            )}
          </>
        )}
        {/* The REQUEST parameters survive a failure even when `script` never
            landed — the only way to see what a failed run was using. */}
        {script === undefined && scriptRequest !== undefined && (
          <Mono>
            requested {scriptRequest.provider}
            {scriptRequest.model !== undefined ? ` · ${scriptRequest.model}` : ''}
            {scriptRequest.effort !== undefined ? ` · effort ${scriptRequest.effort}` : ''}
          </Mono>
        )}
      </>
    );
  }

  if (stage === 'tts' && tts !== undefined) {
    return (
      <Metrics>
        {tts.chunks} chunk{tts.chunks === 1 ? '' : 's'} · audio{' '}
        {formatElapsed(tts.audioDurationMs)}
      </Metrics>
    );
  }

  if (stage === 'merge') {
    return (
      <>
        {merge !== undefined && (
          <Metrics>
            MP3 {formatBytes(merge.mp3Bytes)} · captions{' '}
            {merge.aligned ? 'aligned' : 'estimated'}
            {merge.words !== undefined ? ` · ${formatTokens(merge.words)} words` : ''}
          </Metrics>
        )}
        {/* The transition sting is generated per newscast and only for
            multi-part newscasts, so it rides along with the audio assembly. */}
        {signal !== undefined && (
          <Mono>
            signal {signal.generated ? 'generated' : 'skipped'}
            {signal.bytes !== undefined ? ` · ${formatBytes(signal.bytes)}` : ''}
          </Mono>
        )}
      </>
    );
  }

  return null;
}

export interface StageDetailDialogProps {
  stage: NewscastStage;
  details?: JobDetails;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The full telemetry of ONE stage. Controlled: {@link StageRow} owns the `open`
 * state and its own trigger row.
 */
export function StageDetailDialog({
  stage,
  details,
  open,
  onOpenChange,
}: StageDetailDialogProps) {
  const failure = details?.failure?.stage === stage ? details.failure : undefined;
  const hasContent = hasStageDetail(stage, details);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content>
          <DialogHeader>
            <DialogTitle>{STAGE_LABELS[stage]}</DialogTitle>
            <Dialog.Close asChild>
              <CloseButton type="button">
                <FontAwesomeIcon icon={faXmark} aria-hidden={true} />
                Close
              </CloseButton>
            </Dialog.Close>
          </DialogHeader>
          <DialogDescription>{STAGE_DESCRIPTIONS[stage]}</DialogDescription>
          <Scroller>
            {details !== undefined && <TimingLines timing={details.timings?.[stage]} />}
            {details !== undefined && <StageBody stage={stage} details={details} />}
            {failure !== undefined && (
              <FailureBlock role="alert">
                <span>{failure.message}</span>
                {failure.stopReason !== undefined && (
                  <span>stop reason {failure.stopReason}</span>
                )}
                {failure.failedChunk !== undefined && (
                  <span>failed chunk {failure.failedChunk}</span>
                )}
                <span>{failure.at}</span>
              </FailureBlock>
            )}
            {!hasContent && <EmptyNote>No details recorded for this stage yet.</EmptyNote>}
          </Scroller>
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
