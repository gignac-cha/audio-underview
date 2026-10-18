import type { SchedulerStageRow, CrawlerRow } from '@audio-underview/supabase-connector';
import type { StageRunSummary } from '../../hooks/use-scheduler-runs.ts';

/**
 * What the stage runs: the task group and its version, or the crawler's name
 * (the start of its ID while the crawlers are loading).
 */
export function resolveStageDisplayName(stage: SchedulerStageRow, crawlerMap: Map<string, CrawlerRow>): string {
  if (stage.stage_type === 'task_group') {
    return `Task group ${stage.task_group_id} v${stage.task_group_version}`;
  }
  if (stage.crawler_id === null) {
    return 'Unknown stage';
  }
  return crawlerMap.get(stage.crawler_id)?.name ?? stage.crawler_id.slice(0, 8) + '...';
}

/**
 * What a stage run ran, by the stage it belongs to now. A task group stage run keeps the group
 * and version it was started with, so it names them even after its stage was edited or removed;
 * a crawler stage run whose stage is gone is named by its order.
 */
export function resolveStageRunDisplayName(
  stageRun: StageRunSummary,
  stages: SchedulerStageRow[],
  crawlerMap: Map<string, CrawlerRow>,
): string {
  if (stageRun.task_group_id !== null) {
    return `Task group ${stageRun.task_group_id} v${stageRun.task_group_version}`;
  }
  const stage = stages.find((candidate) => candidate.id === stageRun.stage_id);
  if (stage === undefined) {
    return `Stage ${stageRun.stage_order}`;
  }
  return resolveStageDisplayName(stage, crawlerMap);
}
