import { describe, expect } from 'vitest';
import { render } from 'vitest-browser-react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import type { CrawlerRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import { test } from '../../tests/extensions.ts';
import { StageCard } from './StageCard.tsx';

const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';

function createCrawlerStage(overrides: Partial<SchedulerStageRow> = {}): SchedulerStageRow {
  return {
    id: 'stage-1',
    scheduler_id: 'scheduler-1',
    stage_type: 'crawler',
    crawler_id: CRAWLER_ID,
    task_group_id: null,
    task_group_version: null,
    settings: null,
    stage_order: 0,
    input_schema: {},
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function createTaskGroupStage(): SchedulerStageRow {
  return createCrawlerStage({
    id: 'stage-2',
    stage_type: 'task_group',
    crawler_id: null,
    task_group_id: 'newscast',
    task_group_version: 1,
    settings: { voice: 'calm' },
    stage_order: 1,
  });
}

function createCrawler(): CrawlerRow {
  return {
    id: CRAWLER_ID,
    user_uuid: 'u1',
    name: 'Headline Crawler',
    type: 'web',
    url_pattern: null,
    code: '',
    input_schema: {},
    output_schema: {},
    environment_variable_names: [],
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

function renderCard(stage: SchedulerStageRow, crawlerMap: Map<string, CrawlerRow> = new Map(), onDelete = vi.fn()) {
  return render(
    <DndContext>
      <SortableContext items={[stage.id]}>
        <StageCard stage={stage} crawlerMap={crawlerMap} onDelete={onDelete} />
      </SortableContext>
    </DndContext>,
  );
}

describe('StageCard', () => {
  test('shows a task group stage by its group and version', async () => {
    const screen = await renderCard(createTaskGroupStage());

    await expect.element(screen.getByText('Task group newscast v1')).toBeInTheDocument();
  });

  test('still removes a task group stage', async () => {
    const onDelete = vi.fn();
    const screen = await renderCard(createTaskGroupStage(), new Map(), onDelete);

    await screen.getByTitle('Remove stage').click();

    expect(onDelete).toHaveBeenCalledWith('stage-2');
  });

  test('shows a crawler stage by the name of its crawler', async () => {
    const screen = await renderCard(createCrawlerStage(), new Map([[CRAWLER_ID, createCrawler()]]));

    await expect.element(screen.getByText('Headline Crawler')).toBeInTheDocument();
  });

  test('shows the start of the crawler ID while the crawler is unknown', async () => {
    const screen = await renderCard(createCrawlerStage());

    await expect.element(screen.getByText('00000000...')).toBeInTheDocument();
  });
});

interface EditableCardOptions {
  onEdit?: (stage: SchedulerStageRow) => void;
  latestTaskGroupVersion?: number;
}

function renderEditableCard(stage: SchedulerStageRow, { onEdit = vi.fn(), latestTaskGroupVersion }: EditableCardOptions = {}) {
  return render(
    <DndContext>
      <SortableContext items={[stage.id]}>
        <StageCard
          stage={stage}
          crawlerMap={new Map()}
          onDelete={vi.fn()}
          onEdit={onEdit}
          latestTaskGroupVersion={latestTaskGroupVersion}
        />
      </SortableContext>
    </DndContext>,
  );
}

describe('StageCard editing', () => {
  test('the edit button hands over the stage', async () => {
    const onEdit = vi.fn();
    const stage = createCrawlerStage();
    const screen = await renderEditableCard(stage, { onEdit });

    await screen.getByTitle('Edit stage').click();

    expect(onEdit).toHaveBeenCalledWith(stage);
  });

  test('shows that a newer version of the task group is registered', async () => {
    const screen = await renderEditableCard(createTaskGroupStage(), { latestTaskGroupVersion: 3 });

    await expect.element(screen.getByText('v3 available')).toBeInTheDocument();
  });

  test('shows no newer version while the stage runs the latest one', async () => {
    const screen = await renderEditableCard(createTaskGroupStage(), { latestTaskGroupVersion: 1 });

    await expect.element(screen.getByText('Task group newscast v1')).toBeInTheDocument();
    await expect.element(screen.getByText('available', { exact: false })).not.toBeInTheDocument();
  });

  test('shows no newer version on a crawler stage', async () => {
    const screen = await renderEditableCard(createCrawlerStage(), { latestTaskGroupVersion: 3 });

    await expect.element(screen.getByText('00000000...')).toBeInTheDocument();
    await expect.element(screen.getByText('available', { exact: false })).not.toBeInTheDocument();
  });
});
