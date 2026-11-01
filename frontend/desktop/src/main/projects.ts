/**
 * Project bundles (task 0.7, 4.6–4.8): `<name>.recproj/` folders with project.json, meta.json, media/, events/, cache/.
 * Writes are atomic (tmp + rename). Library = scan of the save dir (no separate DB to drift).
 */
import { app, dialog, protocol, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import {
  createProject,
  migrateProject,
  ProjectSchema,
  type Project,
  type SourceInfo,
} from '@rec/shared';
import type { OpenedProject, ProjectSummary } from '../shared/ipc';
import { logger } from './log';
import { parseFfmpegInfo, type MediaInfo } from './mediaInfo';
import { ffmpegPath } from './paths';
import { settings } from './settings';

export const BUNDLE_EXT = '.recproj';
const log = logger.child('projects');

export function atomicWrite(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Recording';
}

export function uniqueDir(parent: string, name: string, ext = BUNDLE_EXT): string {
  let dir = join(parent, `${safeName(name)}${ext}`);
  for (let i = 2; existsSync(dir); i++) dir = join(parent, `${safeName(name)} (${i})${ext}`);
  return dir;
}

export function newBundleDir(): { dir: string; name: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `Recording ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  const dir = uniqueDir(settings.get().general.saveDir, name);
  mkdirSync(join(dir, 'media'), { recursive: true });
  mkdirSync(join(dir, 'events'), { recursive: true });
  mkdirSync(join(dir, 'cache'), { recursive: true });
  return { dir, name };
}

export function readProject(dir: string): Project {
  return migrateProject(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')));
}

export function writeProject(dir: string, project: Project): void {
  const valid = ProjectSchema.parse(project);
  atomicWrite(join(dir, 'project.json'), JSON.stringify(valid, null, 1));
}

// ---------------------------------------------------------------- media protocol

/** Only files inside known bundle roots / app resources may be served. */
const allowedRoots = new Set<string>();
export function allowRoot(dir: string): void {
  allowedRoots.add(normalize(resolve(dir)).toLowerCase());
}
export function isAllowed(p: string): boolean {
  const n = normalize(resolve(p)).toLowerCase();
  for (const r of allowedRoots) if (n === r || n.startsWith(r + sep)) return true;
  return false;
}

export const mediaUrl = (absPath: string): string => `rec-media://local/${encodeURIComponent(absPath.replace(/\\/g, '/'))}`;

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.bin': 'application/octet-stream', '.srt': 'text/plain', '.webp': 'image/webp', '.gif': 'image/gif', '.ogg': 'audio/ogg',
};

export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'rec-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

/** Range-capable file server for <video>/<audio> seeking and fetch(). */
export function registerMediaProtocol(): void {
  protocol.handle('rec-media', async (req) => {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const file = process.platform === 'win32' ? p : `/${p.replace(/^\/+/, '')}`;
    if (!isAllowed(file) || !existsSync(file)) return new Response('not found', { status: 404 });
    const size = statSync(file).size;
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = req.headers.get('range');
    const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m?.[1] ? Number(m[1]) : 0;
      let end = m?.[2] ? Number(m[2]) : size - 1;
      if (!m?.[1] && m?.[2]) {
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return new Response(stream, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
    }
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  });
}

// ---------------------------------------------------------------- library

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* partially deleted bundle */
  }
  return total;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = settings.get().general.saveDir;
  mkdirSync(root, { recursive: true });
  allowRoot(root);
  const out: ProjectSummary[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.endsWith(BUNDLE_EXT)) continue;
    const dir = join(root, e.name);
    try {
      const p = readProject(dir);
      const thumb = join(dir, 'cache', 'thumb.jpg');
      out.push({
        id: dir,
        name: p.name,
        dir,
        createdAt: p.createdAt,
        lastOpenedAt: p.lastOpenedAt,
        durationSec: p.source.durationSec,
        thumbnail: existsSync(thumb) ? mediaUrl(thumb) : null,
        sizeBytes: dirSize(dir),
      });
    } catch (err) {
      // bundles without project.json are recordings in progress (or awaiting crash recovery) — not an error
      if (!existsSync(join(dir, 'recording.lock')) && existsSync(join(dir, 'project.json'))) log.warn('library.skip', { dir, message: (err as Error).message });
    }
  }
  return out.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export async function openProject(dir: string): Promise<OpenedProject> {
  allowRoot(dir);
  const project = readProject(dir);
  project.lastOpenedAt = new Date().toISOString();
  writeProject(dir, project);
  const ev = join(dir, 'events');
  const read = async (f: string) => (existsSync(join(ev, f)) ? readFile(join(ev, f)) : Buffer.alloc(0));
  const cursorBitmaps: OpenedProject['cursorBitmaps'] = [];
  const curDir = join(ev, 'cursors');
  if (existsSync(curDir)) {
    for (const f of await readdir(curDir)) {
      if (!f.endsWith('.png')) continue;
      const id = Number(basename(f, '.png'));
      let hotspot: [number, number] = [0, 0];
      try {
        hotspot = (JSON.parse(readFileSync(join(curDir, `${id}.json`), 'utf8')) as { hotspot: [number, number] }).hotspot;
      } catch {
        /* default hotspot */
      }
      cursorBitmaps.push({ id, url: mediaUrl(join(curDir, f)), hotspot });
    }
  }
  return {
    dir,
    project,
    telemetryRaw: {
      cursorB64: (await read('cursor.bin')).toString('base64'),
      clicks: (await read('clicks.jsonl')).toString('utf8'),
      keys: (await read('keys.jsonl')).toString('utf8'),
    },
    mediaBase: mediaUrl(dir),
    cursorBitmaps,
  };
}

