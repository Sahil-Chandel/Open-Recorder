/**
 * Recording orchestration (tasks 1.17–1.19, 2.3–2.4, 2.8, 2.12):
 * bundle → clean desktop → countdown → helper.startRecording → control bar → stop → finalize → editor.
 * Camera is recorded in the recorder renderer (MediaRecorder) and offset-aligned via a QPC↔wall ping.
 */
import { app, powerSaveBlocker, screen } from 'electron';
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  autoZooms,
  createProject,
  decodeCursorBin,
  detectTypingBursts,
  KeyEventSchema,
  normaliseTelemetry,
  parseJsonl,
  ClickEventSchema,
  StopResultSchema,
  type Project,
  type StopResult,
} from '@rec/shared';
import type { RecState, StartRecordingInput } from '../shared/ipc';
import { helper } from './helper';
import { logger } from './log';
import { allowRoot, atomicWrite, makeThumbnail, newBundleDir, readProject, runFfmpeg, writeProject } from './projects';
import { applyDefaultPreset } from './presets';
import { settings } from './settings';
import { broadcast, closeWindow, getWin, openEditor, openOverlay, openRecorder, openWindow } from './windows';

const log = logger.child('recording');

interface Active {
  dir: string;
  name: string;
  input: StartRecordingInput;
  qpcToWallMs: number; // wallMs = qpcNs/1e6 + qpcToWallMs
  t0Ns: number;
  cameraStartWall: number | null;
  cameraDone: Promise<void>;
  resolveCamera: () => void;
  powerBlock: number;
  desktopRestore: { iconsVisible: boolean; taskbarAutoHide: boolean } | null;
  startedWall: number;
  pausedAccum: number;
  pausedAt: number | null;
}

let active: Active | null = null;
let state: RecState = { state: 'idle', elapsedSec: 0, micMuted: false };
let tick: NodeJS.Timeout | null = null;
let countdownResolve: (() => void) | null = null;

/** In-process listeners for recording state (hotkey tiers, tray). */
export const recEvents = new EventEmitter<{ state: [RecState] }>();

function setState(patch: Partial<RecState>): void {
  state = { ...state, ...patch };
  broadcast('rec:state', state);
  recEvents.emit('state', state);
}
export const recState = (): RecState => state;

function elapsed(): number {
  if (!active) return 0;
  const now = active.pausedAt ?? Date.now();
  return Math.max(0, (now - active.startedWall - active.pausedAccum) / 1000);
}

async function clockMapping(): Promise<number> {
  // NTP-style: take the sample with the smallest RTT
  let best = { rtt: Infinity, offset: 0 };
  for (let i = 0; i < 5; i++) {
    const a = performance.timeOrigin + performance.now();
    const r = await helper.call<{ t: number }>('ping');
    const b = performance.timeOrigin + performance.now();
    if (b - a < best.rtt) best = { rtt: b - a, offset: (a + b) / 2 - r.t / 1e6 };
  }
  return best.offset;
}

const desktopRestoreFile = () => join(app.getPath('userData'), 'desktop-restore.json');

async function cleanDesktop(): Promise<Active['desktopRestore']> {
  const s = settings.get().record;
  if (!s.hideDesktopIcons && !s.hideTaskbar) return null;
  try {
    const prev = await helper.call<{ iconsVisible: boolean; taskbarAutoHide: boolean }>('setDesktopClean', {
      ...(s.hideDesktopIcons ? { iconsVisible: false } : {}),
      ...(s.hideTaskbar ? { taskbarAutoHide: true } : {}),
    });
    writeFileSync(desktopRestoreFile(), JSON.stringify(prev)); // survives a crash → restored on next launch
    return prev;
  } catch (e) {
    log.warn('desktop.clean.failed', { message: (e as Error).message });
    return null;
  }
}

export async function restoreDesktop(prev?: Active['desktopRestore']): Promise<void> {
  let p = prev ?? null;
  if (!p && existsSync(desktopRestoreFile())) {
    try {
      p = JSON.parse(readFileSync(desktopRestoreFile(), 'utf8')) as Active['desktopRestore'];
    } catch {
      p = null;
    }
  }
  if (!p) return;
  try {
    await helper.call('setDesktopClean', { iconsVisible: p.iconsVisible, taskbarAutoHide: p.taskbarAutoHide });
    unlinkSync(desktopRestoreFile());
  } catch (e) {
    log.warn('desktop.restore.failed', { message: (e as Error).message });
  }
}

