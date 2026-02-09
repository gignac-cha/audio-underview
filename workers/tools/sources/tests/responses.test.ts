import { describe, it, expect } from 'vitest';
import { jsonResponse, errorResponse, redirectToFrontendWithError } from '../responses.ts';
import type { ResponseContext } from '../types.ts';
import { createMockLogger } from './mock-logger.ts';

const logger = createMockLogger();

function createContext(overrides?: Partial<ResponseContext>): ResponseContext {
  return {
    origin: 'https://example.com',
    allowedOrigins: 'https://example.com',
    logger,
    ...overrides,
  };
}

describe('jsonResponse', () => {
  it('returns JSON response with correct status and content type', async () => {
    const context = createContext();
    const response = jsonResponse({ message: 'hello' }, 200, context);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({ message: 'hello' });
  });

  it('includes CORS headers for allowed origin', () => {
    const context = createContext();
    const response = jsonResponse({ ok: true }, 200, context);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  });

  it('does not include CORS headers for empty origin', () => {
    const context = createContext({ origin: '' });
    const response = jsonResponse({ ok: true }, 200, context);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('returns correct status for error codes', async () => {
    const context = createContext();
    const response = jsonResponse({ error: 'not found' }, 404, context);
    expect(response.status).toBe(404);
  });
});

describe('errorResponse', () => {
  it('returns error response with correct structure', async () => {
    const context = createContext();
    const response = errorResponse('invalid_request', 'Missing parameter', 400, context);

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: 'invalid_request',
      errorDescription: 'Missing parameter',
    });
  });

  it('returns 500 for server errors', async () => {
    const context = createContext();
    const response = errorResponse('server_error', 'Something went wrong', 500, context);
    expect(response.status).toBe(500);
  });
});

describe('redirectToFrontendWithError', () => {
  it('redirects to frontend with error parameters', () => {
    const response = redirectToFrontendWithError(
      'https://app.example.com/callback',
      'access_denied',
      'User denied access',
      logger
    );

    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toBeTruthy();

    const redirectURL = new URL(location!);
    expect(redirectURL.origin).toBe('https://app.example.com');
    expect(redirectURL.searchParams.get('error')).toBe('access_denied');
    expect(redirectURL.searchParams.get('error_description')).toBe('User denied access');
  });

  it('returns fallback JSON response for invalid URL', async () => {
    const response = redirectToFrontendWithError(
      'not-a-valid-url',
      'some_error',
      'Some description',
      logger
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: 'some_error',
      error_description: 'Some description',
    });
  });

  it('handles empty frontend URL gracefully', async () => {
    const response = redirectToFrontendWithError('', 'error', 'desc', logger);
    expect(response.status).toBe(400);
  });
});
