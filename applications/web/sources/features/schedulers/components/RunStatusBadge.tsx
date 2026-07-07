import type { SchedulerRunStatus } from '@audio-underview/schemas';
import { Badge, type BadgeTone } from '../../../components/Badge.tsx';

const CONFIG: Record<SchedulerRunStatus, { tone: BadgeTone; label: string }> = {
  pending: { tone: 'neutral', label: 'Pending' },
  running: { tone: 'info', label: 'Running' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'error', label: 'Failed' },
  partially_failed: { tone: 'warning', label: 'Partial' },
};

export const RunStatusBadge = ({ status }: { status: SchedulerRunStatus }) => {
  const { tone, label } = CONFIG[status];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
};