function targetDisplayBounds(input: StartRecordingInput): Electron.Rectangle {
  const displays = screen.getAllDisplays();
  if (input.mode === 'area' && input.area) {
    const d = screen.getDisplayMatching({ x: input.area.x, y: input.area.y, width: input.area.width, height: input.area.height });
    return d.bounds;
  }
  return (displays.find((d) => String(d.id) === input.displayId) ?? screen.getPrimaryDisplay()).bounds;
}

async function runCountdown(input: StartRecordingInput): Promise<void> {
  const secs = settings.get().record.countdown;
  if (secs <= 0) return;
  setState({ state: 'countdown' });
  const b = targetDisplayBounds(input);
  const w = 360;
  openOverlay('countdown', { x: Math.round(b.x + b.width / 2 - w / 2), y: Math.round(b.y + b.height / 2 - w / 2), width: w, height: w }, 'countdown', { secs: String(secs) }, false);
  await new Promise<void>((res) => {
    countdownResolve = res;
    setTimeout(res, (secs + 3) * 1000);
  });
  countdownResolve = null;
  closeWindow('countdown');
}
export function countdownDone(): void {
  countdownResolve?.();
}

/** Back to idle with a message the recorder shows; REC stays usable (a lingering 'error' state used to disable it). */
function fail(message: string): void {
  setState({ state: 'idle', elapsedSec: 0, error: message });
  getWin('recorder')?.show();
}

export async function startRecording(input: StartRecordingInput): Promise<RecState> {
  try {
    return await beginRecording(input);
  } catch (e) {
    if (!active) fail((e as Error).message);
    throw e;
  }
}

