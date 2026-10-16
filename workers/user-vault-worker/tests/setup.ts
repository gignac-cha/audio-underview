import { afterEach } from 'vitest';

// Every test starts with empty storage, as it did when the test pool isolated storage per test.
// The worker tests share this reset through @audio-underview/worker-tools/tests/setup.ts; this worker does not
// depend on worker-tools, so it keeps its own copy. cloudflare:test is imported here rather than at the top:
// imported by a setup file, it loads the worker before the vi.mock() calls of the test file apply.
afterEach(async () => {
  const { reset } = await import('cloudflare:test');
  await reset();
});
