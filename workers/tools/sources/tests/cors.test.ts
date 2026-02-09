import { describe, it, expect } from 'vitest';
import { createCORSHeaders, handleOptions } from '../cors.ts';
import { createMockLogger } from './mock-logger.ts';

const logger = createMockLogger();

describe('createCORSHeaders', () => {
  it('returns empty headers for empty origin', () => {
    const headers = createCORSHeaders('', 'https://example.com', logger);
    expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('returns empty headers for non-allowed origin', () => {
    const headers = createCORSHeaders('https://evil.com', 'https://example.com', logger);
    expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('sets origin and credentials for allowed specific origin', () => {
    const headers = createCORSHeaders('https://example.com', 'https://example.com,https://other.com', logger);
    expect(headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
  });

  it('uses wildcard origin without credentials when wildcard is configured', () => {
    const headers = createCORSHeaders('https://any-origin.com', '*', logger);
    expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
  });

  it('handles multiple allowed origins correctly', () => {
    const allowed = 'https://a.com, https://b.com, https://c.com';
    const headers = createCORSHeaders('https://b.com', allowed, logger);
    expect(headers.get('Access-Control-Allow-Origin')).toBe('https://b.com');
    expect(headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('rejects origin not in the list', () => {
    const allowed = 'https://a.com, https://b.com';
    const headers = createCORSHeaders('https://c.com', allowed, logger);
    expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('handleOptions', () => {
  it('returns 204 with CORS headers for preflight request', () => {
    const request = new Request('https://worker.example.com/authorize', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' },
    });

    const environment = {
      FRONTEND_URL: 'https://example.com',
      ALLOWED_ORIGINS: 'https://example.com',
      AUDIO_UNDERVIEW_OAUTH_STATE: {} as KVNamespace,
    };

    const response = handleOptions(request, environment, logger);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  });

  it('returns 204 without CORS headers for missing origin', () => {
    const request = new Request('https://worker.example.com/authorize', {
      method: 'OPTIONS',
    });

    const environment = {
      FRONTEND_URL: 'https://example.com',
      ALLOWED_ORIGINS: 'https://example.com',
      AUDIO_UNDERVIEW_OAUTH_STATE: {} as KVNamespace,
    };

    const response = handleOptions(request, environment, logger);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
