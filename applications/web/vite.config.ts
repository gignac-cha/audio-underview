import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    // CLAUDE.md 무약어 규약: dist 대신 outputs
    outDir: 'outputs',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // 테스트는 외부 네트워크 없이 MSW로만 — worker URL은 테스트 전용 가짜 origin
    env: {
      VITE_AUTHENTICATION_WORKER_URL: 'http://authentication.worker.test',
      VITE_CRAWLER_MANAGER_WORKER_URL: 'http://crawler-manager.worker.test',
      VITE_SCHEDULER_MANAGER_WORKER_URL: 'http://scheduler-manager.worker.test',
      VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL: 'http://code-runner.function.test',
    },
    alias: {
      // Monaco는 jsdom에서 동작하지 않으므로 textarea 기반 mock으로 대체
      '@monaco-editor/react': fileURLToPath(
        new URL('./tests/mocks/monaco-editor-mock.tsx', import.meta.url),
      ),
    },
  },
});
