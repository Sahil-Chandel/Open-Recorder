import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const shared = resolve(__dirname, '../shared/src');

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['@rec/shared', 'zod'] },
      // CJS main: the 'electron' built-in exposes named exports reliably to CommonJS
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
    resolve: { alias: { '@rec/shared': shared } },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ['@rec/shared', 'zod'] },
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
    resolve: { alias: { '@rec/shared': shared } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@rec/shared': shared, '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    worker: { format: 'es' },
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});