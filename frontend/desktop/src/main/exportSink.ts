/**
 * Export sink (tasks 4.2–4.4): the renderer encodes (WebCodecs + mediabunny) and streams muxed bytes here.
 * Writes go to `<file>.part` and are renamed on success, so a cancelled export never leaves a broken file.
 * GIF: the renderer produces an intermediate MP4; ffmpeg runs the two-pass palette pipeline (§6.14).
 */
import { mkdirSync } from 'node:fs';
import { open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { logger } from './log';
import { isAllowed, runFfmpeg } from './projects';
import { settings } from './settings';

interface Job {
  fh: FileHandle;
  path: string;
  part: string;
  format: 'mp4' | 'gif';
  gifFps: number;
  gifWidth: number;
  bytes: number;
}
const jobs = new Map<number, Job>();
let nextId = 1;
const log = logger.child('export');

/**
 * Exports may only be written into the configured export folder, a folder the user picked in the export
 * dialog, or an open project (share renders go to its cache) — never to an arbitrary renderer-supplied path.
 */
function assertExportPath(path: string, format: 'mp4' | 'gif'): void {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== `.${format}`) throw new Error('Invalid export file name');
  const root = resolve(settings.get().general.exportDir).toLowerCase();
  const p = resolve(path).toLowerCase();
  if (!(p.startsWith(root + sep) || isAllowed(path))) throw new Error('Exports can only be saved to your export folder or a folder you choose');
}

export async function beginExport(opts: { path: string; format: 'mp4' | 'gif'; gifFps?: number; gifWidth?: number }): Promise<number> {
  assertExportPath(opts.path, opts.format);
  mkdirSync(dirname(opts.path), { recursive: true });
  const part = opts.format === 'gif' ? `${opts.path}.src.mp4.part` : `${opts.path}.part`;
  const fh = await open(part, 'w');
  const id = nextId++;
  jobs.set(id, { fh, path: opts.path, part, format: opts.format, gifFps: opts.gifFps ?? 15, gifWidth: opts.gifWidth ?? 720, bytes: 0 });
  log.info('export.begin', { id, path: opts.path, format: opts.format });
  return id;
}

export async function writeExport(id: number, position: number, data: ArrayBuffer | Uint8Array): Promise<void> {
  const j = jobs.get(id);
  if (!j) throw new Error('unknown export job');
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  await j.fh.write(buf, 0, buf.byteLength, position);
  j.bytes = Math.max(j.bytes, position + buf.byteLength);
}

export async function finishExport(id: number): Promise<{ path: string; bytes: number }> {
  const j = jobs.get(id);
  if (!j) throw new Error('unknown export job');
  jobs.delete(id);
  await j.fh.close();
  if (j.format === 'gif') {
    const src = j.part;
    const vf = `fps=${j.gifFps},scale=${j.gifWidth}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;
    try {
      await runFfmpeg(['-i', src, '-vf', vf, '-loop', '0', `${j.path}.part.gif`]);
      await rename(`${j.path}.part.gif`, j.path);
    } finally {
      await rm(src, { force: true });
    }
  } else {
    await rename(j.part, j.path);
  }
  const bytes = j.format === 'gif' ? (await stat(j.path)).size : j.bytes; // the GIF, not its intermediate MP4
  log.info('export.done', { id, path: j.path, bytes });
  return { path: j.path, bytes };
}

export async function abortExport(id: number): Promise<void> {
  const j = jobs.get(id);
  if (!j) return;
  jobs.delete(id);
  await j.fh.close().catch(() => undefined);
  await rm(j.part, { force: true }); // only our own partial output
  log.info('export.aborted', { id });
}