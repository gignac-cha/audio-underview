/**
 * What the scheduler asks of the worker implementing a task group. The scheduler never
 * imports a group's code: it reaches the group's worker through the service binding named
 * by the group's registration, and waits for the group to report its end (task-group-reports.ts).
 */

export interface TaskGroupStartRequest {
  /** Identifies this stage run in every report. Starting twice with the same value must not run the group twice. */
  stageRunID: string;
  taskGroupID: string;
  taskGroupVersion: number;
  /** Output of the previous stage, already checked against the input schema */
  input: unknown;
  /** Settings saved on the stage, valid for the settings schema */
  settings: Record<string, unknown>;
  /** Owner of the scheduler */
  userUUID: string;
}

/**
 * The RPC method the group's worker exposes on the entrypoint its binding points at.
 * It only starts the work and returns; throwing fails the stage.
 */
export interface TaskGroupWorker {
  startTaskGroupRun(request: TaskGroupStartRequest): Promise<void>;
}

/** Every task group stage that has not reported its end within this time fails */
export const TASK_GROUP_STAGE_TIMEOUT_MINUTES = 60;

/**
 * The service binding of the given name, when the environment has it.
 */
export function resolveTaskGroupWorker(environment: object, binding: string): TaskGroupWorker | undefined {
  if (!Object.hasOwn(environment, binding)) return undefined;
  const value: unknown = (environment as Record<string, unknown>)[binding];
  if (typeof value !== 'object' || value === null) return undefined;
  return value as TaskGroupWorker;
}

/**
 * Workflow event type that wakes the run waiting for one stage run.
 * Each stage run has its own type, so a repeated or late report never wakes another stage.
 */
export function taskGroupFinishedEventType(stageRunID: string): string {
  return `task-group-finished-${stageRunID}`;
}
