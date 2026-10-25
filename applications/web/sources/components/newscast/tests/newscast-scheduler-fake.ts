import { http, HttpResponse } from 'msw';
import { worker } from '../../../tests/mocks/browser.ts';
import type { NewscastSource } from '../../../schemas/newscast-schedulers.ts';

/**
 * A stateful fake of the two workers a New newscast start talks to: the newscast worker's template
 * route and the scheduler manager's stage, run, form answer and cancel routes. It records every
 * request, so a test can check the order and the bodies of the start sequence.
 */

export const NEWSCAST_WORKER_URL = 'http://localhost:6666';
export const SCHEDULER_MANAGER_URL = 'http://localhost:7777';

export const SCHEDULER_ID = '00000000-0000-4000-8000-000000000001';
export const FORM_STAGE_ID = '00000000-0000-4000-8000-000000000002';
export const NEWSCAST_STAGE_ID = '00000000-0000-4000-8000-000000000003';
export const RUN_ID = '00000000-0000-4000-8000-000000000004';
export const FORM_STAGE_RUN_ID = '00000000-0000-4000-8000-000000000005';
export const EARLIER_RUN_ID = '00000000-0000-4000-8000-000000000006';
export const EARLIER_STAGE_RUN_ID = '00000000-0000-4000-8000-000000000007';

export interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface SchedulerFakeOptions {
  source: NewscastSource;
  form: unknown;
  /** How many reads of the run answer it without its form stage run */
  readsBeforeForm?: number;
  /** 409 when a run of the scheduler is already in progress */
  executeStatus?: 202 | 409;
  /** The run in progress of a 409, and whether it waits on a form */
  earlierRunWaits?: boolean;
  /** Ends the run before its form opens */
  failBeforeForm?: string;
  /** 409 answers not_waiting, as for a form that expired or was closed elsewhere */
  answerStatus?: 200 | 400 | 409;
  cancelStatus?: 200 | 409;
  /** How many reads of the run after the answer still find it running; Infinity keeps it running */
  runningReadsAfterAnswer?: number;
  /** How the run ends after the answer */
  endAfterAnswer?: { status: 'completed' } | { status: 'failed'; error: string };
}

