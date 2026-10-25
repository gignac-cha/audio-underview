/**
 * The calls the newscast templates make to the public API of scheduler-manager-worker, through the
 * `SCHEDULER_MANAGER` service binding.
 *
 * Every call carries the `Authorization` header of the caller unchanged, so the scheduler makes and
 * reads the schedulers of the user as if the user had called it, and it does the checks and the
 * permissions. This worker holds no credential for it.
 */

import { createWorkerLogger } from '@audio-underview/logger';
import type { Environment } from './environment.ts';

const logger = createWorkerLogger({
  defaultContext: { module: 'newscast-worker-scheduler-manager-client' },
});

// Only the path matters to a service binding
const SCHEDULER_MANAGER_ORIGIN = 'https://scheduler-manager.internal';

/** The longest part of a scheduler error that is passed on to the caller. */
const MAXIMUM_DESCRIPTION_LENGTH = 300;

/**
 * Why a call to the scheduler did not give the answer the template needs:
 * - unreachable: the service binding threw, so the scheduler did not answer
 * - refused: it answered with a status other than the expected one; `status` is that status
 * - unreadable: it answered the expected status with a body that has no usable ID
 */
export class SchedulerManagerError extends Error {
  readonly kind: 'unreachable' | 'refused' | 'unreadable';
  readonly status?: number;

  constructor(kind: SchedulerManagerError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'SchedulerManagerError';
    this.kind = kind;
    this.status = status;
  }
}

/** A stage of a scheduler, with the fields the templates read. */
export interface SchedulerStage {
  id: string;
  stage_type: string;
  task_group_id: string | null;
}

interface SchedulerManagerAnswer {
  status: number;
  body: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the scheduler said was wrong, from the `error_description` of its error body. */
function describeRefusal(answer: SchedulerManagerAnswer): string {
  const body = isPlainObject(answer.body) ? answer.body : {};
  const description = typeof body.error_description === 'string' ? body.error_description : undefined;
  const code = typeof body.error === 'string' ? body.error : undefined;
  const reason = (description ?? code ?? 'no reason given').slice(0, MAXIMUM_DESCRIPTION_LENGTH);
  return `The scheduler answered ${answer.status}: ${reason}`;
}

function idOf(body: unknown, what: string): string {
  const id = isPlainObject(body) ? body.id : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    throw new SchedulerManagerError('unreadable', `The scheduler answered without the ID of the ${what}.`);
  }
  return id;
}

/** The scheduler API on behalf of one caller. */
export interface SchedulerManagerClient {
  /** Whether the caller has the scheduler: false for 404 */
  schedulerExists(schedulerID: string): Promise<boolean>;
  listStages(schedulerID: string): Promise<SchedulerStage[]>;
  /** A scheduler with no schedule and turned off; answers its ID */
  createScheduler(name: string): Promise<string>;
  /** Answers the ID of the stage */
  createStage(schedulerID: string, stage: Record<string, unknown>): Promise<string>;
  /** For the cleanup of a template that failed half way: a scheduler that stays is logged, not thrown */
  deleteSchedulerQuietly(schedulerID: string): Promise<void>;
}

export function createSchedulerManagerClient(
  environment: Pick<Environment, 'SCHEDULER_MANAGER'>,
  authorization: string,
): SchedulerManagerClient {
  async function request(method: string, path: string, body?: unknown): Promise<SchedulerManagerAnswer> {
    const headers: Record<string, string> = { Authorization: authorization };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await environment.SCHEDULER_MANAGER.fetch(`${SCHEDULER_MANAGER_ORIGIN}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      logger.error('The scheduler could not be reached', error, {
        function: 'request',
        metadata: { method, path },
      });
      throw new SchedulerManagerError('unreachable', 'The scheduler could not be reached.');
    }
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  function expectStatus(answer: SchedulerManagerAnswer, status: number): void {
    if (answer.status !== status) {
      throw new SchedulerManagerError('refused', describeRefusal(answer), answer.status);
    }
  }

  return {
    async schedulerExists(schedulerID) {
      const answer = await request('GET', `/schedulers/${schedulerID}`);
      if (answer.status === 404) {
        return false;
      }
      expectStatus(answer, 200);
      return true;
    },

    async listStages(schedulerID) {
      const answer = await request('GET', `/schedulers/${schedulerID}/stages`);
      expectStatus(answer, 200);
      const data = isPlainObject(answer.body) ? answer.body.data : undefined;
      if (!Array.isArray(data)) {
        throw new SchedulerManagerError('unreadable', 'The scheduler answered the stages without a list.');
      }
      return data.filter(isPlainObject).map((stage) => ({
        id: idOf(stage, 'stage'),
        stage_type: typeof stage.stage_type === 'string' ? stage.stage_type : 'crawler',
        task_group_id: typeof stage.task_group_id === 'string' ? stage.task_group_id : null,
      }));
    },

    async createScheduler(name) {
      const answer = await request('POST', '/schedulers', { name, is_enabled: false });
      expectStatus(answer, 201);
      return idOf(answer.body, 'scheduler');
    },

    async createStage(schedulerID, stage) {
      const answer = await request('POST', `/schedulers/${schedulerID}/stages`, stage);
      expectStatus(answer, 201);
      return idOf(answer.body, 'stage');
    },

    async deleteSchedulerQuietly(schedulerID) {
      try {
        expectStatus(await request('DELETE', `/schedulers/${schedulerID}`), 200);
      } catch (error) {
        logger.warn('A scheduler of a failed template could not be deleted', {
          schedulerID,
          error: error instanceof Error ? error.message : String(error),
        }, { function: 'deleteSchedulerQuietly' });
      }
    },
  };
}
