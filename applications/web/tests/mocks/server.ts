import { setupServer } from 'msw/node';

/** 전역 MSW 서버 — 기본 핸들러 없음. 각 테스트가 server.use()로 주입한다. */
export const server = setupServer();

export const workerURLs = {
  authentication: 'http://authentication.worker.test',
  crawlerManager: 'http://crawler-manager.worker.test',
  schedulerManager: 'http://scheduler-manager.worker.test',
  codeRunner: 'http://code-runner.function.test',
} as const;