export async function saveProjectAs(srcDir: string, project: Project): Promise<string | null> {
  const r = await dialog.showSaveDialog({ defaultPath: join(dirname(srcDir), `${project.name} copy${BUNDLE_EXT}`) });
  if (r.canceled || !r.filePath) return null;
  const dest = r.filePath.endsWith(BUNDLE_EXT) ? r.filePath : r.filePath + BUNDLE_EXT;
  await copyDir(srcDir, dest);
  const copy = { ...project, id: `${project.id}-copy-${Date.now().toString(36)}`, name: basename(dest, BUNDLE_EXT) };
  writeProject(dest, copy);
  allowRoot(dest);
  return dest;
}

async function copyDir(src: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    if (e.name === 'recording.lock') continue;
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

export function renameProject(dir: string, name: string): void {
  const p = readProject(dir);
  p.name = name;
  writeProject(dir, p);
}

/** PRJ-01 delete = move to OS trash (recoverable), never a hard delete. */
export async function trashProjects(dirs: string[]): Promise<number> {
  let n = 0;
  for (const d of dirs) {
    if (!d.endsWith(BUNDLE_EXT) || !existsSync(join(d, 'project.json'))) continue;
    try {
      await shell.trashItem(d);
      n++;
    } catch (e) {
      log.error('library.trash', e, { dir: d });
    }
  }
  return n;
}

// ---------------------------------------------------------------- ffmpeg helpers

export function runFfmpeg(args: string[], onProgress?: (sec: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-4000);
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
      if (m && onProgress) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
    signal?.addEventListener('abort', () => p.kill());
    p.on('error', rej);
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}: ${err.split('\n').slice(-4).join(' ')}`))));
  });
}

/** Stream/format info via ffprobe when it is present, otherwise parsed from `ffmpeg -i` (installers ship ffmpeg only). */
export async function ffprobeJson(file: string): Promise<MediaInfo> {
  const ff = ffmpegPath();
  const probe = ff.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'));
  if (probe !== 'ffmpeg' && existsSync(probe)) return runProbe(probe, file);
  if (probe === 'ffprobe') {
    try { return await runProbe('ffprobe', file); } catch { /* not on PATH */ }
  }
  return new Promise((res, rej) => {
    // without an output ffmpeg exits 1 after printing the input description — that's expected here
    const p = spawn(ff, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-200_000)));
    p.on('error', rej);
    p.on('exit', () => {
      const info = parseFfmpegInfo(err);
      if (!info.streams.length) return rej(new Error(`Could not read media info: ${err.split('\n').slice(-2).join(' ').trim()}`));
      res(info);
    });
  });
}

function runProbe(bin: string, file: string): Promise<MediaInfo> {
  return new Promise((res, rej) => {
    const p = spawn(bin, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.on('error', rej);
    p.on('exit', (code) => {
      if (code !== 0) return rej(new Error(`ffprobe failed (${code})`));
      try {
        res(JSON.parse(out) as MediaInfo);
      } catch (e) {
        rej(e as Error);
      }
    });
  });
}

export async function makeThumbnail(dir: string, video: string, atSec = 1): Promise<void> {
  try {
    await runFfmpeg(['-ss', String(atSec), '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', join(dir, 'cache', 'thumb.jpg')]);
  } catch (e) {
    log.warn('thumbnail.failed', { message: (e as Error).message });
  }
}

/** EDT-09 / PRJ-03 / task 4.8: import any common video → H.264 proxy when needed → new project (no telemetry). */
export async function importVideo(): Promise<string | null> {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] }] });
  const file = r.filePaths[0];
  if (r.canceled || !file) return null;
  const info = await ffprobeJson(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('No video stream found');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const name = basename(file, extname(file));
  const dir = uniqueDir(settings.get().general.saveDir, name);
  mkdirSync(join(dir, 'media'), { recursive: true });
  mkdirSync(join(dir, 'events'), { recursive: true });
  mkdirSync(join(dir, 'cache'), { recursive: true });
  const screen = join(dir, 'media', 'screen_000.mp4');
  const isH264Mp4 = v.codec_name === 'h264' && /\.(mp4|m4v|mov)$/i.test(file);
  if (isH264Mp4) await runFfmpeg(['-i', file, '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', screen]);
  else await runFfmpeg(['-i', file, '-map', '0:v:0', ...(await (await import('./h264')).h264Args(18)), screen]);
  const tracks: SourceInfo['tracks'] = {};
  if (a) {
    await runFfmpeg(['-i', file, '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', join(dir, 'media', 'system_000.wav')]);
    tracks.system = 'media/system_000.wav';
  }
  const dur = Number(info.format.duration ?? v.duration ?? 0);
  const [num, den] = String(v.avg_frame_rate ?? '30/1').split('/').map(Number);
  const fps = den ? Math.round((num ?? 30) / den) : 30;
  const project = createProject(name, {
    kind: 'import',
    width: Number(v.width),
    height: Number(v.height),
    fps: fps > 0 && fps <= 240 ? fps : 30,
    scaleFactor: 1,
    segments: [{ file: 'media/screen_000.mp4', startNs: 0, durationNs: Math.round(dur * 1e9) }],
    tracks,
    hasTelemetry: false,
    durationSec: dur,
  });
  // REC-15 applies to imports too; a broken preset must never block the import
  const { applyDefaultPreset } = await import('./presets');
  let final = project;
  try { final = applyDefaultPreset(project, dir); } catch (e) { log.warn('import.preset', { message: (e as Error).message }); }
  writeProject(dir, final);
  atomicWrite(join(dir, 'meta.json'), JSON.stringify({ importedFrom: file, app: app.getVersion(), os: process.platform }, null, 1));
  await makeThumbnail(dir, screen, Math.min(1, dur / 2));
  allowRoot(dir);
  return dir;
}

/** PRJ-02: copy raw camera / mic / system / screen files out of the bundle. */
export async function extractSources(dir: string): Promise<string | null> {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Extract source files to…' });
  const target = r.filePaths[0];
  if (r.canceled || !target) return null;
  const p = readProject(dir);
  const outDir = uniqueDir(target, `${p.name} sources`, '');
  mkdirSync(outDir, { recursive: true });
  for (const f of await readdir(join(dir, 'media'))) await copyFile(join(dir, 'media', f), join(outDir, f));
  return outDir;
}

export async function writeCache(dir: string, name: string, data: Uint8Array): Promise<string> {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('invalid cache name');
  const f = join(dir, 'cache', name);
  atomicWrite(f, data);
  return mediaUrl(f);
}

/** Cache entries whose name starts with `prefix` (e.g. generated avatars), newest first. */
export function listCache(dir: string, prefix: string): Array<{ name: string; size: number; mtime: number }> {
  if (prefix.includes('..') || /[\\/]/.test(prefix)) throw new Error('invalid cache prefix');
  const d = join(dir, 'cache');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((n) => n.startsWith(prefix))
    .map((n) => { const st = statSync(join(d, n)); return { name: n, size: st.size, mtime: st.mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
}

export async function readCache(dir: string, name: string): Promise<Uint8Array | null> {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('invalid cache name');
  const f = join(dir, 'cache', name);
  return existsSync(f) ? readFile(f) : null;
}

/** Copy a user-picked asset (music, watermark, background, srt) into the bundle so projects are portable. */
export async function importAsset(dir: string, kind: string): Promise<{ file: string; url: string; name: string; text?: string } | null> {
  const filters: Record<string, Electron.FileFilter[]> = {
    music: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg'] }],
    watermark: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'svg'] }],
    background: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    'camera-bg': [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    srt: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }],
    facecam: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v'] }],
    'background-video': [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'm4v'] }],
  };
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: filters[kind] ?? [] });
  const src = r.filePaths[0];
  if (r.canceled || !src) return null;
  if (kind === 'srt') return { file: src, url: '', name: basename(src), text: await readFile(src, 'utf8') };
  const st = await stat(src);
  if (st.size > (kind === 'facecam' ? 8 * 1024 : 500) * 1024 * 1024) throw new Error(`File too large (max ${kind === 'facecam' ? '8 GB' : '500 MB'})`);
  const rel = `assets/${kind}-${Date.now().toString(36)}${extname(src).toLowerCase()}`;
  mkdirSync(join(dir, 'assets'), { recursive: true });
  await copyFile(src, join(dir, rel));
  return { file: rel, url: mediaUrl(join(dir, rel)), name: basename(src) };
}
