import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './sources'),
    },
  },
  build: {
    // Project convention: no abbreviations — `outputs`, never `dist`.
    outDir: 'outputs',
  },
});
