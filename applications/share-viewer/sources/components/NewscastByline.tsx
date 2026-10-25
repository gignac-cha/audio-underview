/**
 * The line under the title that answers "who sent me this, and how long is it?"
 * before the reader has scrolled anywhere (design doc §4, audit A3).
 *
 * Length and part count are always present — they come from the payload the
 * player needs anyway. The sharer and the date are opt-in metadata, so they are
 * simply absent when the sharer published neither; nothing renders a placeholder.
 */

import { Fragment } from 'react';
import styled from '@emotion/styled';
import { formatDurationLabel } from '../playback/timings.ts';

const Byline = styled.p`
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.375rem;
  font-size: 0.875rem;
  line-height: 1.6;
  color: ${(props) => props.theme.colours.textSecondary};
`;

const Sharer = styled.span`
  font-weight: 700;
  color: ${(props) => props.theme.colours.textPrimary};
`;

const Separator = styled.span`
  color: ${(props) => props.theme.colours.border};
`;

/** A readable Korean date, or nothing at all when the string is unparseable. */
function formatSharedDate(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' }).format(parsed);
}

export interface NewscastBylineProps {
  /** Display name or email of the sharer, when they opted into publishing one. */
  sharerName?: string;
  totalMilliseconds: number;
  partCount: number;
  /** ISO timestamp from the opt-in metadata. */
  createdAt?: string;
}

export function NewscastByline({
  sharerName,
  totalMilliseconds,
  partCount,
  createdAt,
}: NewscastBylineProps) {
  const sharedDate =
    createdAt === undefined || createdAt === '' ? undefined : formatSharedDate(createdAt);

  const items: { key: string; node: React.ReactNode }[] = [];
  if (sharerName !== undefined && sharerName !== '') {
    items.push({ key: 'sharer', node: <Sharer>{sharerName}님이 공유</Sharer> });
  }
  items.push({ key: 'duration', node: <span>{formatDurationLabel(totalMilliseconds)}</span> });
  items.push({ key: 'parts', node: <span>{partCount}부</span> });
  if (sharedDate !== undefined) {
    items.push({ key: 'date', node: <span>{sharedDate}</span> });
  }

  return (
    <Byline data-testid="newscast-byline">
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && <Separator aria-hidden="true">·</Separator>}
          {item.node}
        </Fragment>
      ))}
    </Byline>
  );
}
