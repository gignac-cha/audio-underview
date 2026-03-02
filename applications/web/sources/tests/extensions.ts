import { test as testBase } from 'vitest';
import { worker } from './mocks/browser.ts';

export const test = testBase.extend({
  worker: [
    async ({}, use: (value: typeof worker) => Promise<void>) => {
      await worker.start({ quiet: true });
      await use(worker);
      worker.resetHandlers();
      worker.stop();
    },
    { auto: true },
  ],
});

export { expect } from 'vitest';
