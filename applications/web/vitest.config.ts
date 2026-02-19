import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './sources'),
    },
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@radix-ui/react-avatar',
      '@radix-ui/react-toast',
      '@emotion/react',
      '@emotion/styled',
      'zod',
      'react-router',
      '@radix-ui/react-dialog',
      '@fortawesome/react-fontawesome',
      '@fortawesome/free-solid-svg-icons',
      '@tanstack/react-query',
    ],
  },
  define: {
    'import.meta.env.VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL': JSON.stringify('http://localhost:9999'),
    'import.meta.env.VITE_CRAWLER_MANAGER_WORKER_URL': JSON.stringify('http://localhost:8888'),
  },
  test: {
    globals: true,
    setupFiles: ['./sources/tests/setup.ts'],
    include: ['sources/**/*.test.{ts,tsx}'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