async function beginRecording(input: StartRecordingInput): Promise<RecState> {
  if (active) throw new Error('Already recording');
  if (helper.state !== 'ready') throw new Error(`Capture helper is ${helper.state}. Check Settings → troubleshooting.`);
  const { dir, name } = newBundleDir();
  allowRoot(dir);
  const s = settings.get();
  settings.set({ devices: { lastMode: input.mode, ...(input.area ? { lastArea: input.area } : {}) } });
  let resolveCamera!: () => void;
  const cameraDone = new Promise<void>((r) => (resolveCamera = r));
  if (!input.camera.enabled) resolveCamera();
  // the camera is captured by the recorder page: tray/hotkey recordings need it loaded (hidden is fine)
  if (input.camera.enabled && !getWin('recorder')) openRecorder({ show: false });
  getWin('recorder')?.hide();
  const desktopRestore = await cleanDesktop();
  await runCountdown(input);
  const qpcToWallMs = await clockMapping();
  // helper area coords are physical px; Electron's are DIP → scale by the display factor
  let area: { x: number; y: number; width: number; height: number } | undefined;
  if (input.mode === 'area' && input.area) {
    const d = screen.getDisplayMatching({ x: input.area.x, y: input.area.y, width: input.area.width, height: input.area.height });
    const sf = d.scaleFactor;
    const phys = screen.dipToScreenRect(null, { x: input.area.x, y: input.area.y, width: input.area.width, height: input.area.height });
    area = process.platform === 'win32' ? phys : { x: input.area.x * sf, y: input.area.y * sf, width: input.area.width * sf, height: input.area.height * sf };
  }
  // the helper wants its own display id (HMONITOR); callers may pass Electron's — resolve areas by position
  let displayId = input.displayId;
  if (area) {
    const ds = await helper.call<Array<{ id: string; x: number; y: number; width: number; height: number }>>('listDisplays').catch(() => []);
    const cx = area.x + area.width / 2, cy = area.y + area.height / 2;
    displayId = ds.find((d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height)?.id ?? displayId;
  }
  const cfg = {
    bundleDir: dir,
    mode: input.mode,
    displayId,
    ...(input.windowId ? { windowId: input.windowId } : {}),
    ...(area ? { area } : {}),
    fps: s.record.fps,
    quality: s.record.quality,
    encoder: s.record.encoder,
    systemAudio: input.systemAudio,
    mic: input.mic,
    captureInput: true,
    excludePids: [process.pid],
    engine: s.general.recordingEngine,
  };
  try {
    await helper.call('startRecording', cfg, 30000);
  } catch (e) {
    await restoreDesktop(desktopRestore);
    throw e;
  }
  const lock = JSON.parse(readFileSync(join(dir, 'recording.lock'), 'utf8')) as { t0Ns: number };
  writeCaptureJournal(dir, { mode: input.mode, zoomMode: input.zoomMode ?? s.record.zoomMode, qpcToWallMs, t0Ns: lock.t0Ns, cameraStartWall: null });
  active = {
    dir, name, input, qpcToWallMs, t0Ns: lock.t0Ns, cameraStartWall: null, cameraDone, resolveCamera,
    powerBlock: powerSaveBlocker.start('prevent-display-sleep'), desktopRestore, startedWall: Date.now(), pausedAccum: 0, pausedAt: null,
  };
  const b = targetDisplayBounds(input);
  openOverlay('controlbar', { x: Math.round(b.x + b.width / 2 - 170), y: Math.round(b.y + b.height - 110), width: 340, height: 56 }, 'controlbar');
  const cb = getWin('controlbar');
  if (cb) cb.setMovable(true);
  getWin('teleprompter')?.webContents.send('teleprompter:control', 'start');
  setState({ state: 'recording', elapsedSec: 0, dir, micMuted: false, keysPaused: false, error: undefined });
  tick = setInterval(() => broadcast('rec:tick', elapsed()), 250);
  log.info('recording.started', { dir, mode: input.mode });
  return state;
}

export async function pauseRecording(): Promise<RecState> {
  if (!active || state.state !== 'recording') return state;
  await helper.call('pause');
  active.pausedAt = Date.now();
  getWin('teleprompter')?.webContents.send('teleprompter:control', 'pause');
  setState({ state: 'paused' });
  return state;
}

export async function resumeRecording(): Promise<RecState> {
  if (!active || state.state !== 'paused') return state;
  await helper.call('resume');
  if (active.pausedAt) active.pausedAccum += Date.now() - active.pausedAt;
  active.pausedAt = null;
  getWin('teleprompter')?.webContents.send('teleprompter:control', 'start');
  setState({ state: 'recording' });
  return state;
}

export async function toggleMicMute(): Promise<RecState> {
  const muted = !state.micMuted;
  if (active) await helper.call('setMicMuted', { muted }).catch((e: Error) => log.warn('mic.mute.failed', { message: e.message }));
  setState({ micMuted: muted });
  return state;
}

export async function toggleKeyCapture(): Promise<RecState> {
  const paused = !state.keysPaused;
  if (active) await helper.call('setKeysPaused', { paused }).catch((e: Error) => log.warn('keys.pause.failed', { message: e.message }));
  setState({ keysPaused: paused });
  return state;
}

export function cameraStarted(wallMs: number): void {
  if (!active) return;
  active.cameraStartWall = wallMs;
  writeCaptureJournal(active.dir, { mode: active.input.mode, zoomMode: active.input.zoomMode ?? settings.get().record.zoomMode, qpcToWallMs: active.qpcToWallMs, t0Ns: active.t0Ns, cameraStartWall: wallMs });
}

/**
 * capture.json: what crash recovery needs beyond the helper's segments.json — recording kind, zoom mode and
 * the clock mapping that places the renderer-recorded camera on the helper's timeline.
 */
interface CaptureJournal { mode: 'display' | 'window' | 'area'; zoomMode: '2d' | '3d'; qpcToWallMs: number; t0Ns: number; cameraStartWall: number | null }
function writeCaptureJournal(dir: string, j: CaptureJournal): void {
  try { atomicWrite(join(dir, 'capture.json'), JSON.stringify(j)); } catch (e) { log.warn('capture.journal', { message: (e as Error).message }); }
}
function readCaptureJournal(dir: string): CaptureJournal | null {
  try { return JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8')) as CaptureJournal; } catch { return null; }
}
const cameraOffsetFor = (j: { qpcToWallMs: number; t0Ns: number; cameraStartWall: number | null }, seg0StartNs: number): number | undefined =>
  j.cameraStartWall === null ? undefined : (j.cameraStartWall - ((j.t0Ns + seg0StartNs) / 1e6 + j.qpcToWallMs)) / 1000;
export function cameraChunk(data: ArrayBuffer | Uint8Array): void {
  if (!active) return;
  appendFileSync(join(active.dir, 'media', 'camera_000.webm'), data instanceof Uint8Array ? data : new Uint8Array(data));
}
export function cameraDone(): void {
  active?.resolveCamera();
}

async function concatFiles(dir: string, files: string[], out: string, kind: 'video' | 'audio'): Promise<void> {
  if (files.length === 0) return;
  const listFile = join(dir, 'cache', `concat-${kind}.txt`);
  writeFileSync(listFile, files.map((f) => `file '${join(dir, f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const codec = kind === 'video' ? ['-c', 'copy', '-movflags', '+faststart'] : ['-c:a', 'pcm_f32le'];
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, ...codec, join(dir, out)]);
}

/**
 * Audio tracks: a single cleanly-closed segment is moved into place (WAV is ~23 MB/min per track, so a copy
 * doubled the bundle size); several segments, or a crash-recovered bundle whose WAV headers may be stale,
 * go through ffmpeg. Re-running finalisation after a move is a no-op.
 */
async function joinAudio(dir: string, files: string[], out: string, repair: boolean): Promise<void> {
  const only = files.length === 1 ? join(dir, files[0]!) : null;
  if (only && !repair) {
    if (existsSync(only)) return renameSync(only, join(dir, out));
    if (existsSync(join(dir, out))) return;
  }
  await concatFiles(dir, files, out, 'audio');
}

/**
 * MediaRecorder WebM has no duration and no cues, which makes seeking slow and duration unknown in the
 * editor and exporter. A stream-copy remux adds both; the repaired file replaces the raw one in place.
 */
async function repairCameraWebm(dir: string): Promise<string | null> {
  const raw = join(dir, 'media', 'camera_000.webm');
  if (!existsSync(raw)) return null;
  const tmp = join(dir, 'media', 'camera_000.remux.webm');
  try {
    await runFfmpeg(['-i', raw, '-c', 'copy', tmp]);
    renameSync(tmp, raw);
  } catch (e) {
    log.warn('camera.remux', { message: (e as Error).message }); // keep the raw file — still playable
  }
  return 'media/camera_000.webm';
}

/** Turn a finished (or crash-recovered) bundle into a project. Pure function of files on disk. */
export async function finalizeBundle(dir: string, name: string, stop: StopResult, opts: { cameraOffsetSec?: number; zoomMode: '2d' | '3d'; autoZoom: boolean; repair?: boolean; kind?: 'display' | 'window' | 'area' }): Promise<Project> {
  const total = stop.segments.reduce((a, s) => a + s.durationNs, 0);
  await concatFiles(dir, stop.segments.map((s) => s.file), 'media/screen.mp4', 'video');
  const tracks: Project['source']['tracks'] = { screen: 'media/screen.mp4' };
  if (stop.audio.mic.length) {
    await joinAudio(dir, stop.audio.mic, 'media/mic.wav', opts.repair ?? false);
    tracks.mic = 'media/mic.wav';
  }
  if (stop.audio.system.length) {
    await joinAudio(dir, stop.audio.system, 'media/system.wav', opts.repair ?? false);
    tracks.system = 'media/system.wav';
  }
  const camera = await repairCameraWebm(dir);
  if (camera) tracks.camera = camera;
  const source = {
    kind: opts.kind ?? ('display' as const),
    width: stop.width,
    height: stop.height,
    fps: stop.fps,
    scaleFactor: stop.scaleFactor,
    segments: stop.segments,
    tracks,
    hasTelemetry: true,
    durationSec: total / 1e9,
    trackOffsets: (opts.cameraOffsetSec !== undefined ? { camera: opts.cameraOffsetSec } : {}) as Record<string, number>,
  };
  const project = createProject(name, source);
  if (opts.autoZoom) {
    const ev = join(dir, 'events');
    const read = (f: string) => (existsSync(join(ev, f)) ? readFileSync(join(ev, f)) : Buffer.alloc(0));
    const tel = normaliseTelemetry(
      {
        cursor: decodeCursorBin(new Uint8Array(read('cursor.bin'))),
        clicks: parseJsonl(read('clicks.jsonl').toString('utf8'), ClickEventSchema),
        keys: parseJsonl(read('keys.jsonl').toString('utf8'), KeyEventSchema),
      },
      stop.segments,
      stop.width,
      stop.height,
    );
    project.zooms = autoZooms(tel.clicks, detectTypingBursts(tel.keys, tel.clicks), { duration: source.durationSec, mode: opts.zoomMode });
  }
  const withPreset = applyDefaultPreset(project, dir);
  writeProject(dir, withPreset);
  atomicWrite(join(dir, 'meta.json'), JSON.stringify({ app: app.getVersion(), os: process.platform, arch: process.arch, helper: helper.info, stop }, null, 1));
  await makeThumbnail(dir, join(dir, 'media', 'screen.mp4'), Math.min(1, source.durationSec / 2));
  return withPreset;
}

async function teardownUi(): Promise<void> {
  if (tick) clearInterval(tick);
  tick = null;
  closeWindow('controlbar');
  getWin('teleprompter')?.webContents.send('teleprompter:control', 'stop');
}

export async function stopRecording(): Promise<RecState> {
  if (!active || (state.state !== 'recording' && state.state !== 'paused')) return state;
  const a = active;
  let stopError: string | undefined;
  setState({ state: 'stopping' });
  await teardownUi();
  try {
    const stop = StopResultSchema.parse(await helper.call('stop', undefined, 60000));
    await Promise.race([a.cameraDone, new Promise((r) => setTimeout(r, 5000))]);
    const cameraOffsetSec = cameraOffsetFor(a, stop.segments[0]?.startNs ?? 0);
    const s = settings.get().record;
    await finalizeBundle(a.dir, a.name, stop, { ...(cameraOffsetSec !== undefined ? { cameraOffsetSec } : {}), zoomMode: a.input.zoomMode ?? s.zoomMode, autoZoom: s.autoZoom, kind: a.input.mode });
    if (existsSync(join(a.dir, 'recording.lock'))) unlinkSync(join(a.dir, 'recording.lock'));
    log.info('recording.finalized', { dir: a.dir });
    openEditor(a.dir);
  } catch (e) {
    log.error('recording.stop', e);
    stopError = await recoverAfterFailure(a.dir, (e as Error).message);
  } finally {
    powerSaveBlocker.stop(a.powerBlock);
    await restoreDesktop(a.desktopRestore);
    active = null;
    setState({ state: 'idle', elapsedSec: 0, error: stopError });
  }
  return state;
}

/**
 * A stop/finalise failure must not lose the take: rebuild the project from the crash-recovery journal
 * (segments.json + capture.json) and open it. Returns the message to show (undefined = nothing to report).
 */
async function recoverAfterFailure(dir: string, reason: string): Promise<string | undefined> {
  if (!existsSync(join(dir, 'segments.json'))) return `Recording failed: ${reason}`;
  try {
    if (!existsSync(join(dir, 'recording.lock'))) writeFileSync(join(dir, 'recording.lock'), JSON.stringify({ recoveredAt: new Date().toISOString() }));
    await restoreInterrupted(dir);
    openEditor(dir);
    return 'The capture engine stopped unexpectedly. Your recording was recovered up to that point.';
  } catch (e) {
    log.error('recording.recover', e, { dir });
    return `Recording failed: ${reason}. Recovery also failed (${(e as Error).message}); the raw files are in ${dir}.`;
  }
}

// The helper restarts itself after a crash; an active recording can't continue, so finalise what's on disk.
helper.on('state', (st: string) => {
  if (st !== 'crashed' || !active || state.state === 'stopping') return;
  const a = active;
  log.warn('recording.helperCrashed', { dir: a.dir });
  setState({ state: 'stopping' });
  void (async () => {
    await teardownUi();
    await Promise.race([a.cameraDone, new Promise((res) => setTimeout(res, 3000))]);
    powerSaveBlocker.stop(a.powerBlock);
    await restoreDesktop(a.desktopRestore);
    active = null;
    const msg = await recoverAfterFailure(a.dir, 'capture engine crashed');
    setState({ state: 'idle', elapsedSec: 0, error: msg });
  })();
});

/** Discard: stop capture and move the bundle to the OS trash (recoverable). */
export async function discardRecording(): Promise<RecState> {
  if (!active) return state;
  const a = active;
  await teardownUi();
  try {
    await helper.call('stop', undefined, 60000);
  } catch (e) {
    log.warn('recording.discard.stop', { message: (e as Error).message });
  }
  powerSaveBlocker.stop(a.powerBlock);
  await restoreDesktop(a.desktopRestore);
  active = null;
  const { shell } = await import('electron');
  await shell.trashItem(a.dir).catch((e: unknown) => log.warn('recording.discard.trash', { message: (e as Error).message }));
  setState({ state: 'idle', elapsedSec: 0 });
  openRecorder();
  return state;
}

export async function restartRecording(): Promise<RecState> {
  if (!active) return state;
  const input = active.input;
  await discardRecording();
  getWin('recorder')?.hide();
  return startRecording(input);
}

// ---------------------------------------------------------------- crash recovery (task 1.18)

export function findInterrupted(): string[] {
  const root = settings.get().general.saveDir;
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => n.endsWith('.recproj'))
    .map((n) => join(root, n))
    .filter((d) => existsSync(join(d, 'recording.lock')) && existsSync(join(d, 'segments.json')) && !(active && active.dir === d));
}

export async function restoreInterrupted(dir: string): Promise<string> {
  allowRoot(dir);
  const j = JSON.parse(readFileSync(join(dir, 'segments.json'), 'utf8')) as {
    segments: StopResult['segments'];
    mic: string[];
    system: string[];
    width: number;
    height: number;
    fps: number;
    scaleFactor: number;
  };
  // the last segment never closed: measure what made it to disk
  const { ffprobeJson } = await import('./projects');
  for (const seg of j.segments) {
    if (seg.durationNs > 0) continue;
    try {
      const info = await ffprobeJson(join(dir, seg.file));
      seg.durationNs = Math.round(Number(info.format.duration ?? 0) * 1e9);
    } catch {
      seg.durationNs = 0;
    }
  }
  const segments = j.segments.filter((s) => s.durationNs > 0);
  if (!segments.length) throw new Error('No recoverable video in this recording');
  const name = `${(dir.split(/[\\/]/).pop() ?? 'Recording').replace(/\.recproj$/, '')} (recovered)`;
  const journal = readCaptureJournal(dir);
  const cameraOffsetSec = journal ? cameraOffsetFor(journal, segments[0]!.startNs) : undefined;
  await finalizeBundle(dir, name, { segments, audio: { mic: j.mic, system: j.system }, width: j.width, height: j.height, fps: j.fps, scaleFactor: j.scaleFactor }, {
    zoomMode: journal?.zoomMode ?? '2d', autoZoom: settings.get().record.autoZoom, repair: true, kind: journal?.mode ?? 'display', ...(cameraOffsetSec !== undefined ? { cameraOffsetSec } : {}),
  });
  unlinkSync(join(dir, 'recording.lock'));
  readProject(dir);
  return dir;
}

export function openTeleprompter(): void {
  const t = settings.get().teleprompter;
  const b = t.bounds ?? { width: 520, height: 260, x: 80, y: 80 };
  const w = openWindow('teleprompter', { ...b, frame: false, transparent: true, alwaysOnTop: true, resizable: true, skipTaskbar: false, protect: true, minWidth: 280, minHeight: 140 });
  w.setAlwaysOnTop(true, 'floating');
  const save = () => {
    if (!w.isDestroyed()) settings.set({ teleprompter: { bounds: w.getBounds() } });
  };
  w.on('moved', save);
  w.on('resized', save);
}
