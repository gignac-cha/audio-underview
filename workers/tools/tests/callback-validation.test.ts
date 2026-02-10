import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { validateCallbackParameters, verifyState } from '../sources/callback-validation.ts';
import { createMockLogger } from './mock-logger.ts';

const logger = createMockLogger();
const FRONTEND_URL = 'https://example.com';

describe('validateCallbackParameters', () => {
  it('returns error when provider returned an error', () => {
    const url = new URL('https://worker.example.com/callback?error=access_denied&error_description=User%20denied');
    const result = validateCallbackParameters(url, FRONTEND_URL, 'TestProvider', logger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(302);
      const location = result.response.headers.get('Location');
      expect(location).toContain('error=access_denied');
    }
  });

  it('returns error when code is missing', () => {
    const url = new URL('https://worker.example.com/callback?state=abc123');
    const result = validateCallbackParameters(url, FRONTEND_URL, 'TestProvider', logger);

    expect(result.success).toBe(false);
    if (!result.success) {
      const location = result.response.headers.get('Location');
      expect(location).toContain('error=invalid_request');
    }
  });

  it('returns error when state is missing', () => {
    const url = new URL('https://worker.example.com/callback?code=authcode123');
    const result = validateCallbackParameters(url, FRONTEND_URL, 'TestProvider', logger);

    expect(result.success).toBe(false);
    if (!result.success) {
      const location = result.response.headers.get('Location');
      expect(location).toContain('error=invalid_request');
    }
  });

  it('returns success with code and state when both present', () => {
    const url = new URL('https://worker.example.com/callback?code=authcode123&state=state456');
    const result = validateCallbackParameters(url, FRONTEND_URL, 'TestProvider', logger);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.parameters.code).toBe('authcode123');
      expect(result.parameters.state).toBe('state456');
    }
  });

  it('uses default error description when not provided', () => {
    const url = new URL('https://worker.example.com/callback?error=server_error');
    const result = validateCallbackParameters(url, FRONTEND_URL, 'TestProvider', logger);

    expect(result.success).toBe(false);
    if (!result.success) {
      const location = result.response.headers.get('Location');
      expect(location).toContain('error_description=Unknown');
    }
  });
});

describe('verifyState', () => {
  it('returns error when state is not found in KV', async () => {
    const kvNamespace = env.AUDIO_UNDERVIEW_OAUTH_STATE;
    const result = await verifyState('nonexistent-state', kvNamespace, FRONTEND_URL, logger);

    expect(result.success).toBe(false);
    if (!result.success) {
      const location = result.response.headers.get('Location');
      expect(location).toContain('error=invalid_state');
    }
  });

  it('returns stored value and deletes state from KV on success', async () => {
    const kvNamespace = env.AUDIO_UNDERVIEW_OAUTH_STATE;
    const stateKey = 'valid-state-key';
    const redirectURI = 'https://app.example.com/callback';

    await kvNamespace.put(stateKey, redirectURI);

    const result = await verifyState(stateKey, kvNamespace, FRONTEND_URL, logger);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.storedValue).toBe(redirectURI);
    }

    // Verify state was deleted from KV
    const remaining = await kvNamespace.get(stateKey);
    expect(remaining).toBeNull();
  });
});
