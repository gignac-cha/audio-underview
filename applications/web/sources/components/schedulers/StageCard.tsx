import styled from '@emotion/styled';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGripVertical, faTrash, faCodeBranch } from '@fortawesome/free-solid-svg-icons';
import type { SchedulerStageRow, CrawlerRow } from '@audio-underview/supabase-connector';

const Card = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  transition: border-color 0.15s;

  &:hover {
    border-color: var(--border-focus);
  }
`;

const DragHandle = styled.div`
  display: flex;
  align-items: center;
  color: var(--text-muted);
  cursor: grab;
  padding: 0.25rem;

  &:active {
    cursor: grabbing;
  }
`;

const OrderBadge = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--accent-muted);
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--text-primary);
`;

const StageInfo = styled.div`
  flex: 1;
  min-width: 0;
`;

const CrawlerName = styled.span`
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
`;

const FanOutBadge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-left: 0.5rem;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  background: rgba(96, 165, 250, 0.15);
  font-size: 0.6875rem;
  color: #60a5fa;
`;

const DeleteButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: var(--transition-fast);
  flex-shrink: 0;

  &:hover {
    color: var(--color-error);
    background: rgba(239, 68, 68, 0.1);
  }
`;

interface StageCardProperties {
  stage: SchedulerStageRow;
  crawlerMap: Map<string, CrawlerRow>;
  onDelete: (stageID: string) => void;
}

export function StageCard({ stage, crawlerMap, onDelete }: StageCardProperties) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const crawler = crawlerMap.get(stage.crawler_id);
  const crawlerDisplayName = crawler?.name ?? stage.crawler_id.slice(0, 8) + '...';

  return (
    <Card ref={setNodeRef} style={style}>
      <DragHandle {...attributes} {...listeners}>
        <FontAwesomeIcon icon={faGripVertical} />
      </DragHandle>
      <OrderBadge>{stage.stage_order}</OrderBadge>
      <StageInfo>
        <CrawlerName>{crawlerDisplayName}</CrawlerName>
        {stage.fan_out_field && (
          <FanOutBadge>
            <FontAwesomeIcon icon={faCodeBranch} />
            {stage.fan_out_field}
          </FanOutBadge>
        )}
      </StageInfo>
      <DeleteButton onClick={() => onDelete(stage.id)} title="Remove stage">
        <FontAwesomeIcon icon={faTrash} />
      </DeleteButton>
    </Card>
  );
}
