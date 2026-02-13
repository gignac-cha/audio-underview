import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSSL from '@vitejs/plugin-basic-ssl';
import path from 'path';

export default defineConfig({
  plugins: [react(), basicSSL()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './sources'),
    },
  },
  build: {
    outDir: 'outputs',
  },
});
