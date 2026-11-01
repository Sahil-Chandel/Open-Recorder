/**
 * Android device recording (task 11.3, DEV-01/03/04/06; audit C31/A21/A2): adb (the user's, bundled, or
 * Google's platform-tools downloaded on demand) + scrcpy-server (Apache-2.0, fetched on demand).
 * Protocol: forward tunnel → video socket (dummy byte, 64-byte device name, codec/width/height, then
 * 12-byte framed packets: PTS+flags | size) and audio socket (codec id + framed raw PCM, Android 11+).
 * Live preview: video packets are forwarded to the renderer (WebCodecs decode).
 *
 * Recording (one bundle): H.264 muxed WITHOUT re-encoding into fragmented MP4 (crash-safe; remuxed to a
 * faststart MP4 at the end), device audio as a pts-faithful WAV, the computer's mic + system audio through the
 * capture helper (startAudioCapture), webcam (and a mic fallback) streamed from the renderer. Every track is
 * aligned to the first written video frame (source.trackOffsets). recording.lock + android.json make an
 * interrupted take recoverable, and every stop path (button, Disconnect, leaving the tab, unplug, window
 * close, quit) runs the same idempotent finalisation.
 */
import { app, BrowserWindow, dialog, net, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk } from 'mediabunny';
import { z } from 'zod';
import { createProject, type Project, type SourceInfo } from '@rec/shared';
import type {
  AdbProgress,
  AdbStatus,
  AndroidMirrorInfo,
  AndroidRecordInput,
  AndroidRecordResult,
  AndroidRecState,
  AndroidTrack,
  EventChannel,
} from '../shared/ipc';
import {
  androidLock,
  AndroidJournalSchema,
  avcCodec,
  bestClockOffset,
  CLOCK_SETTLE_US,
  DEVICE_AUDIO,
  DEVICE_JAR,
  DEVICE_LATENCY_MS,
  DeviceClock,
  findAdb,
  isAndroidLock,
  JOURNAL_FILE,
  journalDurationSec,
  journalOffsets,
  LOCK_FILE,
  MIN_AUDIO_SDK,
  parseAdbDevices,
  parsePacketHeader,
  placePcm,
  platformToolsUrl,
  RAW_AUDIO_CODEC,
  SCRCPY_VERSION,
  scrcpyServerArgs,
  transition,
  wavHeader,
  wavSizeFix,
  type AdbDevice,
  type AdbLookup,
  type AndroidJournal,
  type RecPhase,
} from './androidSync';
import { pickFrame } from './deviceFramePick';
import { helper } from './helper';
import { addHandler } from './ipc';
import { logger } from './log';
import { applyDefaultPreset } from './presets';
import { allowRoot, atomicWrite, ffprobeJson, makeThumbnail, newBundleDir, runFfmpeg, writeProject } from './projects';
import { settings } from './settings';
import { isSmoke } from './smoke';
import { openEditor } from './windows';

const log = logger.child('android');

const FILES = {
  videoFrag: 'media/screen.frag.mp4',
  screen: 'media/screen.mp4',
  device: 'media/device.wav',
  camera: 'media/camera_000.webm',
  rendererMic: 'media/mic.webm',
} as const;
const RENDERER_FILES: Record<AndroidTrack, string> = { camera: FILES.camera, mic: FILES.rendererMic };
/** how long finalisation waits for the renderer's last camera/mic chunks */
const RENDERER_GRACE_MS = 5000;
/** a quit waits this long for a running take to finalise; the lock covers anything slower */
const QUIT_GRACE_MS = 20000;
const RECORD_FPS = 60;

const nowMs = (): number => performance.timeOrigin + performance.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function sendTo(wc: Electron.WebContents | null | undefined, ch: EventChannel, payload: unknown): void {
  if (wc && !wc.isDestroyed()) wc.send(ch, payload);
}

// ---------------------------------------------------------------- adb (user's, bundled, or downloaded on demand)

const ADB_EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';
const binDir = (): string => join(app.getPath('userData'), 'bin');
const toolsDir = (): string => join(binDir(), 'platform-tools');

function adbLookup(): AdbLookup {
  return {
    platform: process.platform,
    env: process.env,
    bundledDir: app.isPackaged ? join(process.resourcesPath, 'bin', `${process.platform}-${process.arch}`) : null,
    downloadDir: toolsDir(),
    exists: existsSync,
  };
}

/** Resolved adb executable, or null when none is installed (the Device tab then offers the download). */
export function adbPath(): string | null {
  return findAdb(adbLookup())?.path ?? null;
}

const NO_ADB = 'adb (Android platform-tools) is not installed. Download it from the Device tab.';

function adb(args: string[], timeoutMs = 15000): Promise<string> {
  const exe = adbPath();
  if (!exe) return Promise.reject(new Error(NO_ADB));
  const cmd = args[0] === '-s' ? args[2] : args[0];
  return new Promise((res, rej) => {
    const p = spawn(exe, args, { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); rej(new Error(`adb ${cmd} timed out`)); }, timeoutMs);
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', (e) => { clearTimeout(t); rej(new Error(`adb could not be started (${e.message}).`)); });
    p.on('exit', (c) => { clearTimeout(t); c === 0 ? res(out) : rej(new Error(err.trim() || `adb ${cmd} exited ${c}`)); });
  });
}

let installing: Promise<AdbStatus> | null = null;

export function adbStatus(): AdbStatus {
  const found = findAdb(adbLookup());
  return { found: Boolean(found), path: found?.path ?? null, source: found?.source ?? null, canDownload: platformToolsUrl(process.platform) !== null, installing: installing !== null };
}

/** Single-flight: a second click while downloading joins the running install. */
export function installPlatformTools(progress: (p: AdbProgress) => void): Promise<AdbStatus> {
  installing ??= downloadPlatformTools(progress).finally(() => { installing = null; });
  return installing;
}

