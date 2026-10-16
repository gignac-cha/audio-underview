/**
 * Setup file of the worker tests, listed in `setupFiles` of each worker's `vitest.config.ts`.
 */
import { afterAll, afterEach, beforeAll } from 'vitest';
import { network } from './network.ts';

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

// Every test starts with empty storage, as it did when the test pool isolated storage per test.
// cloudflare:test is imported here rather than at the top: imported by a setup file, it loads the worker
// before the vi.mock() calls of the test file apply.
afterEach(async () => {
  const { reset } = await import('cloudflare:test');
  await reset();
});
