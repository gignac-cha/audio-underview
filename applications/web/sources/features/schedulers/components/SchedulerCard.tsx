import type { Scheduler } from '@audio-underview/schemas';
import { Badge } from '../../../components/Badge.tsx';
import { Icon } from '../../../components/Icon.tsx';
import { formatDate } from '../../../tools/format.ts';
import styles from './SchedulerCard.module.css';

export interface SchedulerCardProps {
  scheduler: Scheduler;
  onOpen: () => void;
  onDelete: () => void;
}

export const SchedulerCard = ({ scheduler, onOpen, onDelete }: SchedulerCardProps) => (
  <div
    className={styles.card}
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen();
      }
    }}
  >
    <div className={styles.top}>
      <Badge tone={scheduler.is_enabled ? 'success' : 'neutral'} dot>
        {scheduler.is_enabled ? 'Enabled' : 'Disabled'}
      </Badge>
      <button
        type="button"
        className={styles.delete}
        aria-label={`Delete ${scheduler.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <Icon name="trash" size={16} />
      </button>
    </div>
    <h2 className={styles.name}>{scheduler.name}</h2>
    <p className={styles.cron}>
      {scheduler.cron_expression === null || scheduler.cron_expression.length === 0
        ? 'Manual only'
        : scheduler.cron_expression}
    </p>
    <p className={styles.meta}>
      {scheduler.last_run_at === null
        ? 'Never run'
        : `Last run ${formatDate(scheduler.last_run_at)}`}
    </p>
  </div>
);
