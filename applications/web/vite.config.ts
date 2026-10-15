import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import basicSSL from '@vitejs/plugin-basic-ssl';
import path from 'path';

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), basicSSL()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './sources'),
    },
  },
  build: {
    outDir: 'outputs',
  },
});
