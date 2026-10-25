import { describe, test, expect } from 'vitest';
import { NEWSCAST_STAGES } from '@audio-underview/newscast-core';
import {
  STAGE_DESCRIPTIONS,
  STAGE_LABELS,
  STATUS_BADGE,
  WORKING_STAGES,
  stageStateFor,
} from './stage-metadata.ts';

describe('stage metadata', () => {
  test('labels every stage in English', () => {
    for (const stage of NEWSCAST_STAGES) {
      expect(STAGE_LABELS[stage]).toMatch(/^[A-Za-z ]+$/);
    }
    expect(STAGE_LABELS.script).toBe('Write script');
    expect(STAGE_LABELS.tts).toBe('Synthesize speech');
  });

  test('labels and describes the organize stage sitting before script', () => {
    expect(STAGE_LABELS.organize).toBe('Organize material');
    expect(STAGE_DESCRIPTIONS.organize).toBe('Structuring source material into speakable units');
    expect(NEWSCAST_STAGES.indexOf('organize')).toBe(NEWSCAST_STAGES.indexOf('crawl-articles') + 1);
    expect(NEWSCAST_STAGES.indexOf('organize')).toBe(NEWSCAST_STAGES.indexOf('script') - 1);
    expect(WORKING_STAGES).toContain('organize');
    expect(WORKING_STAGES).toHaveLength(6);
  });

  test('maps statuses to English badges', () => {
    expect(STATUS_BADGE.done).toEqual({ label: 'Done', tone: 'done' });
    expect(STATUS_BADGE.running).toEqual({ label: 'Running', tone: 'running' });
    expect(STATUS_BADGE.error).toEqual({ label: 'Failed', tone: 'error' });
  });

  test('computes stage states relative to the active stage', () => {
    expect(stageStateFor('crawl-list', 'script', false)).toBe('complete');
    expect(stageStateFor('script', 'script', false)).toBe('active');
    expect(stageStateFor('merge', 'script', false)).toBe('pending');
    expect(stageStateFor('merge', 'script', true)).toBe('complete');
  });
});
