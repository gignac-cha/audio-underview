import { test as testBase } from 'vitest';
import { worker } from './mocks/browser.ts';

export const test = testBase.extend({
  worker: [
    // Vitest requires destructuring for the fixture parameters, so the empty pattern stays
    async ({}: Record<string, never>, use: (value: typeof worker) => Promise<void>) => {
      await worker.start({ quiet: true });
      await use(worker);
      worker.resetHandlers();
      await worker.stop();
    },
    { auto: true },
  ],
});

export { expect } from 'vitest';
