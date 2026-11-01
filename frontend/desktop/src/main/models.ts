/**
 * On-demand model downloads (tasks 7.6, 10.1): models live in userData/models, fetched once over HTTPS,
 * verified with SHA-256 (pinned per model; trust-on-first-use only for models without a pin, recorded in
 * models.json and verified on every later load). Served to the renderer via rec-media://.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { net } from 'electron';
import { logger } from './log';
import { modelsDir } from './paths';
import { allowRoot, mediaUrl } from './projects';

export interface ModelDef { file: string; url: string; sha256: string | null; sizeHint: number }

/** Hugging Face commit the Whisper files are pinned to (a moving `main` could change bytes under the hash). */
const WHISPER_REV = '5359861c739e955e79d9a303bcbc70fb988958b1';
const whisper = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_REV}/${file}`;

// Versioned URLs + pinned SHA-256 (verified 2026-10-30). A mismatch is rejected, never trusted.
export const MODELS: Record<string, ModelDef> = {
  selfie: { file: 'selfie_segmenter.tflite', url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite', sha256: '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b', sizeHint: 249_537 },
  'whisper-nano': { file: 'ggml-tiny-q5_1.bin', url: whisper('ggml-tiny-q5_1.bin'), sha256: '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7', sizeHint: 32_152_673 },
  'whisper-basic': { file: 'ggml-base-q5_1.bin', url: whisper('ggml-base-q5_1.bin'), sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898', sizeHint: 59_707_625 },
  'whisper-pro': { file: 'ggml-small-q5_1.bin', url: whisper('ggml-small-q5_1.bin'), sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb', sizeHint: 190_085_487 },
};

const manifestPath = () => join(modelsDir(), 'models.json');
function manifest(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(manifestPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function ensureModel(name: string, onProgress?: (p: number) => void): Promise<{ path: string; url: string }> {
  const def = MODELS[name];
  if (!def) throw new Error(`unknown model ${name}`);
  const dir = modelsDir();
  mkdirSync(dir, { recursive: true });
  allowRoot(dir);
  const path = join(dir, def.file);
  const m = manifest();
  if (existsSync(path)) {
    const expected = def.sha256 ?? m[def.file];
    if (!expected || (await sha256(path)) === expected) return { path, url: mediaUrl(path) };
    logger.warn('models.checksum.mismatch', { name });
  }
  logger.info('models.download.start', { name });
  const res = await net.fetch(def.url);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? def.sizeHint);
  let got = 0;
  const tmp = `${path}.part`;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (c: Buffer) => {
    got += c.length;
    onProgress?.(Math.min(0.99, got / total));
  });
  await pipeline(body, createWriteStream(tmp));
  const hash = await sha256(tmp);
  if (def.sha256 && hash !== def.sha256) throw new Error('Model checksum mismatch — download corrupted');
  renameSync(tmp, path);
  writeFileSync(manifestPath(), JSON.stringify({ ...m, [def.file]: hash }, null, 2));
  logger.info('models.download.done', { name, bytes: statSync(path).size });
  onProgress?.(1);
  return { path, url: mediaUrl(path) };
}