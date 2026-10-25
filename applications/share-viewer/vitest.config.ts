import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './sources'),
    },
  },
  define: {
    // The viewer reads exactly one build-time variable; tests pin it so the
    // fetch URLs asserted in component tests are deterministic.
    'import.meta.env.VITE_NEWSCAST_WORKER_URL': JSON.stringify('https://worker.test'),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./sources/tests/setup.ts'],
    include: ['sources/**/*.test.{ts,tsx}', 'functions/**/*.test.ts'],
  },
});
