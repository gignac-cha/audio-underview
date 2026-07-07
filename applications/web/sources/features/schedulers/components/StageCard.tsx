import type { SchedulerStage } from '@audio-underview/schemas';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';
import { Badge } from '../../../components/Badge.tsx';
import { Icon } from '../../../components/Icon.tsx';
import styles from './StageCard.module.css';

export interface StageCardProps {
  stage: SchedulerStage;
  crawlerName: string | undefined;
  onDelete: () => void;
}

export const StageCard = ({ stage, crawlerName, onDelete }: StageCardProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.id,
  });

  const label = crawlerName ?? `${stage.crawler_id.slice(0, 8)}...`;

  return (
    <div
      ref={setNodeRef}
      className={clsx(styles.card, isDragging && styles.dragging)}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className={styles.handle}
        aria-label="Drag to reorder stage"
        {...attributes}
        {...listeners}
      >
        <Icon name="grip" size={16} />
      </button>
      <span className={styles.order}>{stage.stage_order + 1}</span>
      <span className={styles.name}>{label}</span>
      {stage.fan_out_field !== null && stage.fan_out_field.length > 0 && (
        <Badge tone="info">
          <Icon name="branch" size={11} /> {stage.fan_out_field}
        </Badge>
      )}
      <button
        type="button"
        className={styles.delete}
        aria-label={`Remove stage ${label}`}
        onClick={onDelete}
      >
        <Icon name="trash" size={15} />
      </button>
    </div>
  );
};
