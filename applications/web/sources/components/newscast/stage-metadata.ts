/**
 * English UI metadata for pipeline stages and newscast statuses — the single
 * source of the Newscasts page's stage/status copy.
 */

import {
  NEWSCAST_STAGES,
  type JobRunStatus,
  type NewscastStage,
} from '@audio-underview/newscast-core';

export const STAGE_LABELS: Record<NewscastStage, string> = {
  'crawl-list': 'Fetch list',
  'crawl-articles': 'Collect articles',
  organize: 'Organize material',
  script: 'Write script',
  tts: 'Synthesize speech',
  merge: 'Merge audio',
  done: 'Done',
};

/** One-line description of what each stage is doing, shown while it is active. */
export const STAGE_DESCRIPTIONS: Record<NewscastStage, string> = {
  'crawl-list': 'Fetching the GeekNews article list',
  'crawl-articles': 'Collecting article content, summaries, and comments',
  organize: 'Structuring source material into speakable units',
  script: 'Writing the two-host script',
  tts: 'Synthesizing dialogue speech',
  merge: 'Merging, encoding, and aligning captions',
  done: 'Complete',
};

export type StatusTone = 'done' | 'running' | 'error';

/** English label + color tone for each newscast status badge. */
export const STATUS_BADGE: Record<JobRunStatus, { label: string; tone: StatusTone }> = {
  done: { label: 'Done', tone: 'done' },
  running: { label: 'Running', tone: 'running' },
  error: { label: 'Failed', tone: 'error' },
};

export type StageState = 'complete' | 'active' | 'pending';

/** Where `stage` sits relative to the newscast's current stage (all complete when done). */
export function stageStateFor(
  stage: NewscastStage,
  currentStage: NewscastStage,
  isDone: boolean,
): StageState {
  if (isDone) {
    return 'complete';
  }
  const stageIndex = NEWSCAST_STAGES.indexOf(stage);
  const currentIndex = NEWSCAST_STAGES.indexOf(currentStage);
  if (stageIndex < currentIndex) {
    return 'complete';
  }
  if (stageIndex === currentIndex) {
    return 'active';
  }
  return 'pending';
}

/** The six working stages (excludes the terminal `done` marker) for trackers. */
export const WORKING_STAGES: NewscastStage[] = NEWSCAST_STAGES.filter(
  (stage) => stage !== 'done',
);
