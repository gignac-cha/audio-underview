import { useReducer } from 'react';
import styled from '@emotion/styled';
import { DndContext, closestCenter, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faArrowDown } from '@fortawesome/free-solid-svg-icons';
import type { SchedulerStageRow, CrawlerRow } from '@audio-underview/supabase-connector';
import { useReorderStages, useDeleteStage } from '../../hooks/use-scheduler-manager.ts';
import { useToast } from '../../hooks/use-toast.ts';
import { StageCard } from './StageCard.tsx';
import { StageCreateDialog } from './StageCreateDialog.tsx';

const Container = styled.section`
  margin-bottom: 2rem;
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
`;

const SectionTitle = styled.h2`
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
`;

const AddButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--accent-primary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    background: var(--accent-muted);
  }
`;

const StageListContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0;
`;

const ArrowConnector = styled.div`
  display: flex;
  justify-content: center;
  padding: 0.25rem 0;
  color: var(--text-muted);
  font-size: 0.625rem;
`;

const EmptyMessage = styled.p`
  text-align: center;
  padding: 2rem;
  color: var(--text-muted);
  font-size: 0.875rem;
`;

interface OptimisticState {
  serverStages: SchedulerStageRow[];
  displayStages: SchedulerStageRow[];
  createDialogOpen: boolean;
}

type OptimisticAction =
  | { type: 'reorder'; reordered: SchedulerStageRow[] }
  | { type: 'reset' }
  | { type: 'set_dialog'; open: boolean };

function optimisticReducer(state: OptimisticState, action: OptimisticAction): OptimisticState {
  switch (action.type) {
    case 'reorder':
      return { ...state, displayStages: action.reordered };
    case 'reset':
      return { ...state, displayStages: state.serverStages };
    case 'set_dialog':
      return { ...state, createDialogOpen: action.open };
  }
}

function initializeState(stages: SchedulerStageRow[]): OptimisticState {
  return { serverStages: stages, displayStages: stages, createDialogOpen: false };
}

interface StageListProperties {
  schedulerID: string;
  stages: SchedulerStageRow[];
  crawlerMap: Map<string, CrawlerRow>;
}

export function StageList({ schedulerID, stages, crawlerMap }: StageListProperties) {
  const { showToast } = useToast();
  const { reorderStages, status: reorderStatus } = useReorderStages();
  const isReordering = reorderStatus === 'pending';
  const { deleteStage } = useDeleteStage();
  const [state, dispatch] = useReducer(optimisticReducer, stages, initializeState);

  const displayStages = state.serverStages === stages ? state.displayStages : stages;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    if (isReordering) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = displayStages.findIndex((stage) => stage.id === active.id);
    const newIndex = displayStages.findIndex((stage) => stage.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(displayStages, oldIndex, newIndex).map((stage, index) => ({
      ...stage,
      stage_order: index,
    }));

    dispatch({ type: 'reorder', reordered });

    try {
      await reorderStages({
        scheduler_id: schedulerID,
        stage_ids: reordered.map((stage: SchedulerStageRow) => stage.id),
      });
    } catch (error) {
      dispatch({ type: 'reset' });
      const message = error instanceof Error ? error.message : 'Failed to reorder stages';
      showToast('Error', message, 'error');
    }
  };

  const handleDeleteStage = async (stageID: string) => {
    try {
      await deleteStage({ scheduler_id: schedulerID, stage_id: stageID });
      showToast('Deleted', 'Stage removed from pipeline.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete stage';
      showToast('Error', message, 'error');
    }
  };

  return (
    <Container>
      <SectionHeader>
        <SectionTitle>Pipeline Stages</SectionTitle>
        <AddButton onClick={() => dispatch({ type: 'set_dialog', open: true })}>
          <FontAwesomeIcon icon={faPlus} />
          Add Stage
        </AddButton>
      </SectionHeader>

      {displayStages.length === 0 ? (
        <EmptyMessage>No stages yet. Add your first crawler to the pipeline.</EmptyMessage>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={displayStages.map((stage) => stage.id)} strategy={verticalListSortingStrategy}>
            <StageListContainer>
              {displayStages.map((stage, index) => (
                <div key={stage.id}>
                  {index > 0 && (
                    <ArrowConnector>
                      <FontAwesomeIcon icon={faArrowDown} />
                    </ArrowConnector>
                  )}
                  <StageCard stage={stage} crawlerMap={crawlerMap} onDelete={handleDeleteStage} />
                </div>
              ))}
            </StageListContainer>
          </SortableContext>
        </DndContext>
      )}

      <StageCreateDialog
        open={state.createDialogOpen}
        onOpenChange={(open: boolean) => dispatch({ type: 'set_dialog', open })}
        schedulerID={schedulerID}
        nextOrder={displayStages.length}
      />
    </Container>
  );
}