export function fakeNewscastScheduler(options: SchedulerFakeOptions) {
  const requests: RecordedRequest[] = [];
  let runReads = 0;
  let answered = false;
  let readsAfterAnswer = 0;

  const record = async (request: Request) => {
    const url = new URL(request.url);
    const text = await request.text();
    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      ...(text.length > 0 ? { body: JSON.parse(text) } : {}),
    });
  };

  const formStageRun = (status: string) => ({ id: FORM_STAGE_RUN_ID, stage_id: FORM_STAGE_ID, status, error: null });

  const notWaiting = () =>
    HttpResponse.json({ error: 'not_waiting', error_description: 'This stage is not waiting for an answer' }, { status: 409 });

  worker.use(
    http.post(`${NEWSCAST_WORKER_URL}/newscasts/schedulers`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({
        scheduler_id: SCHEDULER_ID,
        form_stage_id: FORM_STAGE_ID,
        newscast_stage_id: NEWSCAST_STAGE_ID,
        source: options.source,
      });
    }),
    http.put(`${SCHEDULER_MANAGER_URL}/schedulers/:schedulerID/stages/:stageID`, async ({ request, params }) => {
      await record(request);
      return HttpResponse.json({ id: params.stageID, scheduler_id: params.schedulerID });
    }),
    http.post(`${SCHEDULER_MANAGER_URL}/schedulers/:schedulerID/execute`, async ({ request }) => {
      await record(request);
      if (options.executeStatus === 409) {
        return HttpResponse.json({ error: 'conflict', error_description: 'A run is already in progress' }, { status: 409 });
      }
      return HttpResponse.json({ run_id: RUN_ID, status: 'pending', result: null, error: null }, { status: 202 });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/:schedulerID/runs`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ data: [{ id: EARLIER_RUN_ID, status: 'running' }], total: 1, offset: 0, limit: 5 });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/:schedulerID/runs/${EARLIER_RUN_ID}`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({
        id: EARLIER_RUN_ID,
        status: 'running',
        error: null,
        stage_runs: [
          {
            id: EARLIER_STAGE_RUN_ID,
            stage_id: options.earlierRunWaits === false ? NEWSCAST_STAGE_ID : FORM_STAGE_ID,
            status: options.earlierRunWaits === false ? 'running' : 'waiting',
            error: null,
          },
        ],
      });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/:schedulerID/runs/${RUN_ID}`, async ({ request }) => {
      await record(request);
      runReads += 1;
      if (options.failBeforeForm !== undefined) {
        return HttpResponse.json({ id: RUN_ID, status: 'failed', error: options.failBeforeForm, stage_runs: [] });
      }
      if (answered) {
        readsAfterAnswer += 1;
        const end = options.endAfterAnswer ?? { status: 'completed' as const };
        if (readsAfterAnswer > (options.runningReadsAfterAnswer ?? 1)) {
          return HttpResponse.json({
            id: RUN_ID,
            status: end.status,
            error: end.status === 'failed' ? end.error : null,
            stage_runs: [formStageRun('completed')],
          });
        }
        return HttpResponse.json({ id: RUN_ID, status: 'running', error: null, stage_runs: [formStageRun('completed')] });
      }
      const stageRuns = runReads > (options.readsBeforeForm ?? 0) ? [formStageRun('waiting')] : [];
      return HttpResponse.json({ id: RUN_ID, status: 'running', error: null, stage_runs: stageRuns });
    }),
    http.get(`${SCHEDULER_MANAGER_URL}/schedulers/:schedulerID/runs/:runID/stage-runs/:stageRunID`, async ({ request, params }) => {
      await record(request);
      return HttpResponse.json({ id: params.stageRunID, status: 'waiting', error: null, form: options.form });
    }),
    http.post(`${SCHEDULER_MANAGER_URL}/schedulers/:schedulerID/runs/:runID/stage-runs/:stageRunID/answer`, async ({ request }) => {
      await record(request);
      if (options.answerStatus === 400) {
        return HttpResponse.json(
          { error: 'invalid_answer', error_description: "Field 'url' must be an http or https URL" },
          { status: 400 },
        );
      }
      if (options.answerStatus === 409) {
        return notWaiting();
      }
      answered = true;
      return HttpResponse.json({ status: 'completed' });
    }),
    http.post(`${SCHEDULER_MANAGER_URL}/schedulers/:schedulerID/runs/:runID/stage-runs/:stageRunID/cancel`, async ({ request }) => {
      await record(request);
      if (options.cancelStatus === 409) {
        return notWaiting();
      }
      return HttpResponse.json({ status: 'failed' });
    }),
    http.get(`${NEWSCAST_WORKER_URL}/newscasts`, () => HttpResponse.json({ data: [] })),
  );

  return { requests };
}

/** The GeekNews form as the scheduler resolves it: integer choices, labels as text. */
export function geekNewsForm(count: number) {
  return {
    schema: { type: 'object', properties: { articles: { type: 'array' } }, required: ['articles'] },
    fields: [
      {
        name: 'articles',
        widget: 'checkboxes',
        required: true,
        minItems: 1,
        maxItems: 10,
        choices: Array.from({ length: count }, (_, index) => ({
          label: `Article ${index + 1}`,
          description: `https://example.com/${index + 1}`,
        })),
      },
    ],
    expires_at: '2026-10-26T10:30:00.000Z',
  };
}

export const URL_FORM = {
  schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] },
  fields: [{ name: 'url', widget: 'text', required: true, maxLength: 2048 }],
  expires_at: '2026-10-26T10:30:00.000Z',
};

export const TEXT_FORM = {
  schema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
  fields: [
    { name: 'title', widget: 'text', required: false, maxLength: 200 },
    { name: 'text', widget: 'textarea', required: true, maxLength: 24000 },
  ],
  expires_at: '2026-10-26T10:30:00.000Z',
};
