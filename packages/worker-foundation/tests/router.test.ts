import { describe, expect, it } from 'vitest';
import { signJWT } from '../sources/jwt.ts';
import { createWorkerRouter, type RouteDefinition } from '../sources/router.ts';
import { jsonResponse } from '../sources/responses.ts';

interface TestEnvironment {
  ALLOWED_ORIGINS: string;
  JWT_SECRET: string;
}

const environment: TestEnvironment = {
  ALLOWED_ORIGINS: 'https://app.example.com',
  JWT_SECRET: 'router-secret',
};

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

const SCHEDULER_ID = '00000000-0000-4000-8000-000000000001';
const USER_UUID = '00000000-0000-4000-8000-000000000009';

const routes: RouteDefinition<TestEnvironment>[] = [
  {
    method: 'PUT',
    pattern: '/schedulers/:schedulerID/stages/reorder',
    handler: (context) => jsonResponse({ matched: 'reorder' }, 200, context.responseContext),
  },
  {
    method: 'GET',
    pattern: '/schedulers/:schedulerID/stages/:stageID',
    handler: (context) => jsonResponse({ parameters: context.parameters }, 200, context.responseContext),
  },
  {
    method: 'GET',
    pattern: '/schedulers/:schedulerID',
    requiresAuthentication: true,
    handler: (context) => jsonResponse({ userUUID: context.userUUID }, 200, context.responseContext),
  },
  {
    method: 'POST',
    pattern: '/schedulers',
    handler: (context) => jsonResponse({ created: true }, 201, context.responseContext),
  },
  {
    method: 'GET',
    pattern: '/providers/:provider/authorize',
    parameterPatterns: { provider: /^[a-z]+$/ },
    handler: (context) => jsonResponse({ provider: context.parameters.provider }, 200, context.responseContext),
  },
];

const router = createWorkerRouter<TestEnvironment>({
  serviceName: 'test-service',
  help: [{ method: 'GET', path: '/', description: 'help' }],
  resolveAllowedOrigins: (env) => env.ALLOWED_ORIGINS,
  resolveAuthentication: (env) => ({ secret: env.JWT_SECRET }),
  routes,
});

const call = (method: string, path: string, headers: Record<string, string> = {}) =>
  router.fetch(new Request(`https://worker.example.com${path}`, { method, headers }), environment, executionContext);

const validToken = () =>
  signJWT(
    {
      sub: USER_UUID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    environment.JWT_SECRET,
  );

describe('createWorkerRouter', () => {
  it('serves help on / and /help', async () => {
    const response = await call('GET', '/help');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'test-service' });
  });

  it('matches literal segments before parameters (reorder 예약어)', async () => {
    const response = await call('PUT', `/schedulers/${SCHEDULER_ID}/stages/reorder`);
    expect(await response.json()).toEqual({ matched: 'reorder' });
  });

  it('captures UUID parameters', async () => {
    const stageID = '00000000-0000-4000-8000-000000000002';
    const response = await call('GET', `/schedulers/${SCHEDULER_ID}/stages/${stageID}`);
    expect(await response.json()).toEqual({
      parameters: { schedulerID: SCHEDULER_ID, stageID },
    });
  });

  it('returns 404 for invalid UUID parameters', async () => {
    const response = await call('GET', '/schedulers/not-a-uuid/stages/also-bad');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error_description: 'Invalid resource path' });
  });

  it('supports custom parameter patterns', async () => {
    const response = await call('GET', '/providers/google/authorize');
    expect(await response.json()).toEqual({ provider: 'google' });
  });

  it('returns 405 with an Allow header for known paths', async () => {
    const response = await call('DELETE', '/schedulers');
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('returns 404 for unknown endpoints', async () => {
    const response = await call('GET', '/unknown');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });

  it('handles OPTIONS preflight with 204 and CORS headers', async () => {
    const response = await call('OPTIONS', '/schedulers', { Origin: 'https://app.example.com' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('omits CORS headers for disallowed origins', async () => {
    const response = await call('OPTIONS', '/schedulers', { Origin: 'https://evil.example.com' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('handles HEAD with an empty 200', async () => {
    const response = await call('HEAD', '/anything');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.text()).toBe('');
  });

  it('rejects unauthenticated requests to protected routes', async () => {
    const response = await call('GET', `/schedulers/${SCHEDULER_ID}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('rejects tokens whose sub is not a UUID', async () => {
    const token = await signJWT(
      { sub: 'not-a-uuid', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 },
      environment.JWT_SECRET,
    );
    const response = await call('GET', `/schedulers/${SCHEDULER_ID}`, {
      Authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(401);
  });

  it('passes userUUID to authenticated handlers', async () => {
    const response = await call('GET', `/schedulers/${SCHEDULER_ID}`, {
      Authorization: `Bearer ${await validToken()}`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userUUID: USER_UUID });
  });

  it('returns 500 server_error when a handler throws', async () => {
    const throwingRouter = createWorkerRouter<TestEnvironment>({
      serviceName: 'test-service',
      help: [],
      resolveAllowedOrigins: (env) => env.ALLOWED_ORIGINS,
      routes: [
        {
          method: 'GET',
          pattern: '/explode',
          handler: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const response = await throwingRouter.fetch(
      new Request('https://worker.example.com/explode'),
      environment,
      executionContext,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'server_error',
      error_description: 'An unexpected error occurred',
    });
  });
});
