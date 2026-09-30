import { describe, expect, it } from 'vitest';
import type { GatewayOptions } from './environment.ts';
import {
  PROVIDER_NAMES,
  buildProviderHeaders,
  buildProviderURL,
  isProviderName,
  type ProviderName,
} from './providers.ts';

const KEY = 'test-provider-key-0123456789abcdef';
const GATEWAY_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/vault-account/vault-gateway';
const GATEWAY: GatewayOptions = { baseURL: GATEWAY_BASE_URL, token: null };

const DIRECT_ORIGINS: Record<ProviderName, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
  xai: 'https://api.x.ai',
};

const GATEWAY_SEGMENTS: Record<ProviderName, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google-ai-studio',
  xai: 'grok',
};

const REJECTED_PATHS = [
  'https://evil.example.com/v1/models',
  'http://169.254.169.254/latest/meta-data/',
  '//evil.example.com/v1/models',
  'file:///etc/passwd',
  'v1/../../evil',
  '..',
  'v1\\evil.example.com',
  '',
  'v1/%2e%2e/%2e%2e/evil',
  'v1/%2E%2E/%2E%2E/evil',
  'v1/.%2e/.%2e/evil',
  'v1/%2e./%2e./evil',
  '%2e%2e',
  'v1/.\t./evil',
  'v1/.\n./evil',
  'v1/.\r./evil',
  'v1/..%2fevil',
  'v1/%2e%2e%2fevil',
  'v1/..%5cevil',
];

const GATEWAY_ONLY_REJECTED_PATHS = [
  'v1/%2e%2e/%2e%2e/%2e%2e/%2e%2e/attacker-account/attacker-gateway/openai/v1/chat/completions',
  'v1/%2e%2e/evil',
];

describe('isProviderName', () => {
  it('accepts only the four providers, in the fixed order', () => {
    expect(PROVIDER_NAMES).toEqual(['anthropic', 'openai', 'google', 'xai']);
    for (const provider of PROVIDER_NAMES) {
      expect(isProviderName(provider)).toBe(true);
    }
    for (const value of ['mistral', 'Anthropic', 'grok', 'google-ai-studio', '', undefined, null, 1, {}]) {
      expect(isProviderName(value)).toBe(false);
    }
  });
});

describe('buildProviderHeaders', () => {
  it('sends the authentication headers from the table', () => {
    expect(buildProviderHeaders('anthropic', KEY, undefined, null)).toEqual({
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    });
    expect(buildProviderHeaders('openai', KEY, undefined, null)).toEqual({ authorization: `Bearer ${KEY}` });
    expect(buildProviderHeaders('google', KEY, undefined, null)).toEqual({ 'x-goog-api-key': KEY });
    expect(buildProviderHeaders('xai', KEY, undefined, null)).toEqual({ authorization: `Bearer ${KEY}` });
  });

  it('keeps only content-type, accept, anthropic-version and anthropic-beta string values from the caller', () => {
    const headers = buildProviderHeaders(
      'openai',
      KEY,
      {
        'Content-Type': 'application/json',
        ACCEPT: 'text/event-stream',
        'anthropic-beta': 'tools-2024-04-04',
        'Anthropic-Version': '2024-01-01',
        authorization: 'Bearer caller-key',
        'x-api-key': 'caller-key',
        cookie: 'session=1',
        'cf-aig-authorization': 'Bearer caller-gateway-token',
        'x-forwarded-for': '1.2.3.4',
        'content-length': 10,
      },
      null,
    );
    expect(headers).toEqual({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-beta': 'tools-2024-04-04',
      'anthropic-version': '2024-01-01',
      authorization: `Bearer ${KEY}`,
    });
  });

  it('lets the authentication headers override the caller headers', () => {
    const headers = buildProviderHeaders('anthropic', KEY, { 'anthropic-version': '1999-01-01' }, null);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBe(KEY);
  });

  it('drops non-string caller header values', () => {
    const headers = buildProviderHeaders('google', KEY, { accept: ['text/plain'], 'content-type': 42 }, null);
    expect(headers).toEqual({ 'x-goog-api-key': KEY });
  });

  it('works when the caller headers are missing or not an object', () => {
    for (const callerHeaders of [undefined, null, 'content-type: text/plain', 42, ['accept', 'text/plain']]) {
      expect(buildProviderHeaders('xai', KEY, callerHeaders, null)).toEqual({ authorization: `Bearer ${KEY}` });
    }
  });

  it('adds cf-aig-authorization only when the gateway has a token', () => {
    expect(buildProviderHeaders('openai', KEY, undefined, GATEWAY)).not.toHaveProperty('cf-aig-authorization');
    expect(buildProviderHeaders('openai', KEY, undefined, null)).not.toHaveProperty('cf-aig-authorization');
    const headers = buildProviderHeaders(
      'openai',
      KEY,
      { 'cf-aig-authorization': 'Bearer caller-gateway-token' },
      { baseURL: GATEWAY_BASE_URL, token: 'vault-gateway-token' },
    );
    expect(headers['cf-aig-authorization']).toBe('Bearer vault-gateway-token');
  });
});

