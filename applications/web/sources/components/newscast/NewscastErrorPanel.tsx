/**
 * The failed-newscast view: a headline naming the failing stage, the FULL error
 * message (monospace, wrappable), and a collapsible "Debug details" section
 * rendering the persisted failure diagnosis — stop reason, failed TTS chunk,
 * per-stage timings, per-article crawl degradations, and the newscast ID.
 * Everything here is stored with the newscast, so what the user sees is exactly
 * what a later investigation would find.
 *
 * A failed newscast is not resumed or re-created from here: a new one is made by
 * running its schedule again in Schedulers.
 */

import styled from '@emotion/styled';
import { useNavigate } from 'react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleExclamation, faKey } from '@fortawesome/free-solid-svg-icons';
import {
  NEWSCAST_STAGES,
  type JobStatus,
  type LlmProvider,
} from '@audio-underview/newscast-core';

import { PROVIDER_LABELS } from '../../schemas/provider-keys.ts';
import { formatDuration } from './formatting.ts';
import { STAGE_LABELS } from './stage-metadata.ts';

/**
 * The provider a `blocked_no_key` newscast was refused for, read from whichever
 * request-shaped field survived. `scriptRequest` is recorded BEFORE the LLM call,
 * so it exists even for a newscast that never reached the fuller request
 * snapshot; `request.provider` / the snapshot's `keyIdentity.provider` back it up
 * for the rest.
 */
function resolveBlockedProvider(status: JobStatus): LlmProvider | undefined {
  return (
    status.details?.scriptRequest?.provider ??
    status.details?.request?.provider ??
    status.details?.request?.keyIdentity?.provider
  );
}

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1.25rem;
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 12px;
`;

const Headline = styled.h3`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  font-size: 0.9375rem;
  color: var(--color-error);
`;

const Message = styled.pre`
  margin: 0;
  padding: 0.875rem 1rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
`;

const Debug = styled.details`
  font-size: 0.8125rem;
  color: var(--text-secondary);

  & > summary {
    cursor: pointer;
    font-weight: 600;
    color: var(--text-secondary);
    &:hover {
      color: var(--text-primary);
    }
  }
`;

const DebugBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 0.75rem;
`;

const FactList = styled.dl`
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.375rem 1rem;
  margin: 0;
  font-size: 0.75rem;

  & > dt {
    color: var(--text-muted);
  }
  & > dd {
    margin: 0;
    font-family: var(--font-mono);
    color: var(--text-primary);
    word-break: break-all;
  }
`;

const StopReasonChip = styled.span`
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 6px;
  font-weight: 700;
  background: rgba(239, 68, 68, 0.2);
`;

const TimingsTable = styled.table`
  border-collapse: collapse;
  font-size: 0.75rem;
  font-family: var(--font-mono);

  & td,
  & th {
    padding: 0.25rem 1rem 0.25rem 0;
    text-align: left;
    color: var(--text-secondary);
  }
  & th {
    color: var(--text-muted);
    font-weight: 600;
  }
`;

const DegradationList = styled.ul`
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-secondary);
`;

/**
 * The `blocked_no_key` guidance banner — visually distinct from the raw
 * provider-error `<Message>` below it, styled as a warning rather than the
 * panel's error red so it reads as "fix this and start again" rather than
 * "something broke".
 */
const BlockedKeyNote = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.625rem;
  padding: 0.875rem 1rem;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--text-primary);
  background: rgba(234, 179, 8, 0.1);
  border: 1px solid rgba(234, 179, 8, 0.35);
  border-radius: 10px;
`;

const BlockedKeyIcon = styled.span`
  flex-shrink: 0;
  color: rgb(234, 179, 8);
`;

const BlockedKeyText = styled.span`
  flex: 1;
  min-width: 12rem;
`;

const BlockedKeyButton = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.875rem;
  border-radius: 8px;
  font-size: 0.78125rem;
  font-weight: 700;
  background: var(--accent-primary);
  color: #ffffff;
  cursor: pointer;
  transition: var(--transition-fast);
  white-space: nowrap;

  &:hover {
    filter: brightness(1.15);
  }
  &:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
`;

