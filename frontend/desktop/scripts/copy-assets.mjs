// Copies runtime assets that must be served as static files (MediaPipe WASM) into the renderer public dir.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dst = join(root, 'src', 'renderer', 'public', 'mediapipe');
if (!existsSync(src)) {
  console.warn('[copy-assets] @mediapipe/tasks-vision not installed — background removal disabled');
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  cpSync(join(src, f), join(dst, f));
}
console.log('[copy-assets] mediapipe wasm →', dst);