import { describe, it, expect, vi } from 'vitest';
import { createOAuthWorkerHandler } from '../sources/worker-handler.ts';
import type { BaseEnvironment } from '../sources/types.ts';
import { createMockLogger } from './mock-logger.ts';

const logger = createMockLogger();

function createEnvironment(overrides?: Partial<BaseEnvironment>): BaseEnvironment {
  return {
    FRONTEND_URL: 'https://example.com',
    ALLOWED_ORIGINS: 'https://example.com',
    AUDIO_UNDERVIEW_OAUTH_STATE: {} as KVNamespace,
    ...overrides,
  };
}

describe('createOAuthWorkerHandler', () => {
  it('returns healthy response for /health endpoint', async () => {
    const handler = createOAuthWorkerHandler({
      provider: 'test',
      logger,
      handlers: {
        handleAuthorize: async () => new Response('authorize'),
        handleCallback: async () => new Response('callback'),
      },
    });

    const request = new Request('https://worker.example.com/health', {
      headers: { Origin: 'https://example.com' },
    });

    const response = await handler.fetch(request, createEnvironment());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ status: 'healthy', provider: 'test' });
  });

  it('returns 404 for unknown endpoint', async () => {
    const handler = createOAuthWorkerHandler({
      provider: 'test',
      logger,
      handlers: {
        handleAuthorize: async () => new Response('authorize'),
        handleCallback: async () => new Response('callback'),
      },
    });

    const request = new Request('https://worker.example.com/unknown', {
      headers: { Origin: 'https://example.com' },
    });

    const response = await handler.fetch(request, createEnvironment());
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe('not_found');
  });

  it('routes /authorize to handleAuthorize', async () => {
    const handleAuthorize = vi.fn(async () => new Response('authorized', { status: 200 }));

    const handler = createOAuthWorkerHandler({
      provider: 'test',
      logger,
      handlers: {
        handleAuthorize,
        handleCallback: async () => new Response('callback'),
      },
    });

    const request = new Request('https://worker.example.com/authorize', {
      headers: { Origin: 'https://example.com' },
    });

    const response = await handler.fetch(request, createEnvironment());
    expect(response.status).toBe(200);
    expect(handleAuthorize).toHaveBeenCalledOnce();
  });

  it('routes /callback to handleCallback', async () => {
    const handleCallback = vi.fn(async () => new Response('callback result', { status: 200 }));

    const handler = createOAuthWorkerHandler({
      provider: 'test',
      logger,
      handlers: {
        handleAuthorize: async () => new Response('authorize'),
        handleCallback,
      },
    });

    const request = new Request('https://worker.example.com/callback', {
      headers: { Origin: 'https://example.com' },
    });

    const response = await handler.fetch(request, createEnvironment());
    expect(response.status).toBe(200);
    expect(handleCallback).toHaveBeenCalledOnce();
  });

  it('handles OPTIONS preflight requests', async () => {
    const handler = createOAuthWorkerHandler({
      provider: 'test',
      logger,
      handlers: {
        handleAuthorize: async () => new Response('authorize'),
        handleCallback: async () => new Response('callback'),
      },
    });

    const request = new Request('https://worker.example.com/authorize', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' },
    });

    const response = await handler.fetch(request, createEnvironment());
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  });

  it('catches errors from handlers and returns 500', async () => {
    const handler = createOAuthWorkerHandler({
      provider: 'test',
      logger,
      handlers: {
        handleAuthorize: async () => {
          throw new Error('Something went wrong');
        },
        handleCallback: async () => new Response('callback'),
      },
    });

    const request = new Request('https://worker.example.com/authorize', {
      headers: { Origin: 'https://example.com' },
    });

    const response = await handler.fetch(request, createEnvironment());
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe('server_error');
  });

  it('catches rejected promises from handlers', async () => {
    const handler = createOAuthWorkerHandler({
      provider: 'test',
      logger,
      handlers: {
        handleAuthorize: () => Promise.reject(new Error('Async failure')),
        handleCallback: async () => new Response('callback'),
      },
    });

    const request = new Request('https://worker.example.com/authorize', {
      headers: { Origin: 'https://example.com' },
    });

    const response = await handler.fetch(request, createEnvironment());
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe('server_error');
  });
});
