import { createWorkerLogger } from '@audio-underview/logger';

export function createMockLogger() {
  return createWorkerLogger({
    enabled: false,
    defaultContext: { module: 'test' },
  });
}
