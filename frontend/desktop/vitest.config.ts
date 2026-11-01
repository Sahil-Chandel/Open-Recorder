import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@rec/shared': resolve(__dirname, '../shared/src'), '@': resolve(__dirname, 'src/renderer/src') } },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});