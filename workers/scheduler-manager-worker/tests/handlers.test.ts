import { describe, expect, it } from 'vitest';
import { createSchedulerManagerRouter } from '../sources/application.ts';
import type { SchedulerManagerServices } from '../sources/services.ts';
import {
  CRAWLER_ID,
  createBearerToken,
  createFakeServices,
  environment,
  executionContext,
  mockScheduler,
  mockStage,
  SCHEDULER_ID,
  STAGE_ID,
} from './test-helpers.ts';

const request = async (
  services: SchedulerManagerServices,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> => {
  const router = createSchedulerManagerRouter(() => services);
  return router.fetch(
    new Request(`https://worker.example.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await createBearerToken()}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    environment,
    executionContext,
  );
};

describe('schedulers CRUD', () => {
  it('creates a scheduler with a valid cron expression (201)', async () => {
    const services = createFakeServices({
      schedulers: { create: (input) => Promise.resolve({ ...mockScheduler, ...(input as object) }) },
    });
    const response = await request(services, 'POST', '/schedulers', {
      name: 'Daily',
      cron_expression: '0 9 * * *',
    });
    expect(response.status).toBe(201);
  });

  it('rejects an invalid cron expression (400)', async () => {
    const response = await request(createFakeServices(), 'POST', '/schedulers', {
      name: 'Daily',
      cron_expression: 'often',
    });
    expect(response.status).toBe(400);
  });

  it('rejects an empty update (400)', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(mockScheduler) },
    });
    const response = await request(services, 'PUT', `/schedulers/${SCHEDULER_ID}`, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_description: 'At least one field must be provided for update',
    });
  });

  it('supports cron_expression: null (해제)', async () => {
    let received: unknown;
    const services = createFakeServices({
      schedulers: {
        update: (_id, _user, input) => {
          received = input;
          return Promise.resolve({ ...mockScheduler, cron_expression: null });
        },
      },
    });
    const response = await request(services, 'PUT', `/schedulers/${SCHEDULER_ID}`, {
      cron_expression: null,
    });
    expect(response.status).toBe(200);
    expect(received).toEqual({ cron_expression: null });
  });
});

describe('stages', () => {
  it('verifies scheduler ownership BEFORE parsing the body (404 우선)', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(undefined) },
    });
    // body가 무효여도 404가 먼저
    const response = await request(services, 'POST', `/schedulers/${SCHEDULER_ID}/stages`, {
      not: 'valid',
    });
    expect(response.status).toBe(404);
  });

  it('returns 403 when the crawler permission row is missing', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(mockScheduler) },
      crawlerPermissions: { get: () => Promise.resolve(undefined) },
    });
    const response = await request(services, 'POST', `/schedulers/${SCHEDULER_ID}/stages`, {
      crawler_id: CRAWLER_ID,
      stage_order: 0,
      input_schema: {},
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error_description: 'You do not have permission to use this crawler',
    });
  });

  it('maps stage_order unique violations to 409', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(mockScheduler) },
      crawlerPermissions: {
        get: () =>
          Promise.resolve({
            id: '00000000-0000-4000-8000-00000000000c',
            crawler_id: CRAWLER_ID,
            user_uuid: mockScheduler.user_uuid,
            level: 'owner' as const,
            created_at: '2026-01-01T00:00:00Z',
          }),
      },
      stages: {
        create: () =>
          Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' })),
      },
    });
    const response = await request(services, 'POST', `/schedulers/${SCHEDULER_ID}/stages`, {
      crawler_id: CRAWLER_ID,
      stage_order: 0,
      input_schema: {},
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error_description: 'A stage with this order already exists',
    });
  });

  it('routes reorder before :stageID (예약어 우선)', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(mockScheduler) },
      stages: { reorder: () => Promise.resolve([mockStage]) },
    });
    const response = await request(
      services,
      'PUT',
      `/schedulers/${SCHEDULER_ID}/stages/reorder`,
      { stage_ids: [STAGE_ID] },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [mockStage] });
  });

  it('maps reorder RPC validation errors to 400', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(mockScheduler) },
      stages: {
        reorder: () =>
          Promise.reject(
            new Error('stage_ids length (1) does not match the number of stages — mismatch'),
          ),
      },
    });
    const response = await request(
      services,
      'PUT',
      `/schedulers/${SCHEDULER_ID}/stages/reorder`,
      { stage_ids: [STAGE_ID] },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_description: 'Stage reorder validation failed',
    });
  });

  it('rejects duplicate stage_ids (400)', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(mockScheduler) },
    });
    const response = await request(
      services,
      'PUT',
      `/schedulers/${SCHEDULER_ID}/stages/reorder`,
      { stage_ids: [STAGE_ID, STAGE_ID] },
    );
    expect(response.status).toBe(400);
  });

  it('returns 405 with Allow for GET /stages/reorder', async () => {
    const response = await request(
      createFakeServices(),
      'GET',
      `/schedulers/${SCHEDULER_ID}/stages/reorder`,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('PUT, OPTIONS');
  });
});

describe('runs', () => {
  it('lists runs with the envelope after ownership check', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(mockScheduler) },
      runs: { list: () => Promise.resolve({ data: [], total: 0 }) },
    });
    const response = await request(services, 'GET', `/schedulers/${SCHEDULER_ID}/runs`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, offset: 0, limit: 20 });
  });
});
