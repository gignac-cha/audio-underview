import { describe, expect, it } from 'vitest';
import { applyStageReorder } from '../sources/features/schedulers/components/stage-reorder.ts';
import { testStage } from './fixtures.ts';

const stages = [
  testStage({ id: '11111111-1111-4111-8111-111111111111', stage_order: 0 }),
  testStage({ id: '22222222-2222-4222-8222-222222222222', stage_order: 1 }),
  testStage({ id: '33333333-3333-4333-8333-333333333333', stage_order: 2 }),
];

describe('applyStageReorder', () => {
  it('moves a stage and reassigns 0-based order', () => {
    const result = applyStageReorder(stages, stages[0]!.id, stages[2]!.id);
    expect(result?.map((stage) => stage.id)).toEqual([stages[1]!.id, stages[2]!.id, stages[0]!.id]);
    expect(result?.map((stage) => stage.stage_order)).toEqual([0, 1, 2]);
  });

  it('returns null when active equals over', () => {
    expect(applyStageReorder(stages, stages[0]!.id, stages[0]!.id)).toBeNull();
  });

  it('returns null when an id is not found', () => {
    expect(applyStageReorder(stages, 'missing', stages[1]!.id)).toBeNull();
  });
});
