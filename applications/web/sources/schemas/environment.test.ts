import { describe, test, expect } from 'vitest';
import { environmentSchema } from './environment.ts';

describe('environmentSchema', () => {
  test('validates with required VITE_GOOGLE_CLIENT_ID', () => {
    const result = environmentSchema.safeParse({
      VITE_GOOGLE_CLIENT_ID: 'test-client-id',
    });
    expect(result.success).toBe(true);
  });

  test('fails when VITE_GOOGLE_CLIENT_ID is missing', () => {
    const result = environmentSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('fails when VITE_GOOGLE_CLIENT_ID is empty string', () => {
    const result = environmentSchema.safeParse({
      VITE_GOOGLE_CLIENT_ID: '',
    });
    expect(result.success).toBe(false);
  });

  test('validates with optional VITE_GITHUB_OAUTH_WORKER_URL', () => {
    const result = environmentSchema.safeParse({
      VITE_GOOGLE_CLIENT_ID: 'test-client-id',
      VITE_GITHUB_OAUTH_WORKER_URL: 'https://worker.example.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_GITHUB_OAUTH_WORKER_URL).toBe('https://worker.example.com');
    }
  });

  test('fails when VITE_GITHUB_OAUTH_WORKER_URL is not a valid URL', () => {
    const result = environmentSchema.safeParse({
      VITE_GOOGLE_CLIENT_ID: 'test-client-id',
      VITE_GITHUB_OAUTH_WORKER_URL: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  test('allows VITE_GITHUB_OAUTH_WORKER_URL to be omitted', () => {
    const result = environmentSchema.safeParse({
      VITE_GOOGLE_CLIENT_ID: 'test-client-id',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_GITHUB_OAUTH_WORKER_URL).toBeUndefined();
    }
  });
});
