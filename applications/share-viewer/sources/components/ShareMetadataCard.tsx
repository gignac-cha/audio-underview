/**
 * Everything the sharer chose to publish, and nothing else — folded away under
 * the transcript.
 *
 * The default is total privacy: the worker only assembles a field when its flag
 * is on, and this card renders nothing at all when the result is empty — no
 * placeholder rows, no "비공개" labels that would leak the existence of a
 * hidden field.
 *
 * Two design decisions live here (design doc §8, audit A4). First, production
 * credits are collapsed: a reader arriving from a messenger link needs the
 * newscast, not the model name, so the details sit behind a summary below the
 * script. Second, `sharedBy` is NOT shown here — social proof belongs next to
 * the title, and the byline renders it instead.
 */

import styled from '@emotion/styled';
import type { PublicShareMetadata } from '../schemas/public-share-view.ts';

const Card = styled.details`
  border-radius: 14px;
  background: ${(props) => props.theme.colours.surface};
  border: 1px solid ${(props) => props.theme.colours.border};
  overflow: hidden;
`;

const Summary = styled.summary`
  padding: 0.75rem 1.125rem;
  font-size: 0.8125rem;
  font-weight: 700;
  cursor: pointer;
  list-style: none;
  color: ${(props) => props.theme.colours.textSecondary};

  &::-webkit-details-marker {
    display: none;
  }

  &::before {
    content: '▸';
    display: inline-block;
    margin-right: 0.5rem;
    transition: transform 0.15s ease;
  }

  details[open] > &::before {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    &::before {
      transition: none;
    }
  }
`;

const Body = styled.div`
  display: grid;
  gap: 0.75rem;
  padding: 0 1.125rem 1rem;
`;

const Row = styled.div`
  display: grid;
  grid-template-columns: 5rem 1fr;
  gap: 0.75rem;
  align-items: baseline;

  @media (max-width: 30rem) {
    grid-template-columns: 1fr;
    gap: 0.125rem;
  }
`;

const Label = styled.span`
  font-size: 0.75rem;
  font-weight: 700;
  color: ${(props) => props.theme.colours.textSecondary};
`;

const Value = styled.span`
  font-size: 0.875rem;
  color: ${(props) => props.theme.colours.textPrimary};
  overflow-wrap: anywhere;
`;

const SourceList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.375rem;
`;

const SourceLink = styled.a`
  font-size: 0.875rem;
  color: ${(props) => props.theme.colours.brandPrimaryStrong};
  overflow-wrap: anywhere;
`;

const DiscussionLink = styled.a`
  margin-left: 0.5rem;
  font-size: 0.75rem;
  color: ${(props) => props.theme.colours.textSecondary};
`;

/** The title of a source whose URL cannot be linked. */
const SourceText = styled.span`
  font-size: 0.875rem;
  color: ${(props) => props.theme.colours.textPrimary};
  overflow-wrap: anywhere;
`;

/**
 * Only http and https URLs become links. A source URL came from a crawled page,
 * so any other address (javascript:, data:) must never reach an href.
 */
function isHTTPURL(value: string | undefined): value is string {
  if (value === undefined) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** ISO string to a readable Korean date; unparseable input is shown verbatim. */
function formatCreatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' }).format(parsed);
}

/**
 * Whether this card has anything left to show. Deliberately narrower than the
 * shared `hasVisibleMetadata`: a share that published ONLY the sharer's name
 * still has a full byline, but nothing to credit down here.
 */
function hasCredits(metadata: PublicShareMetadata): boolean {
  return (
    metadata.model !== undefined ||
    (metadata.createdAt ?? '') !== '' ||
    (metadata.sources !== undefined && metadata.sources.length > 0)
  );
}

export interface ShareMetadataCardProps {
  metadata: PublicShareMetadata;
}

export function ShareMetadataCard({ metadata }: ShareMetadataCardProps) {
  if (!hasCredits(metadata)) {
    return null;
  }

  const modelText =
    metadata.model === undefined
      ? undefined
      : [metadata.model.provider, metadata.model.model, metadata.model.effort]
          .filter((part): part is string => part !== undefined && part !== '')
          .join(' · ');

  return (
    <Card aria-label="공개된 정보">
      <Summary>제작 정보</Summary>
      <Body>
        {modelText !== undefined && (
          <Row>
            <Label>생성 모델</Label>
            <Value>{modelText}</Value>
          </Row>
        )}
        {metadata.createdAt !== undefined && metadata.createdAt !== '' && (
          <Row>
            <Label>생성일</Label>
            <Value>{formatCreatedAt(metadata.createdAt)}</Value>
          </Row>
        )}
        {metadata.sources !== undefined && metadata.sources.length > 0 && (
          <Row>
            <Label>출처</Label>
            <SourceList>
              {metadata.sources.map((source) => (
                <li key={source.originalUrl}>
                  {isHTTPURL(source.originalUrl) ? (
                    <SourceLink
                      href={source.originalUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {source.title}
                    </SourceLink>
                  ) : (
                    <SourceText>{source.title}</SourceText>
                  )}
                  {isHTTPURL(source.discussionUrl) && (
                    <DiscussionLink
                      href={source.discussionUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      토론
                    </DiscussionLink>
                  )}
                </li>
              ))}
            </SourceList>
          </Row>
        )}
      </Body>
    </Card>
  );
}
