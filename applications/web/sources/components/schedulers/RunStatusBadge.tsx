import styled from '@emotion/styled';
import type { SchedulerRunStatus } from '@audio-underview/supabase-connector';

const STATUS_COLORS: Record<SchedulerRunStatus, string> = {
  pending: 'var(--text-muted)',
  running: '#60a5fa',
  completed: 'var(--color-success)',
  failed: 'var(--color-error)',
  partially_failed: '#f59e0b',
};

const Badge = styled('span', {
  shouldForwardProp: (prop) => prop !== 'color',
})<{ color: string }>`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: ${({ color }) => color};
`;

const Dot = styled('span', {
  shouldForwardProp: (prop) => prop !== 'color',
})<{ color: string }>`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${({ color }) => color};
`;

const LABELS: Record<SchedulerRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  partially_failed: 'Partial',
};

interface RunStatusBadgeProperties {
  status: SchedulerRunStatus;
}

export function RunStatusBadge({ status }: RunStatusBadgeProperties) {
  const color = STATUS_COLORS[status];
  return (
    <Badge color={color}>
      <Dot color={color} />
      {LABELS[status]}
    </Badge>
  );
}
