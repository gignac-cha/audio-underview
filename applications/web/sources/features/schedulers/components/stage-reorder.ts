import type { SchedulerStage } from '@audio-underview/schemas';
import { arrayMove } from '@dnd-kit/sortable';

/**
 * active를 over 위치로 옮기고 stage_order를 0-based로 재부여한다.
 * 이동이 불필요하거나 대상이 없으면 null (스펙 §4.5.2 optimistic reorder).
 */
export const applyStageReorder = (
  stages: SchedulerStage[],
  activeID: string,
  overID: string,
): SchedulerStage[] | null => {
  if (activeID === overID) {
    return null;
  }
  const oldIndex = stages.findIndex((stage) => stage.id === activeID);
  const newIndex = stages.findIndex((stage) => stage.id === overID);
  if (oldIndex < 0 || newIndex < 0) {
    return null;
  }
  return arrayMove(stages, oldIndex, newIndex).map((stage, index) => ({
    ...stage,
    stage_order: index,
  }));
};