describe('buildProviderURL (direct)', () => {
  it('pins every provider to its own origin', () => {
    for (const provider of PROVIDER_NAMES) {
      const result = buildProviderURL(provider, 'v1/models', null);
      expect(result).toEqual({ ok: true, url: `${DIRECT_ORIGINS[provider]}/v1/models` });
    }
  });

  it('keeps the query and accepts a leading /', () => {
    expect(buildProviderURL('google', '/v1beta/models?pageSize=1', null)).toEqual({
      ok: true,
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    });
  });

  it('keeps the origin for a path that only looks like a host', () => {
    const result = buildProviderURL('openai', 'v1/models/evil.example.com', null);
    expect(result).toEqual({ ok: true, url: 'https://api.openai.com/v1/models/evil.example.com' });
  });

  it('never puts the key into the URL', () => {
    for (const provider of PROVIDER_NAMES) {
      const result = buildProviderURL(provider, 'v1/models?pageSize=1', null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.url).not.toContain(KEY);
        expect([...new URL(result.url).searchParams.values()]).not.toContain(KEY);
      }
    }
  });

  it.each(REJECTED_PATHS)('rejects %j for every provider', (path) => {
    for (const provider of PROVIDER_NAMES) {
      const result = buildProviderURL(provider, path, null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['invalid_path', 'blocked_origin']).toContain(result.error);
      }
    }
  });
});

describe('buildProviderURL (gateway)', () => {
  it('uses the segment from the table and removes v1/ only for openai', () => {
    expect(buildProviderURL('anthropic', 'v1/messages', GATEWAY)).toEqual({
      ok: true,
      url: `${GATEWAY_BASE_URL}/anthropic/v1/messages`,
    });
    expect(buildProviderURL('openai', 'v1/chat/completions', GATEWAY)).toEqual({
      ok: true,
      url: `${GATEWAY_BASE_URL}/openai/chat/completions`,
    });
    expect(buildProviderURL('google', 'v1beta/models?pageSize=1', GATEWAY)).toEqual({
      ok: true,
      url: `${GATEWAY_BASE_URL}/google-ai-studio/v1beta/models?pageSize=1`,
    });
    expect(buildProviderURL('xai', 'v1/models', GATEWAY)).toEqual({
      ok: true,
      url: `${GATEWAY_BASE_URL}/grok/v1/models`,
    });
  });

  it('removes a single leading v1/ for openai', () => {
    expect(buildProviderURL('openai', '/v1/v1/models', GATEWAY)).toEqual({
      ok: true,
      url: `${GATEWAY_BASE_URL}/openai/v1/models`,
    });
  });

  it('accepts a trailing / on the base', () => {
    for (const provider of PROVIDER_NAMES) {
      const result = buildProviderURL(provider, 'v1/models', { baseURL: `${GATEWAY_BASE_URL}/`, token: null });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.url.startsWith(`${GATEWAY_BASE_URL}/${GATEWAY_SEGMENTS[provider]}/`)).toBe(true);
      }
    }
  });

  it('keeps the query and accepts a leading /', () => {
    expect(buildProviderURL('xai', '/v1/models?limit=5', GATEWAY)).toEqual({
      ok: true,
      url: `${GATEWAY_BASE_URL}/grok/v1/models?limit=5`,
    });
  });

  it('keeps the gateway origin for a path that only looks like a host', () => {
    expect(buildProviderURL('openai', 'v1/models/evil.example.com', GATEWAY)).toEqual({
      ok: true,
      url: `${GATEWAY_BASE_URL}/openai/models/evil.example.com`,
    });
  });

  it('does not decode %252e', () => {
    expect(buildProviderURL('openai', 'v1/%252e%252e/models', GATEWAY)).toEqual({
      ok: true,
      url: `${GATEWAY_BASE_URL}/openai/%252e%252e/models`,
    });
  });

  it.each([...REJECTED_PATHS, ...GATEWAY_ONLY_REJECTED_PATHS])('rejects %j for every provider', (path) => {
    for (const provider of PROVIDER_NAMES) {
      const result = buildProviderURL(provider, path, GATEWAY);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['invalid_path', 'blocked_origin']).toContain(result.error);
      }
    }
  });

  it('reports blocked_origin when the base does not parse', () => {
    expect(buildProviderURL('openai', 'v1/models', { baseURL: 'not a url', token: null })).toEqual({
      ok: false,
      error: 'blocked_origin',
    });
  });

  it('reports blocked_origin when the base is not https', () => {
    for (const baseURL of [
      'http://gateway.ai.cloudflare.com/v1/vault-account/vault-gateway',
      'ws://gateway.example.com/v1/a/b',
      'ftp://gateway.example.com/v1/a/b',
    ]) {
      for (const provider of PROVIDER_NAMES) {
        expect(buildProviderURL(provider, 'v1/models', { baseURL, token: null })).toEqual({
          ok: false,
          error: 'blocked_origin',
        });
      }
    }
  });
});
