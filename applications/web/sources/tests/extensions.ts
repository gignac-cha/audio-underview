import { test as testBase } from 'vitest';
import { worker } from './mocks/browser.ts';

export const test = testBase.extend({
  worker: [
    // eslint-disable-next-line no-empty-pattern -- vitest v4 requires destructuring for fixture params
    async ({}: Record<string, never>, use: (value: typeof worker) => Promise<void>) => {
      await worker.start({ quiet: true });
      await use(worker);
      worker.resetHandlers();
      worker.stop();
    },
    { auto: true },
  ],
});

export { expect } from 'vitest';
