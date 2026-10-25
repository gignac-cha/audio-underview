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

  test('validates the newscast worker and share viewer URLs', () => {
    const result = environmentSchema.safeParse({
      VITE_GOOGLE_CLIENT_ID: 'test-client-id',
      VITE_NEWSCAST_WORKER_URL: 'http://localhost:8792',
      VITE_SHARE_VIEWER_URL: 'https://audio-underview-share.pages.dev',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_NEWSCAST_WORKER_URL).toBe('http://localhost:8792');
      expect(result.data.VITE_SHARE_VIEWER_URL).toBe('https://audio-underview-share.pages.dev');
    }
  });

  test.each(['VITE_NEWSCAST_WORKER_URL', 'VITE_SHARE_VIEWER_URL'])('fails when %s is not a valid URL', (name) => {
    const result = environmentSchema.safeParse({
      VITE_GOOGLE_CLIENT_ID: 'test-client-id',
      [name]: 'not-a-url',
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
