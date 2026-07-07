import type { SchedulerStage } from '@audio-underview/schemas';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useRef, useState } from 'react';
import { toErrorMessage } from '../../../api/errors.ts';
import { useDeleteStage, useReorderStages } from '../../../api/schedulers.ts';
import { Button } from '../../../components/Button.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { Icon } from '../../../components/Icon.tsx';
import { Section } from '../../../components/Section.tsx';
import { useToasts } from '../../../state/toasts.ts';
import { StageCard } from './StageCard.tsx';
import { applyStageReorder } from './stage-reorder.ts';
import styles from './StageList.module.css';

export interface StageListProps {
  schedulerID: string;
  stages: SchedulerStage[];
  crawlerMap: Map<string, string>;
  onAddStage: () => void;
}

export const StageList = ({ schedulerID, stages, crawlerMap, onAddStage }: StageListProps) => {
  const { reorderStages } = useReorderStages(schedulerID);
  const { deleteStage, status: deleteStatus } = useDeleteStage(schedulerID);
  const { showSuccess, showError } = useToasts();

  const [optimistic, setOptimistic] = useState<SchedulerStage[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SchedulerStage | null>(null);
  const reorderingRef = useRef(false);
  const previousStagesRef = useRef(stages);

  // 서버 stages(props)가 바뀌면 optimistic 폐기 — 서버 우선 (스펙 §4.5.2).
  if (previousStagesRef.current !== stages) {
    previousStagesRef.current = stages;
    reorderingRef.current = false;
    if (optimistic !== null) {
      setOptimistic(null);
    }
  }

  const displayed = optimistic ?? stages;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || reorderingRef.current) {
      return;
    }
    const reordered = applyStageReorder(displayed, String(active.id), String(over.id));
    if (reordered === null) {
      return;
    }
    setOptimistic(reordered);
    reorderingRef.current = true;
    try {
      await reorderStages(reordered.map((stage) => stage.id));
      // 성공 시 setQueryData → props 갱신 → optimistic 폐기
    } catch (error) {
      setOptimistic(null);
      reorderingRef.current = false;
      showError('Reorder failed', toErrorMessage(error));
    }
  };

  const confirmDelete = async () => {
    if (pendingDelete === null) {
      return;
    }
    try {
      await deleteStage(pendingDelete.id);
      showSuccess('Stage removed from pipeline.');
    } catch (error) {
      showError('Delete failed', toErrorMessage(error));
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <Section
      title="Pipeline"
      actions={
        <Button
          variant="secondary"
          size="small"
          iconLeft={<Icon name="plus" size={14} />}
          onClick={onAddStage}
        >
          Add Stage
        </Button>
      }
    >
      {displayed.length === 0 ? (
        <p className={styles.empty}>No stages yet. Add your first crawler to the pipeline.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void handleDragEnd(event)}>
          <SortableContext
            items={displayed.map((stage) => stage.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol className={styles.list}>
              {displayed.map((stage, index) => (
                <li key={stage.id}>
                  <StageCard
                    stage={stage}
                    crawlerName={crawlerMap.get(stage.crawler_id)}
                    onDelete={() => {
                      setPendingDelete(stage);
                    }}
                  />
                  {index < displayed.length - 1 && (
                    <span className={styles.connector} aria-hidden="true">
                      <Icon name="chevronDown" size={16} />
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Remove stage?"
        description={
          pendingDelete === null
            ? null
            : 'This stage will be removed from the pipeline. This action cannot be undone.'
        }
        confirmLabel="Remove"
        cancelLabel="Cancel"
        confirmVariant="danger"
        initialFocus="cancel"
        busy={deleteStatus === 'pending'}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setPendingDelete(null);
        }}
      />
    </Section>
  );
};
