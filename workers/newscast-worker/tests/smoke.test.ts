import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('newscast worker', () => {
  it('answers 404 to a path it does not have', async () => {
    const response = await SELF.fetch('https://worker.example.com/missing');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', error_description: 'Endpoint not found' });
  });
});