function run(cmd: string, args: string[], timeoutMs = 120000): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    const t = setTimeout(() => { p.kill(); rej(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    p.on('error', (e) => { clearTimeout(t); rej(e); });
    p.on('exit', (c) => { clearTimeout(t); c === 0 ? res(out) : rej(new Error(`${cmd} exited ${c}: ${out.trim().slice(-300)}`)); });
  });
}

/** System bsdtar unpacks zips on Windows 10+ and macOS (like asr.ts); GNU tar cannot, so Linux falls back to unzip. */
async function extractZip(zip: string, dest: string): Promise<void> {
  const sysTar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : null;
  try {
    await run(sysTar && existsSync(sysTar) ? sysTar : 'tar', ['-xf', zip, '-C', dest]);
  } catch (e) {
    if (process.platform !== 'linux') throw e;
    await run('unzip', ['-q', '-o', zip, '-d', dest]);
  }
}

/**
 * Google's platform-tools (adb) → userData/bin/platform-tools. "latest" has no published checksum, so the
 * archive is trusted on its HTTPS origin and accepted only once its adb runs and reports itself.
 */
async function downloadPlatformTools(progress: (p: AdbProgress) => void): Promise<AdbStatus> {
  if (findAdb(adbLookup())) return adbStatus();
  const url = platformToolsUrl(process.platform);
  if (!url) throw new Error(`Android platform-tools are not available for ${process.platform}.`);
  mkdirSync(binDir(), { recursive: true });
  // staging dirs of downloads cut off by a quit (ours only: platform-tools.part-<pid>)
  for (const n of readdirSync(binDir())) if (n.startsWith('platform-tools.part-')) rmSync(join(binDir(), n), { recursive: true, force: true });
  const stage = join(binDir(), `platform-tools.part-${process.pid}`);
  mkdirSync(stage, { recursive: true });
  try {
    log.info('android.adb.download', { url });
    const res = await net.fetch(url, { headers: { 'User-Agent': 'Open-Recorder' } });
    if (!res.ok || !res.body) throw new Error(`platform-tools download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || null;
    let received = 0;
    let last = 0;
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (c: Buffer) => {
      received += c.length;
      if (Date.now() - last > 100) {
        last = Date.now();
        progress({ phase: 'download', received, total });
      }
    });
    const zip = join(stage, 'platform-tools.zip');
    await pipeline(body, createWriteStream(zip));
    if (total && received !== total) throw new Error('platform-tools download was cut off. Please try again.');
    progress({ phase: 'extract', received, total });
    await extractZip(zip, stage);
    const exe = join(stage, 'platform-tools', ADB_EXE);
    if (!existsSync(exe)) throw new Error('The platform-tools archive did not contain adb.');
    if (process.platform !== 'win32') chmodSync(exe, 0o755);
    progress({ phase: 'verify', received, total });
    const version = await run(exe, ['version'], 15000);
    if (!/Android Debug Bridge/i.test(version)) throw new Error('The downloaded adb did not start correctly.');
    rmSync(toolsDir(), { recursive: true, force: true }); // a broken earlier copy (no adb in it, or we'd not be here)
    renameSync(join(stage, 'platform-tools'), toolsDir());
    log.info('android.adb.installed', { path: join(toolsDir(), ADB_EXE), bytes: received, version: version.split(/\r?\n/)[0] });
    progress({ phase: 'done', received, total });
    return adbStatus();
  } catch (e) {
    log.error('android.adb.install', e, { url });
    throw e;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function listDevices(): Promise<AdbDevice[]> {
  return parseAdbDevices(await adb(['devices', '-l']));
}

async function deviceSdk(serial: string): Promise<number | null> {
  try {
    const n = Number.parseInt((await adb(['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'], 8000)).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // let the server decide
  }
}

async function ensureServer(): Promise<string> {
  const dir = binDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `scrcpy-server-v${SCRCPY_VERSION}`);
  if (existsSync(file) && statSync(file).size > 10_000) return file;
  const url = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
  log.info('android.server.download', { url });
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`scrcpy-server download failed (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
  return file;
}

// ---------------------------------------------------------------- sockets

/** Buffered reader over a socket: await exactly n bytes. */
class SocketReader {
  private chunks: Buffer[] = [];
  private len = 0;
  private waiters: Array<{ n: number; res: (b: Buffer) => void; rej: (e: Error) => void }> = [];
  private ended = false;
  constructor(sock: Socket) {
    sock.on('data', (d: Buffer) => { this.chunks.push(d); this.len += d.length; this.pump(); });
    sock.on('close', () => { this.ended = true; for (const w of this.waiters) w.rej(new Error('device stream closed')); this.waiters = []; });
    sock.on('error', () => undefined); // surfaces as 'close'
  }
  private take(n: number): Buffer {
    const first = this.chunks[0]!;
    this.len -= n;
    if (first.length >= n) {
      // common case (headers, small frames): no copy
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const all = Buffer.concat(this.chunks);
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    return all.subarray(0, n);
  }
  private pump(): void {
    while (this.waiters.length && this.len >= this.waiters[0]!.n) {
      const w = this.waiters.shift()!;
      w.res(this.take(w.n));
    }
  }
  read(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    if (this.ended && this.len < n) return Promise.reject(new Error('device stream closed'));
    return new Promise((res, rej) => { this.waiters.push({ n, res, rej }); this.pump(); });
  }
}

function connectOnce(port: number): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = new Socket();
    s.once('connect', () => res(s));
    s.once('error', (e) => { s.destroy(); rej(e); });
    s.connect(port, '127.0.0.1');
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what} timed out`)))]);
}

/**
 * adb accepts the forwarded TCP connection before the server listens (and then drops it), so a connection
 * only counts once the server's dummy byte arrives — retried like the scrcpy client does.
 */
async function connectVideo(port: number, server: ChildProcess, serverTail: () => string): Promise<{ sock: Socket; reader: SocketReader }> {
  const deadline = Date.now() + 15000; // app_process start-up is ~0.5–2 s; a locked or unauthorised phone never answers
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`The device server stopped: ${serverTail() || `exit ${server.exitCode ?? server.signalCode}`}`);
    let sock: Socket | null = null;
    try {
      sock = await connectOnce(port);
      const reader = new SocketReader(sock);
      await withTimeout(reader.read(1), 3000, 'device handshake');
      return { sock, reader };
    } catch {
      sock?.destroy();
      await sleep(100);
    }
  }
  throw new Error('The device did not answer. Unlock it, accept the “Allow USB debugging?” prompt and try again.');
}

// ---------------------------------------------------------------- mirror session

interface Session {
  serial: string;
  server: ChildProcess;
  video: Socket;
  audio: Socket | null;
  port: number;
  width: number;
  height: number;
  name: string;
  /** latest SPS/PPS (Annex B) */
  config: Uint8Array | null;
  /** phone pts → PC wall clock, from every video packet */
  clock: DeviceClock;
  audioReady: Promise<boolean>;
  win: BrowserWindow | null;
  ended: boolean;
  detach: () => void;
}
let session: Session | null = null;
/** bumped by every stopMirror: a connect still in flight when the user leaves must not install its session */
let mirrorGen = 0;
let connecting = false;

const contents = (s: Session): Electron.WebContents | null => (s.win && !s.win.isDestroyed() ? s.win.webContents : null);

/** The renderer that owns the mirror going away (window closed, reloaded, crashed) ends the session — and the take. */
function watchWindow(s: Session): () => void {
  const wc = contents(s);
  if (!wc) return () => undefined;
  const gone = () => { if (session === s) void stopMirror('window-closed'); };
  const nav = (d: { isMainFrame: boolean; isSameDocument: boolean }) => { if (d.isMainFrame && !d.isSameDocument) gone(); };
  wc.once('destroyed', gone);
  wc.on('render-process-gone', gone);
  wc.on('did-start-navigation', nav);
  return () => {
    if (wc.isDestroyed()) return;
    wc.removeListener('destroyed', gone);
    wc.removeListener('render-process-gone', gone);
    wc.removeListener('did-start-navigation', nav);
  };
}

export async function startMirror(serial: string, win: BrowserWindow | null, opts: { maxFps?: number; bitrate?: number } = {}): Promise<AndroidMirrorInfo> {
  if (connecting) throw new Error('Already connecting to a device');
  connecting = true;
  try {
    await stopMirror('restart');
    return await connectMirror(serial, win, opts, mirrorGen);
  } finally {
    connecting = false;
  }
}

async function connectMirror(serial: string, win: BrowserWindow | null, opts: { maxFps?: number; bitrate?: number }, gen: number): Promise<AndroidMirrorInfo> {
  const exe = adbPath();
  if (!exe) throw new Error(NO_ADB);
  const jar = await ensureServer();
  await adb(['-s', serial, 'push', jar, DEVICE_JAR], 60000);
  const sdk = await deviceSdk(serial);
  const wantAudio = sdk === null || sdk >= MIN_AUDIO_SDK;
  const scid = (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0');
  const port = 27183 + Math.floor(Math.random() * 1000);
  await adb(['-s', serial, 'forward', `tcp:${port}`, `localabstract:scrcpy_${scid}`]);
  const server = spawn(exe, scrcpyServerArgs(serial, { scid, audio: wantAudio, ...opts }), { windowsHide: true });
  let tail = '';
  const onServer = (d: Buffer) => {
    const line = d.toString();
    tail = (tail + line).slice(-600);
    log.debug('android.server', { line: line.slice(0, 300) });
  };
  server.stdout?.on('data', onServer);
  server.stderr?.on('data', onServer);
  server.on('error', (e) => log.warn('android.server.spawn', { message: e.message }));
  let video: Socket | null = null;
  let audio: Socket | null = null;
  try {
    const conn = await connectVideo(port, server, () => tail.trim().split(/\r?\n/).pop() ?? '');
    video = conn.sock;
    const vr = conn.reader;
    // the server accepts the audio socket before it sends the device meta, so connect it first
    audio = wantAudio ? await connectOnce(port).catch(() => null) : null;
    const name = (await withTimeout(vr.read(64), 10000, 'device info')).toString('utf8').replace(/\0.*$/s, '');
    const meta = await withTimeout(vr.read(12), 10000, 'video info');
    const width = meta.readUInt32BE(4), height = meta.readUInt32BE(8);
    if (gen !== mirrorGen) throw new Error('Connection cancelled'); // stopped (tab left, window closed) while connecting
    let audioReady!: (ok: boolean) => void;
    const s: Session = {
      serial, server, video, audio, port, width, height, name, config: null, clock: new DeviceClock(),
      audioReady: new Promise<boolean>((r) => (audioReady = r)), win, ended: false, detach: () => undefined,
    };
    session = s;
    s.detach = watchWindow(s);
    void videoLoop(s, vr);
    if (audio) void audioLoop(s, new SocketReader(audio), audioReady);
    else audioReady(false);
    // Android 11 may take a moment to grant playback capture; don't hold the mirror for it
    const audioOk = await Promise.race([s.audioReady, sleep(2000).then(() => false)]);
    log.info('android.mirror.start', { serial, width, height, sdk, audio: audioOk });
    return { width, height, name, audio: audioOk, systemAudio: process.platform === 'win32' };
  } catch (e) {
    video?.destroy();
    audio?.destroy();
    server.kill();
    await adb(['-s', serial, 'forward', '--remove', `tcp:${port}`]).catch(() => undefined);
    throw e;
  }
}

async function videoLoop(s: Session, r: SocketReader): Promise<void> {
  try {
    for (;;) {
      const h = parsePacketHeader(await r.read(12));
      const data = new Uint8Array(await r.read(h.size));
      if (h.config) {
        s.config = data;
        if (active?.session === s) active.configChanged = true; // e.g. rotation: re-sent in-band with the next key frame
      } else s.clock.observe(h.ptsUs, nowMs());
      sendTo(contents(s), 'android:frame', { config: h.config, key: h.key, pts: h.ptsUs, data });
      const rec = active;
      if (!h.config && rec && rec.session === s && rec.phase === 'recording') {
        rec.inflight = writeVideo(rec, s, data, h.key, h.ptsUs);
        await rec.inflight; // backpressure: the socket waits for the disk
      }
    }
  } catch (e) {
    log.info('android.video.end', { message: msg(e) });
  }
  onStreamEnd(s);
}

async function audioLoop(s: Session, r: SocketReader, ready: (ok: boolean) => void): Promise<void> {
  try {
    const codec = (await r.read(4)).readUInt32BE(0);
    // 0 = the device disabled audio (no playback capture), 1 = configuration error; raw is what we asked for
    if (codec !== RAW_AUDIO_CODEC) {
      log.info('android.audio.unavailable', { codec });
      return ready(false);
    }
    ready(true);
    for (;;) {
      const h = parsePacketHeader(await r.read(12));
      const data = new Uint8Array(await r.read(h.size));
      const rec = active;
      if (!h.config && rec && rec.session === s && rec.phase === 'recording') writeDeviceAudio(rec, h.ptsUs, data);
    }
  } catch (e) {
    ready(false);
    log.info('android.audio.end', { message: msg(e) }); // video carries on without device audio
  }
}

/** Unplugged, server died, or torn down: tell the renderer; a running take is finalised, never dropped (C31a). */
function onStreamEnd(s: Session): void {
  if (s.ended) return;
  s.ended = true;
  sendTo(contents(s), 'android:frame', { ended: true });
  if (session === s) void stopMirror('disconnected');
}

export async function stopMirror(reason = 'user'): Promise<void> {
  const s = session;
  session = null;
  mirrorGen++;
  // keep the take before tearing anything down: finalisation needs no socket, only the take itself
  const rec = active && active.session === s ? active : null;
  const saving = rec ? finalizeRecording(rec, reason) : null; // flips to 'finalizing' synchronously → no more writes
  if (s) {
    s.detach();
    s.video.destroy();
    s.audio?.destroy();
    s.server.kill();
    void adb(['-s', s.serial, 'forward', '--remove', `tcp:${s.port}`]).catch(() => undefined);
    log.info('android.mirror.stop', { serial: s.serial, reason });
  }
  await saving;
}

// ---------------------------------------------------------------- recording

/**
 * Device audio → WAV as it arrives. Packets are placed by pts (placePcm), so a pause in the phone's audio
 * becomes silence instead of pulling everything after it forward. The header is rewritten every second; a
 * crash loses at most that much, and finalisation recomputes the sizes from the file anyway.
 */
class WavSink {
  private static readonly zeros = new Uint8Array(DEVICE_AUDIO.rate * DEVICE_AUDIO.channels * 2); // 1 s, shared
  private readonly fh: Promise<FileHandle>;
  private chain: Promise<unknown>;
  private frames = 0;
  private lastHeader = 0;
  private closed = false;
  private failed = false;
  private readonly frameBytes: number;

  constructor(private readonly file: string, private readonly rate: number, private readonly channels: number, private readonly t0Us: number) {
    this.frameBytes = channels * 2;
    this.fh = open(file, 'w');
    this.chain = Promise.resolve();
    this.header();
  }

  write(ptsUs: number, pcm: Uint8Array): void {
    if (this.closed) return;
    const fb = this.frameBytes;
    const frames = Math.floor(pcm.byteLength / fb);
    if (!frames) return;
    const { silence, skip } = placePcm(this.frames, ptsUs, this.t0Us, frames, this.rate);
    for (let left = silence; left > 0;) {
      const n = Math.min(left, WavSink.zeros.byteLength / fb);
      this.append(WavSink.zeros.subarray(0, n * fb));
      left -= n;
    }
    if (skip < frames) this.append(pcm.subarray(skip * fb, frames * fb));
    if (Date.now() - this.lastHeader >= 1000) this.header();
  }

  private append(buf: Uint8Array): void {
    const pos = 44 + this.frames * this.frameBytes;
    this.frames += buf.byteLength / this.frameBytes;
    this.link((fh) => fh.write(buf, 0, buf.byteLength, pos));
  }

  private header(): void {
    this.lastHeader = Date.now();
    const h = wavHeader(this.frames * this.frameBytes, this.rate, this.channels);
    this.link((fh) => fh.write(h, 0, h.byteLength, 0));
  }

  private link(fn: (fh: FileHandle) => Promise<unknown>): void {
    this.chain = this.chain.then(() => this.fh).then(fn);
    this.chain.catch((e: unknown) => {
      if (this.failed) return;
      this.failed = true;
      log.error('android.deviceAudio.write', e, { file: this.file });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.header();
    this.closed = true;
    try {
      await this.chain;
    } finally {
      await (await this.fh.catch(() => null))?.close().catch(() => undefined);
    }
  }
}

/** camera / mic-fallback track recorded by the renderer and appended here in order */
interface RendererTrack {
  file: string;
  fh: Promise<FileHandle> | null;
  chain: Promise<unknown>;
  closed: boolean;
  failed: boolean;
  done: Promise<void>;
  markDone: () => void;
}

function rendererTrack(file: string): RendererTrack {
  let markDone!: () => void;
  const done = new Promise<void>((r) => (markDone = r));
  return { file, fh: null, chain: Promise.resolve(), closed: false, failed: false, done, markDone };
}

interface DeviceRecording {
  dir: string;
  session: Session;
  phase: RecPhase;
  journal: AndroidJournal;
  startWallMs: number;
  video: { output: Output; source: EncodedVideoPacketSource; fh: FileHandle; configured: boolean };
  configChanged: boolean;
  videoError: boolean;
  inflight: Promise<void> | null;
  deviceWav: WavSink | null;
  helperAudio: boolean;
  renderer: Map<AndroidTrack, RendererTrack>;
  ready: Promise<void>;
  finalizing: Promise<string | null> | null;
  timer: NodeJS.Timeout | null;
}
/** the take being recorded or finalised — deliberately outlives the mirror session it came from */
let active: DeviceRecording | null = null;
let quitting = false;

function persist(rec: DeviceRecording): void {
  try {
    atomicWrite(join(rec.dir, JOURNAL_FILE), JSON.stringify(rec.journal));
  } catch (e) {
    log.warn('android.journal.write', { dir: rec.dir, message: msg(e) }); // next tick retries
  }
}

function fileTarget(fh: FileHandle): StreamTarget {
  let chain: Promise<unknown> = Promise.resolve();
  return new StreamTarget(new WritableStream<StreamTargetChunk>({
    write(c) { chain = chain.then(() => fh.write(c.data, 0, c.data.byteLength, c.position)); return chain as Promise<void>; },
    close() { return chain as Promise<void>; },
  }));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length);
  o.set(a, 0);
  o.set(b, a.length);
  return o;
}

async function writeVideo(rec: DeviceRecording, s: Session, data: Uint8Array, key: boolean, ptsUs: number): Promise<void> {
  const v = rec.journal.video;
  if (v.t0Us === null) {
    if (!key || !s.config) return; // a take starts on a key frame: ≤ 1 s away with i-frame-interval=1
    v.t0Us = ptsUs;
    log.info('android.record.firstFrame', { dir: rec.dir, waitMs: Math.round(nowMs() - rec.startWallMs) });
    persist(rec);
  }
  const inband = key && (!rec.video.configured || rec.configChanged);
  const payload = inband && s.config ? concat(s.config, data) : data;
  const meta = rec.video.configured ? undefined : { decoderConfig: { codec: avcCodec(s.config), codedWidth: s.width, codedHeight: s.height } };
  try {
    await rec.video.source.add(new EncodedPacket(payload, key ? 'key' : 'delta', (ptsUs - v.t0Us) / 1e6, 1 / RECORD_FPS), meta);
    rec.video.configured = true;
    if (inband) rec.configChanged = false;
    v.lastUs = Math.max(v.lastUs ?? ptsUs, ptsUs);
  } catch (e) {
    if (!rec.videoError) log.error('android.record.video', e, { dir: rec.dir });
    rec.videoError = true;
  }
  // phone → PC mapping for this take: tracked until the window spans t0 − 2 s … t0 + 3 s, then frozen
  const c = rec.journal.clock;
  if (!c.settled) {
    c.devToWallMs = s.clock.offsetMs;
    if (ptsUs - v.t0Us >= CLOCK_SETTLE_US) {
      c.settled = true;
      persist(rec);
      log.info('android.record.clock', { dir: rec.dir, devToWallMs: c.devToWallMs });
    }
  }
}

function writeDeviceAudio(rec: DeviceRecording, ptsUs: number, pcm: Uint8Array): void {
  if (!rec.deviceWav) {
    rec.deviceWav = new WavSink(join(rec.dir, FILES.device), DEVICE_AUDIO.rate, DEVICE_AUDIO.channels, ptsUs);
    rec.journal.deviceAudio = { file: FILES.device, t0Us: ptsUs, rate: DEVICE_AUDIO.rate, channels: DEVICE_AUDIO.channels };
    persist(rec);
  }
  rec.deviceWav.write(ptsUs, pcm);
}

const HelperAudioSchema = z.object({
  t0Ns: z.number(),
  mic: z.object({ file: z.string(), startNs: z.number() }).nullable(),
  system: z.object({ file: z.string(), startNs: z.number() }).nullable(),
  errors: z.array(z.object({ source: z.string(), message: z.string() })).default([]),
});

interface PcAudio {
  qpcToWallMs: number | null;
  mic: { file: string; startNs: number } | null;
  system: { file: string; startNs: number } | null;
  warnings: string[];
  /** the helper cannot capture audio on its own (not running, macOS, or a build without startAudioCapture) */
  unsupported: boolean;
}

/** NTP-style ping: the helper's QPC clock → wall ms (as recording.ts does for the camera). */
async function helperClockOffset(): Promise<number | null> {
  const samples: Array<{ sentMs: number; recvMs: number; remoteNs: number }> = [];
  for (let i = 0; i < 5; i++) {
    const sentMs = nowMs();
    const r = await helper.call<{ t: number }>('ping', undefined, 3000);
    samples.push({ sentMs, recvMs: nowMs(), remoteNs: r.t });
  }
  return bestClockOffset(samples);
}

/** The computer's mic + system audio via the capture helper, on one QPC clock, with the user's chosen devices. */
async function startPcAudio(dir: string, o: AndroidRecordInput): Promise<PcAudio> {
  const none: PcAudio = { qpcToWallMs: null, mic: null, system: null, warnings: [], unsupported: true };
  if (helper.state !== 'ready') return none;
  const d = settings.get().devices;
  try {
    const qpcToWallMs = await helperClockOffset();
    const raw = await helper.call('startAudioCapture', {
      dir,
      system: { enabled: o.systemAudio, ...(d.outputId ? { deviceId: d.outputId } : {}), ...(d.appPid ? { appPid: d.appPid } : {}) },
      mic: { enabled: o.mic, ...(d.micId ? { deviceId: d.micId } : {}) },
    }, 20000);
    const r = HelperAudioSchema.parse(raw);
    const label = (src: string) => (src === 'mic' ? 'Microphone' : 'Computer audio');
    return { qpcToWallMs, mic: r.mic, system: r.system, warnings: r.errors.map((e) => `${label(e.source)}: ${e.message}`), unsupported: false };
  } catch (e) {
    if ((e as { code?: number }).code === -32601) {
      log.warn('android.pcAudio.unsupported', { message: msg(e) });
      return none;
    }
    log.warn('android.pcAudio.start', { message: msg(e) });
    return { ...none, unsupported: false, warnings: [`Computer audio could not start: ${msg(e)}`] };
  }
}

export async function startDeviceRecording(o: AndroidRecordInput): Promise<AndroidRecordResult> {
  const s = session;
  if (!s) throw new Error('No device connected');
  if (active) throw new Error(active.phase === 'finalizing' ? 'The previous recording is still being saved' : 'Already recording');
  const { dir } = newBundleDir();
  allowRoot(dir);
  let video: DeviceRecording['video'];
  try {
    const fh = await open(join(dir, FILES.videoFrag), 'w');
    // fragmented MP4: every fragment (~1 key-frame interval) is complete on disk, so a crash loses at most the last
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.5 }), target: fileTarget(fh) });
    const source = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(source); // no frameRate: it would snap the phone's variable frame times to a grid
    await output.start();
    video = { output, source, fh, configured: false };
  } catch (e) {
    await shell.trashItem(dir).catch(() => undefined); // nothing recorded yet
    throw e;
  }
  const journal: AndroidJournal = {
    v: 1, device: s.name, serial: s.serial, width: s.width, height: s.height, fps: RECORD_FPS, startedAt: new Date().toISOString(),
    video: { file: FILES.videoFrag, t0Us: null, lastUs: null },
    deviceAudio: null,
    clock: { devToWallMs: null, latencyMs: DEVICE_LATENCY_MS, qpcToWallMs: null, settled: false },
    helper: null,
    renderer: { camera: null, mic: null },
  };
  let markReady!: () => void;
  const rec: DeviceRecording = {
    dir, session: s, phase: transition('idle', 'start')!, journal, startWallMs: nowMs(), video, configChanged: false, videoError: false,
    inflight: null, deviceWav: null, helperAudio: false, renderer: new Map(), ready: new Promise<void>((r) => (markReady = r)), finalizing: null, timer: null,
  };
  active = rec;
  persist(rec);
  writeFileSync(join(dir, LOCK_FILE), androidLock(s.serial, process.pid)); // from here on the take is recoverable
  const warnings: string[] = [];
  let rendererMic = false;
  try {
    // PC audio first: its clock then starts before the first video frame (small negative offsets, nothing cut)
    const pc = o.mic || o.systemAudio ? await startPcAudio(dir, o) : null;
    if (pc) {
      rec.helperAudio = Boolean(pc.mic || pc.system);
      journal.clock.qpcToWallMs = pc.qpcToWallMs;
      journal.helper = rec.helperAudio ? { mic: pc.mic, system: pc.system } : null;
      warnings.push(...pc.warnings);
      rendererMic = o.mic && pc.unsupported; // macOS / old helper: the renderer records the mic instead
      if (o.systemAudio && pc.unsupported) warnings.push('Computer audio needs the Windows capture helper; this take has device audio only.');
    }
    if (rec.phase === 'starting') {
      // renderer tracks are only expected when the take is still live (a stop may have come in meanwhile)
      if (o.camera) {
        rec.renderer.set('camera', rendererTrack(RENDERER_FILES.camera));
        journal.renderer.camera = { file: RENDERER_FILES.camera, startWallMs: null };
      }
      if (rendererMic) {
        rec.renderer.set('mic', rendererTrack(RENDERER_FILES.mic));
        journal.renderer.mic = { file: RENDERER_FILES.mic, startWallMs: null };
      }
      rec.phase = transition(rec.phase, 'started')!;
      rec.timer = setInterval(() => persist(rec), 2000);
    }
    persist(rec);
  } catch (e) {
    markReady();
    void finalizeRecording(rec, 'start-failed'); // never leave a half-started take holding `active`
    throw e;
  } finally {
    markReady();
  }
  const live = rec.phase === 'recording';
  if (live) sendTo(contents(s), 'android:state', { state: 'recording', dir } satisfies AndroidRecState);
  log.info('android.record.start', { dir, live, mic: o.mic, systemAudio: o.systemAudio, camera: o.camera, rendererMic, helperAudio: rec.helperAudio });
  return { dir, rendererMic: rendererMic && live, warnings };
}

/** Idempotent: the first stop finalises, later calls (or a stop with nothing running) share that result. */
export async function stopDeviceRecording(): Promise<string | null> {
  return active ? finalizeRecording(active, 'user') : null;
}

function finalizeRecording(rec: DeviceRecording, reason: string): Promise<string | null> {
  if (!rec.finalizing) {
    rec.phase = transition(rec.phase, 'stop') ?? rec.phase;
    rec.finalizing = runFinalize(rec, reason);
  }
  return rec.finalizing;
}

async function closeRendererTracks(rec: DeviceRecording): Promise<void> {
  const tracks = [...rec.renderer.values()];
  if (!tracks.length) return;
  await Promise.race([Promise.all(tracks.map((t) => t.done)), sleep(RENDERER_GRACE_MS)]);
  for (const t of tracks) {
    t.closed = true; // anything later is dropped
    await t.chain.catch(() => undefined);
    await (await t.fh?.catch(() => null))?.close().catch(() => undefined);
  }
}

async function runFinalize(rec: DeviceRecording, reason: string): Promise<string | null> {
  const wc = contents(rec.session);
  if (rec.timer) clearInterval(rec.timer);
  sendTo(wc, 'android:state', { state: 'finalizing', dir: rec.dir, reason } satisfies AndroidRecState); // renderer flushes camera/mic
  log.info('android.record.stop', { dir: rec.dir, reason });
  try {
    await rec.ready;
    await rec.inflight?.catch(() => undefined);
    // close every writer whatever happens to the others (these handles used to leak on Disconnect)
    try {
      await rec.video.output.finalize();
    } catch (e) {
      log.warn('android.record.muxer', { dir: rec.dir, message: msg(e) }); // the fragments on disk stay usable
    } finally {
      await rec.video.fh.close().catch(() => undefined);
    }
    await rec.deviceWav?.close().catch((e: unknown) => log.warn('android.deviceAudio.close', { message: msg(e) }));
    if (rec.helperAudio) await helper.call('stopAudioCapture', undefined, 20000).catch((e: unknown) => log.warn('android.pcAudio.stop', { message: msg(e) }));
    await closeRendererTracks(rec);
    persist(rec);
    const dir = await finalizeBundle(rec.dir, rec.journal, { recovered: false });
    sendTo(wc, 'android:state', { state: 'saved', dir } satisfies AndroidRecState);
    if (!quitting) openEditor(dir);
    return dir;
  } catch (e) {
    log.error('android.record.finalize', e, { dir: rec.dir, reason });
    if (e instanceof NoVideoError) await shell.trashItem(rec.dir).catch(() => undefined); // nothing to edit; recoverable from the trash
    sendTo(wc, 'android:state', { state: 'error', dir: rec.dir, reason, error: msg(e) } satisfies AndroidRecState);
    return null; // anything else keeps recording.lock → offered for recovery on the next start
  } finally {
    rec.phase = transition(rec.phase, 'done') ?? 'idle';
    if (active === rec) active = null;
  }
}

// ---------------------------------------------------------------- renderer tracks (camera, mic fallback)

function rendererTrackStart(kind: AndroidTrack, wallMs: number): void {
  const rec = active;
  const j = rec?.journal.renderer[kind];
  if (!rec || !rec.renderer.has(kind) || !j || j.startWallMs !== null) return;
  j.startWallMs = wallMs;
  persist(rec);
}

function rendererTrackChunk(kind: AndroidTrack, data: ArrayBuffer | Uint8Array): Promise<void> | undefined {
  const rec = active;
  const t = rec?.renderer.get(kind);
  if (!rec || !t || t.closed) return undefined; // not expected, or after the grace period
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const fh = (t.fh ??= open(join(rec.dir, t.file), 'a'));
  t.chain = t.chain.then(async () => (await fh).write(bytes));
  t.chain.catch((e: unknown) => {
    if (t.failed) return;
    t.failed = true;
    log.error('android.track.write', e, { kind, dir: rec.dir });
  });
  return t.chain.then(() => undefined, () => undefined); // the renderer awaits each chunk: natural backpressure
}

function rendererTrackDone(kind: AndroidTrack): void {
  const t = active?.renderer.get(kind);
  if (t) void t.chain.then(t.markDone, t.markDone);
}

// ---------------------------------------------------------------- finalisation (shared with crash recovery)

class NoVideoError extends Error {
  constructor() {
    super('No video was received from the device, so nothing could be saved.');
    this.name = 'NoVideoError';
  }
}

/** Patch WAV size fields left stale by a crash (device.wav is ours; the helper's flush every second). */
function repairWav(file: string): void {
  if (!existsSync(file)) return;
  const fd = openSync(file, 'r+');
  try {
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    const patches = wavSizeFix(head.subarray(0, n), fstatSync(fd).size);
    for (const p of patches ?? []) {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(p.value);
      writeSync(fd, b, 0, 4, p.offset);
    }
    if (patches) log.info('android.finalize.wavRepaired', { file, patches: patches.length });
  } finally {
    closeSync(fd);
  }
}

/** MediaRecorder WebM has no cues/duration → stream-copy remux (like the screen-recording camera). */
async function remuxWebm(dir: string, rel: string): Promise<void> {
  const raw = join(dir, rel);
  const tmp = raw.replace(/\.webm$/, '.remux.webm');
  try {
    await runFfmpeg(['-i', raw, '-c', 'copy', tmp]);
    renameSync(tmp, raw);
  } catch (e) {
    log.warn('android.finalize.webm', { file: rel, message: msg(e) }); // the raw file still plays
    rmSync(tmp, { force: true });
  }
}

/** Fragmented → regular MP4 with the index up front (fast seeking in the editor); the fMP4 is kept if that fails. */
async function remuxVideo(dir: string, j: AndroidJournal): Promise<void> {
  const frag = join(dir, j.video.file);
  const screen = join(dir, FILES.screen);
  if (!existsSync(frag)) return; // already done by an earlier (interrupted) finalisation
  const tmp = join(dir, 'media', 'screen.remux.mp4');
  try {
    await runFfmpeg(['-i', frag, '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', tmp]);
    renameSync(tmp, screen);
    rmSync(frag, { force: true });
  } catch (e) {
    log.warn('android.finalize.remux', { dir, message: msg(e) });
    rmSync(tmp, { force: true });
    renameSync(frag, screen); // fMP4 plays too, it just seeks slower
  }
}

/** Turn a stopped (or crash-interrupted) take into a project. Pure function of the journal + files on disk. */
async function finalizeBundle(dir: string, j: AndroidJournal, opts: { recovered: boolean }): Promise<string> {
  const abs = (f: string) => join(dir, f);
  const has = (f: string | null | undefined): f is string => Boolean(f) && existsSync(abs(f!)) && statSync(abs(f!)).size > 1024;
  if (j.video.t0Us === null) throw new NoVideoError(); // journaled before the first frame is muxed
  await remuxVideo(dir, j);
  if (!has(FILES.screen)) throw new NoVideoError();
  for (const f of [j.deviceAudio?.file, j.helper?.mic?.file, j.helper?.system?.file]) if (f) repairWav(abs(f));
  for (const f of [j.renderer.camera?.file, j.renderer.mic?.file]) if (has(f)) await remuxWebm(dir, f);
  let durationSec = journalDurationSec(j);
  try {
    const d = Number((await ffprobeJson(abs(FILES.screen))).format.duration);
    if (d > 0) durationSec = d;
  } catch {
    /* journal estimate */
  }
  const tracks: SourceInfo['tracks'] = { screen: FILES.screen };
  if (has(j.deviceAudio?.file)) tracks.device = j.deviceAudio!.file;
  if (has(j.helper?.mic?.file)) tracks.mic = j.helper!.mic!.file;
  else if (has(j.renderer.mic?.file)) tracks.mic = j.renderer.mic!.file;
  if (has(j.helper?.system?.file)) tracks.system = j.helper!.system!.file;
  if (has(j.renderer.camera?.file)) tracks.camera = j.renderer.camera!.file;
  const offsets = journalOffsets(j);
  const trackOffsets: Record<string, number> = {};
  for (const k of ['device', 'mic', 'system', 'camera'] as const) {
    if (!tracks[k]) continue;
    if (offsets[k] !== undefined) trackOffsets[k] = offsets[k]!;
    else log.warn('android.finalize.unaligned', { dir, track: k });
  }
  const project = createProject(`${j.device || 'Android'} recording${opts.recovered ? ' (recovered)' : ''}`, {
    kind: 'android', width: j.width, height: j.height, fps: j.fps, scaleFactor: 1,
    segments: [{ file: FILES.screen, startNs: 0, durationNs: Math.round(durationSec * 1e9) }],
    tracks, hasTelemetry: false, durationSec, trackOffsets,
  });
  project.canvas.deviceFrame = pickFrame(j.width, j.height, 'android');
  project.canvas.aspect = '16:9';
  let final: Project = project;
  try {
    final = applyDefaultPreset(project, dir); // like screen takes (copies the preset's images in); a preset's own device frame wins (PRE-03)
  } catch (e) {
    log.warn('android.finalize.preset', { message: msg(e) }); // never lose the take over a broken preset
  }
  writeProject(dir, final);
  atomicWrite(join(dir, 'meta.json'), JSON.stringify({
    app: app.getVersion(), os: process.platform, arch: process.arch, device: j.device, serial: j.serial,
    width: j.width, height: j.height, recovered: opts.recovered, trackOffsets, clock: j.clock,
  }, null, 1));
  await makeThumbnail(dir, abs(FILES.screen), Math.min(1, durationSec / 2));
  for (const f of [LOCK_FILE, JOURNAL_FILE]) rmSync(join(dir, f), { force: true });
  log.info('android.record.saved', { dir, durationSec, tracks: Object.keys(tracks), trackOffsets, recovered: opts.recovered });
  return dir;
}

// ---------------------------------------------------------------- crash recovery

/** Device takes interrupted by a crash: our lock (kind: android) + journal, no project.json yet. */
export function findInterruptedAndroid(): string[] {
  const root = settings.get().general.saveDir;
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => n.endsWith('.recproj'))
    .map((n) => join(root, n))
    .filter((d) => {
      if (active?.dir === d || !existsSync(join(d, JOURNAL_FILE))) return false;
      try {
        return isAndroidLock(readFileSync(join(d, LOCK_FILE), 'utf8'));
      } catch {
        return false;
      }
    });
}

export async function recoverAndroidBundle(dir: string): Promise<string> {
  allowRoot(dir);
  const j = AndroidJournalSchema.parse(JSON.parse(readFileSync(join(dir, JOURNAL_FILE), 'utf8')));
  return finalizeBundle(dir, j, { recovered: true });
}

async function promptRecovery(): Promise<void> {
  const pending = findInterruptedAndroid();
  if (!pending.length) return;
  const r = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Restore', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: pending.length > 1 ? `${pending.length} Android recordings were interrupted` : 'An Android recording was interrupted',
    detail: 'Restore it? Everything up to the last second or so can be recovered.',
  });
  if (r.response !== 0) return;
  for (const d of pending) {
    try {
      openEditor(await recoverAndroidBundle(d));
    } catch (e) {
      log.error('android.recovery.failed', e, { dir: d });
      if (e instanceof NoVideoError) await shell.trashItem(d).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------- registration

/** Quitting mid-take: hold the quit until the take is finalised (bounded; the lock covers the rest). */
function onBeforeQuit(e: Electron.Event): void {
  const rec = active;
  if (!rec || quitting) return;
  quitting = true;
  e.preventDefault();
  log.info('android.quit.finalize', { dir: rec.dir });
  void Promise.race([finalizeRecording(rec, 'quit'), sleep(QUIT_GRACE_MS)]).finally(() => app.quit());
}

export function registerAndroid(): void {
  addHandler('android:adbStatus', () => adbStatus());
  addHandler('android:installAdb', (e) => installPlatformTools((p) => sendTo(e.sender, 'android:adbProgress', p)));
  addHandler('android:devices', () => listDevices());
  addHandler('android:start', (e, o: { serial: string; maxFps?: number; bitrate?: number }) => startMirror(o.serial, BrowserWindow.fromWebContents(e.sender), o));
  addHandler('android:stop', () => stopMirror('user'));
  addHandler('android:record', (_e, o: AndroidRecordInput) => startDeviceRecording(o));
  addHandler('android:recordStop', () => stopDeviceRecording());
  addHandler('android:trackStart', (_e, kind: AndroidTrack, wallMs: number) => rendererTrackStart(kind, wallMs));
  addHandler('android:trackChunk', (_e, kind: AndroidTrack, data: ArrayBuffer | Uint8Array) => rendererTrackChunk(kind, data));
  addHandler('android:trackDone', (_e, kind: AndroidTrack) => rendererTrackDone(kind));
  app.on('before-quit', onBeforeQuit);
  app.on('will-quit', () => void stopMirror('quit'));
  if (!isSmoke()) {
    void app.whenReady().then(() => setTimeout(() => void promptRecovery().catch((e: unknown) => log.error('android.recovery.prompt', e)), 4000));
  }
}