export interface NewscastErrorPanelProps {
  status: JobStatus;
}

export function NewscastErrorPanel({ status }: NewscastErrorPanelProps) {
  const navigate = useNavigate();
  const failure = status.details?.failure;
  const timings = status.details?.timings;
  const degradedArticles = (status.details?.crawlArticles?.articles ?? []).filter(
    (article) => article.degradations !== undefined && article.degradations.length > 0,
  );
  const isBlockedNoKey = status.errorCode === 'blocked_no_key';
  const blockedProvider = isBlockedNoKey ? resolveBlockedProvider(status) : undefined;

  return (
    <Panel>
      <Headline role="alert">
        <FontAwesomeIcon icon={faCircleExclamation} aria-hidden={true} />
        Failed at {STAGE_LABELS[failure?.stage ?? status.stage]}
      </Headline>
      {isBlockedNoKey && (
        <BlockedKeyNote>
          <BlockedKeyIcon>
            <FontAwesomeIcon icon={faKey} aria-hidden={true} />
          </BlockedKeyIcon>
          <BlockedKeyText>
            {blockedProvider !== undefined ? `The ${PROVIDER_LABELS[blockedProvider]} key` : 'A provider key'}
            {' is missing or was rejected. Register the key in Settings, then run the schedule again.'}
          </BlockedKeyText>
          <BlockedKeyButton type="button" onClick={() => navigate('/settings')}>
            Go to Settings
          </BlockedKeyButton>
        </BlockedKeyNote>
      )}
      <Message>{status.error ?? 'The pipeline failed with an unknown error.'}</Message>
      <Debug>
        <summary>Debug details</summary>
        <DebugBody>
          <FactList>
            <dt>Newscast ID</dt>
            <dd>{status.id}</dd>
            {status.details?.scriptRequest !== undefined && (
              <>
                <dt>Request</dt>
                <dd>
                  {status.details.scriptRequest.provider}
                  {status.details.scriptRequest.model !== undefined
                    ? ` / ${status.details.scriptRequest.model}`
                    : ''}
                  {status.details.scriptRequest.effort !== undefined
                    ? ` / effort=${status.details.scriptRequest.effort}`
                    : ''}
                </dd>
              </>
            )}
            {failure !== undefined && (
              <>
                <dt>Failed stage</dt>
                <dd>{STAGE_LABELS[failure.stage]}</dd>
                {failure.stopReason !== undefined && (
                  <>
                    <dt>Stop reason</dt>
                    <dd>
                      <StopReasonChip>{failure.stopReason}</StopReasonChip>
                    </dd>
                  </>
                )}
                {failure.failedChunk !== undefined && (
                  <>
                    <dt>Failed TTS chunk</dt>
                    <dd>#{failure.failedChunk + 1}</dd>
                  </>
                )}
                <dt>Failed at</dt>
                <dd>{failure.at}</dd>
              </>
            )}
          </FactList>
          {timings !== undefined && Object.keys(timings).length > 0 && (
            <TimingsTable>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {NEWSCAST_STAGES.filter((stage) => timings[stage] !== undefined).map(
                  (stage) => {
                    const timing = timings[stage];
                    return (
                      <tr key={stage}>
                        <td>{STAGE_LABELS[stage]}</td>
                        <td>
                          {timing?.durationMs !== undefined
                            ? formatDuration(timing.durationMs)
                            : timing?.startedAt !== undefined
                              ? 'started, unfinished'
                              : '—'}
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </TimingsTable>
          )}
          {degradedArticles.length > 0 && (
            <div>
              Crawl degradations:
              <DegradationList>
                {degradedArticles.flatMap((article, articleIndex) =>
                  (article.degradations ?? []).map((reason, reasonIndex) => (
                    <li key={`${articleIndex}-${reasonIndex}`}>
                      {article.title}: {reason}
                    </li>
                  )),
                )}
              </DegradationList>
            </div>
          )}
        </DebugBody>
      </Debug>
    </Panel>
  );
}
