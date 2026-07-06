import { createAuthenticationRouter } from './application.ts';
import type { WorkerEnvironment } from './environment.ts';

const router = createAuthenticationRouter();

export default {
  fetch(request: Request, environment: WorkerEnvironment, executionContext: ExecutionContext) {
    return router.fetch(request, environment, executionContext);
  },
};
