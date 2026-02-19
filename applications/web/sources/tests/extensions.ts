import { test as testBase } from 'vitest';
import { worker } from './mocks/browser.ts';

export const test = testBase.extend({
  worker: [
    async (_context: Record<string, never>, use: (value: typeof worker) => Promise<void>) => {
      await worker.start({ quiet: true });
      await use(worker);
      worker.resetHandlers();
      worker.stop();
    },
    { auto: true },
  ],
});

export { expect } from 'vitest';
