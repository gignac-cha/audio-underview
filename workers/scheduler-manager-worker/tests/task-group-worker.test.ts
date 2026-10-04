import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveTaskGroupWorker, taskGroupFinishedEventType } from '../sources/task-group-worker.ts';
import { manualRunInstanceID, runInstanceID } from '../sources/schedule.ts';

const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const STAGE_RUN_ID = '00000000-0000-0000-0000-000000000050';

// The ID and event type rules of Workflows
const WORKFLOW_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

describe('resolveTaskGroupWorker', () => {
  it('returns the binding the environment has under the name', () => {
    const worker = { startTaskGroupRun: async () => {} };
    expect(resolveTaskGroupWorker({ NEWSCAST: worker }, 'NEWSCAST')).toBe(worker);
  });

  it('returns a real service binding', () => {
    expect(resolveTaskGroupWorker(env, 'CRAWLER_MANAGER')).toBe(env.CRAWLER_MANAGER);
  });

  it.each([
    ['the name is missing', {}],
    ['the value is a string, like a variable', { NEWSCAST: 'https://newscast.example.com' }],
    ['the value is null', { NEWSCAST: null }],
    ['the name is only inherited', Object.create({ NEWSCAST: { startTaskGroupRun: async () => {} } })],
  ])('returns undefined when %s', (_, environment) => {
    expect(resolveTaskGroupWorker(environment, 'NEWSCAST')).toBeUndefined();
  });
});

describe('taskGroupFinishedEventType', () => {
  it('names the event after the stage run, within the Workflows rules', () => {
    const type = taskGroupFinishedEventType(STAGE_RUN_ID);
    expect(type).toBe(`task-group-finished-${STAGE_RUN_ID}`);
    expect(type).toHaveLength(56);
    expect(type).toMatch(WORKFLOW_NAME_PATTERN);
  });
});

describe('run instance IDs', () => {
  it('names the instance of a manual run after the run', () => {
    expect(manualRunInstanceID(RUN_ID)).toBe(`manual-${RUN_ID}`);
    expect(manualRunInstanceID(RUN_ID)).toMatch(WORKFLOW_NAME_PATTERN);
  });

  it('gives a scheduled run the instance ID of its occurrence', () => {
    expect(runInstanceID({
      id: RUN_ID,
      scheduler_id: SCHEDULER_ID,
      triggered_by: 'schedule',
      scheduled_for: '2026-10-05T22:00:00.000Z',
    })).toBe(`${SCHEDULER_ID}-29853960`);
  });

  it('gives a manual run the manual instance ID', () => {
    expect(runInstanceID({
      id: RUN_ID,
      scheduler_id: SCHEDULER_ID,
      triggered_by: 'manual',
      scheduled_for: null,
    })).toBe(`manual-${RUN_ID}`);
  });
});
