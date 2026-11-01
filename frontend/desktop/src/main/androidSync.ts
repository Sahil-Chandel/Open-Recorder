/**
 * Pure logic for Android device recordings (no Electron, no IO; unit-tested in test/android.test.ts):
 * scrcpy server options + packet framing, the phone→PC clock mapping and track offsets (A/V alignment),
 * raw-PCM gap filling + WAV headers (device audio), adb discovery, the recording state machine and the
 * crash journal that lets an interrupted take be finalised later.
 *
 * Offsets use the project convention (source.trackOffsets): seconds a track starts after video t=0, where
 * video t=0 is the first written (key) frame. Positive = the track starts later, negative = earlier.
 */
import { posix, win32 } from 'node:path';
import { z } from 'zod';

// ---------------------------------------------------------------- scrcpy server

export const SCRCPY_VERSION = '3.3.3';
export const DEVICE_JAR = '/data/local/tmp/scrcpy-server.jar';
/** scrcpy codec id of uncompressed audio ("\0raw"): s16le, 48 kHz, stereo. */
export const RAW_AUDIO_CODEC = 0x00726177;
export const DEVICE_AUDIO = { rate: 48000, channels: 2 } as const;
/** Playback capture (device audio) exists from Android 11 (API 30). */
export const MIN_AUDIO_SDK = 30;

export interface ServerOptions {
  /** 8 hex digits (31-bit): the device socket is `scrcpy_<scid>` */
  scid: string;
  maxFps?: number;
  bitrate?: number;
  /** false below Android 11: the server would never accept the audio socket */
  audio: boolean;
  /** key-frame interval; a take starts on a key frame, so this bounds the Record → first-frame wait */
  keyFrameIntervalSec?: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** adb arguments that start scrcpy-server on the device (forward tunnel, no control channel). */
export function scrcpyServerArgs(serial: string, o: ServerOptions): string[] {
  if (!/^[0-9a-f]{8}$/.test(o.scid) || Number.parseInt(o.scid, 16) > 0x7fffffff) throw new Error(`invalid scid ${o.scid}`);
  const fps = Math.round(clamp(o.maxFps ?? 60, 1, 120));
  const bitrate = Math.round(clamp(o.bitrate ?? 8_000_000, 500_000, 50_000_000));
  const gop = Math.round(clamp(o.keyFrameIntervalSec ?? 1, 1, 10));
  return [
    '-s', serial, 'shell', `CLASSPATH=${DEVICE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
    `scid=${o.scid}`, 'log_level=info', 'tunnel_forward=true', 'control=false', 'cleanup=true',
    // scrcpy defaults to a key frame every 10 s; MediaFormat "i-frame-interval" is applied after its defaults
    'video_codec=h264', `video_codec_options=i-frame-interval:int=${gop}`,
    `max_fps=${fps}`, `video_bit_rate=${bitrate}`,
    // raw PCM keeps device audio sample-exact against its pts (no AAC priming delay, no decode step)
    ...(o.audio ? ['audio=true', 'audio_codec=raw'] : ['audio=false']),
    'send_device_meta=true', 'send_frame_meta=true', 'send_dummy_byte=true',
  ];
}

export interface PacketHeader { config: boolean; key: boolean; ptsUs: number; size: number }

/** 12-byte scrcpy frame header: u64 (config flag | key flag | 62-bit pts µs) + u32 payload size. */
export function parsePacketHeader(h: Uint8Array): PacketHeader {
  if (h.byteLength < 12) throw new Error('short packet header');
  const dv = new DataView(h.buffer, h.byteOffset, 12);
  const ptsFlags = dv.getBigUint64(0);
  return {
    config: (ptsFlags >> 63n) === 1n,
    key: ((ptsFlags >> 62n) & 1n) === 1n,
    ptsUs: Number(ptsFlags & 0x3fffffffffffffffn),
    size: dv.getUint32(8),
  };
}

/** avc1.PPCCLL from the SPS NAL in an Annex B config packet. */
export function avcCodec(config: Uint8Array | null): string {
  if (config) {
    for (let i = 0; i + 6 < config.length; i++) {
      if (config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1 && (config[i + 3]! & 0x1f) === 7) {
        const hex = (n: number) => n.toString(16).padStart(2, '0');
        return `avc1.${hex(config[i + 4]!)}${hex(config[i + 5]!)}${hex(config[i + 6]!)}`;
      }
    }
  }
  return 'avc1.640028';
}

export interface AdbDevice { serial: string; state: string; model: string; product: string; transport: string }

/** `adb devices -l` → devices; daemon start-up chatter and the header line are ignored. */
export function parseAdbDevices(out: string): AdbDevice[] {
  const lines = out.split(/\r?\n/);
  const start = lines.findIndex((l) => /^List of devices attached/.test(l));
  return lines.slice(start + 1).filter((l) => l.trim() && !l.startsWith('*')).map((l) => {
    const [serial = '', state = '', ...rest] = l.trim().split(/\s+/);
    const kv = Object.fromEntries(rest.filter((x) => x.includes(':')).map((x) => [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)]));
    return { serial, state, model: (kv.model ?? '').replace(/_/g, ' '), product: kv.product ?? '', transport: kv.transport_id ?? '' };
  });
}

// ---------------------------------------------------------------- clocks

/**
 * Sliding-window minimum over (t, value) samples. A monotonic deque keeps only samples that can still become
 * the minimum, so push is O(1) amortised and min() is O(1) — one push per video packet at 60 fps.
 */
export class SlidingMin {
  private q: Array<{ t: number; v: number }> = [];
  private head = 0;
  constructor(private readonly span: number) {}

  push(t: number, v: number): void {
    while (this.q.length > this.head && this.q[this.q.length - 1]!.v >= v) this.q.pop();
    this.q.push({ t, v });
    while (this.head < this.q.length - 1 && this.q[this.head]!.t < t - this.span) this.head++;
    if (this.head > 4096) {
      this.q = this.q.slice(this.head); // compact the consumed prefix
      this.head = 0;
    }
  }

  min(): number | null {
    return this.q.length > this.head ? this.q[this.head]!.v : null;
  }
}

/**
 * Phone pts (µs, the device's monotonic clock) → PC wall clock (ms). Every video packet gives
 * arrival − pts = clock offset + transport delay; the minimum over a few seconds is the offset plus the
 * smallest delay (NTP-style filter). A window instead of the all-time minimum keeps clock drift out.
 */
export class DeviceClock {
  private readonly win: SlidingMin;
  constructor(windowMs = 5000) {
    this.win = new SlidingMin(windowMs);
  }
  observe(ptsUs: number, arrivalWallMs: number): void {
    this.win.push(ptsUs / 1000, arrivalWallMs - ptsUs / 1000);
  }
  /** wallMs ≈ ptsUs / 1000 + offsetMs (+ the unobservable part of the delay, see DEVICE_LATENCY_MS) */
  get offsetMs(): number | null {
    return this.win.min();
  }
}

/** Freeze a take's clock mapping this long after its first frame: the window then spans t0 − 2 s … t0 + 3 s. */
export const CLOCK_SETTLE_US = 3_000_000;

/** Ping mapping of the capture helper's QPC clock to wall ms: the sample with the smallest round trip wins. */
export function bestClockOffset(samples: ReadonlyArray<{ sentMs: number; recvMs: number; remoteNs: number }>): number | null {
  let best: { rtt: number; offset: number } | null = null;
  for (const s of samples) {
    const rtt = s.recvMs - s.sentMs;
    if (rtt < 0 || !Number.isFinite(rtt)) continue;
    if (!best || rtt < best.rtt) best = { rtt, offset: (s.sentMs + s.recvMs) / 2 - s.remoteNs / 1e6 };
  }
  return best?.offset ?? null;
}

// ---------------------------------------------------------------- track offsets

/**
 * The part of the phone's capture → PC arrival delay the minimum filter cannot see (hardware encoder + USB,
 * typically 15–50 ms). Assuming the high end errs toward PC audio lagging the picture, which viewers
 * tolerate far better than audio leading it (ITU-R BT.1359: ~45 ms lead vs ~125 ms lag detectability).
 */
export const DEVICE_LATENCY_MS = 35;
/** Anything beyond this is a clock glitch, not a real start skew: such a track is left unaligned. */
export const MAX_OFFSET_SEC = 60;

export type TrackKey = 'device' | 'mic' | 'system' | 'camera';

export interface AlignmentInput {
  /** device pts of the first written video frame (video t=0) */
  videoT0Us: number | null;
  /** device pts of the first written device-audio frame (same clock as video → exact) */
  deviceAudioT0Us?: number | null;
  /** DeviceClock.offsetMs at the take's settle point */
  devToWallMs?: number | null;
  latencyMs?: number;
  /** helper QPC → wall mapping (bestClockOffset) */
  qpcToWallMs?: number | null;
  /** helper WAV start times (QPC ns) */
  helperStartNs?: Partial<Record<'mic' | 'system', number | null>>;
  /** renderer MediaRecorder start times (wall ms) */
  rendererStartWallMs?: Partial<Record<'camera' | 'mic', number | null>>;
}

const sec = (v: number): number => Math.round(v * 1e6) / 1e6;

export function computeTrackOffsets(i: AlignmentInput): Partial<Record<TrackKey, number>> {
  const out: Partial<Record<TrackKey, number>> = {};
  if (i.videoT0Us === null || !Number.isFinite(i.videoT0Us)) return out;
  const put = (k: TrackKey, v: number) => {
    if (Number.isFinite(v) && Math.abs(v) <= MAX_OFFSET_SEC && out[k] === undefined) out[k] = sec(v);
  };
  if (i.deviceAudioT0Us != null) put('device', (i.deviceAudioT0Us - i.videoT0Us) / 1e6);
  if (i.devToWallMs == null) return out; // PC tracks need the phone → PC mapping
  // capture time (PC wall) of the first frame = arrival estimate − the delay the filter cannot observe
  const videoT0Wall = i.videoT0Us / 1000 + i.devToWallMs - (i.latencyMs ?? DEVICE_LATENCY_MS);
  if (i.qpcToWallMs != null) {
    for (const k of ['mic', 'system'] as const) {
      const ns = i.helperStartNs?.[k];
      if (ns != null) put(k, (ns / 1e6 + i.qpcToWallMs - videoT0Wall) / 1000);
    }
  }
  for (const k of ['camera', 'mic'] as const) {
    const wall = i.rendererStartWallMs?.[k];
    if (wall != null) put(k, (wall - videoT0Wall) / 1000); // a helper mic, when present, already won
  }
  return out;
}

// ---------------------------------------------------------------- raw PCM → WAV

/**
 * Where a raw PCM packet lands in a gap-free WAV timeline anchored at `t0Us`: silence to insert first (the
 * phone stopped delivering audio, e.g. Android 11 with the screen locked) or leading frames to drop (it
 * overlaps what is already written). Timestamp jitter below the tolerance is ignored, so the sample count
 * drives the timeline and steady streams never click; absurd jumps (clock reset) are not filled.
 */
export function placePcm(writtenFrames: number, ptsUs: number, t0Us: number, frames: number, rate: number, opts: { toleranceFrames?: number; maxGapFrames?: number } = {}): { silence: number; skip: number } {
  const tol = opts.toleranceFrames ?? Math.round(rate / 50); // 20 ms
  const maxGap = opts.maxGapFrames ?? rate * 600; // 10 min
  const expected = Math.round(((ptsUs - t0Us) * rate) / 1e6);
  const delta = expected - writtenFrames;
  if (delta > tol && delta <= maxGap) return { silence: delta, skip: 0 };
  if (delta < -tol) return { silence: 0, skip: Math.min(frames, -delta) };
  return { silence: 0, skip: 0 };
}

/** Canonical 44-byte PCM WAV header. */
export function wavHeader(dataBytes: number, rate: number, channels: number, bitsPerSample = 16): Uint8Array {
  const h = new Uint8Array(44);
  const dv = new DataView(h.buffer);
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) h[o + i] = s.charCodeAt(i); };
  const block = channels * (bitsPerSample / 8);
  const data = Math.min(dataBytes, 0xffffffff - 36);
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * block, true);
  dv.setUint16(32, block, true);
  dv.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  dv.setUint32(40, data, true);
  return h;
}

/**
 * Size fields of a WAV whose writer died before its last header update (any RIFF layout: PCM, float, the
 * extensible fmt + fact chunks NAudio writes). Returns the little-endian u32 patches to apply, or null when
 * the header is already consistent or the file is not a WAV we can reason about.
 */
export function wavSizeFix(head: Uint8Array, fileSize: number): Array<{ offset: number; value: number }> | null {
  const tag = (o: number) => String.fromCharCode(...head.subarray(o, o + 4));
  if (head.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let block = 1;
  for (let o = 12; o + 8 <= head.byteLength;) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ' && o + 22 <= head.byteLength) block = Math.max(1, dv.getUint16(o + 20, true));
    if (id === 'data') {
      const start = o + 8;
      if (fileSize < start) return null;
      const actual = Math.min(Math.floor((fileSize - start) / block) * block, 0xffffffff - start);
      const riff = start + actual - 8;
      const patches = [
        ...(dv.getUint32(4, true) !== riff ? [{ offset: 4, value: riff }] : []),
        ...(size !== actual ? [{ offset: o + 4, value: actual }] : []),
      ];
      return patches.length ? patches : null;
    }
    o += 8 + size + (size & 1); // RIFF chunks are word-aligned
  }
  return null;
}

// ---------------------------------------------------------------- adb discovery

export type AdbSource = 'env' | 'bundled' | 'sdk' | 'path' | 'downloaded';

export interface AdbLookup {
  platform: string;
  env: Record<string, string | undefined>;
  /** resources/bin/<platform>-<arch> of a packaged build */
  bundledDir?: string | null;
  /** userData/bin/platform-tools (on-demand download) */
  downloadDir: string;
  exists: (p: string) => boolean;
}

/**
 * Candidates in preference order. A user's own adb (SDK or PATH) beats the downloaded copy: two adb versions
 * on one machine keep killing each other's server ("adb server version doesn't match this client").
 */
export function adbCandidates(l: AdbLookup): Array<{ path: string; source: AdbSource }> {
  const win = l.platform === 'win32';
  const p = win ? win32 : posix;
  const exe = win ? 'adb.exe' : 'adb';
  const out: Array<{ path: string; source: AdbSource }> = [];
  if (l.env.RECORDER_ADB) out.push({ path: l.env.RECORDER_ADB, source: 'env' });
  if (l.bundledDir) out.push({ path: p.join(l.bundledDir, exe), source: 'bundled' });
  const home = l.env.HOME ?? l.env.USERPROFILE;
  const sdks = [
    l.env.ANDROID_HOME,
    l.env.ANDROID_SDK_ROOT,
    win && l.env.LOCALAPPDATA ? p.join(l.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
    l.platform === 'darwin' && home ? p.join(home, 'Library', 'Android', 'sdk') : undefined,
    l.platform === 'linux' && home ? p.join(home, 'Android', 'Sdk') : undefined,
  ];
  for (const sdk of sdks) if (sdk) out.push({ path: p.join(sdk, 'platform-tools', exe), source: 'sdk' });
  const pathVar = l.env.PATH ?? l.env.Path ?? '';
  for (const dir of pathVar.split(win ? ';' : ':')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (d) out.push({ path: p.join(d, exe), source: 'path' });
  }
  out.push({ path: p.join(l.downloadDir, exe), source: 'downloaded' });
  return out;
}

export function findAdb(l: AdbLookup): { path: string; source: AdbSource } | null {
  return adbCandidates(l).find((c) => l.exists(c.path)) ?? null;
}

/** Google's always-latest platform-tools archive for this OS (null where Google ships none). */
export function platformToolsUrl(platform: string): string | null {
  const os = ({ win32: 'windows', darwin: 'darwin', linux: 'linux' } as Record<string, string>)[platform];
  return os ? `https://dl.google.com/android/repository/platform-tools-latest-${os}.zip` : null;
}

// ---------------------------------------------------------------- recording state machine

export type RecPhase = 'idle' | 'starting' | 'recording' | 'finalizing';
export type RecEvent = 'start' | 'started' | 'stop' | 'done' | 'failed';

const TRANSITIONS: Record<RecPhase, Partial<Record<RecEvent, RecPhase>>> = {
  idle: { start: 'starting' },
  // a stop during start (unplug while the helper spins up) finalises once start has settled
  starting: { started: 'recording', stop: 'finalizing', failed: 'idle' },
  recording: { stop: 'finalizing' },
  finalizing: { done: 'idle', failed: 'idle' },
};

/** Next phase, or null when the event does not apply (e.g. a second stop while finalising: idempotent). */
export function transition(phase: RecPhase, ev: RecEvent): RecPhase | null {
  return TRANSITIONS[phase][ev] ?? null;
}

// ---------------------------------------------------------------- crash journal

export const LOCK_FILE = 'recording.lock';
export const JOURNAL_FILE = 'android.json';

/** recording.lock of a device take (desktop takes have no `kind`, and no segments.json is written for ours) */
export function androidLock(serial: string, pid: number, now = new Date()): string {
  return JSON.stringify({ kind: 'android', pid, serial, startedAt: now.toISOString() });
}
export function isAndroidLock(text: string): boolean {
  try {
    return (JSON.parse(text) as { kind?: unknown })?.kind === 'android';
  } catch {
    return false;
  }
}

const Num = z.number().finite();
/** bundle-relative media file: a tampered journal must not point outside the bundle */
const MediaFile = z.string().regex(/^media\/[\w.-]+$/).refine((f) => !f.includes('..'));
const HelperTrack = z.object({ file: MediaFile, startNs: Num }).nullable();
const RendererTrack = z.object({ file: MediaFile, startWallMs: Num.nullable() }).nullable();

/** android.json: everything finalisation needs, kept current while recording (atomic rewrites). */
export const AndroidJournalSchema = z.object({
  v: z.literal(1),
  device: z.string().max(200),
  serial: z.string().max(200),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive().max(240),
  startedAt: z.string(),
  video: z.object({ file: MediaFile, t0Us: Num.nullable(), lastUs: Num.nullable() }),
  deviceAudio: z.object({ file: MediaFile, t0Us: Num, rate: z.number().int().positive(), channels: z.number().int().min(1).max(8) }).nullable(),
  clock: z.object({ devToWallMs: Num.nullable(), latencyMs: Num, qpcToWallMs: Num.nullable(), settled: z.boolean() }),
  helper: z.object({ mic: HelperTrack, system: HelperTrack }).nullable(),
  renderer: z.object({ camera: RendererTrack, mic: RendererTrack }),
});
export type AndroidJournal = z.infer<typeof AndroidJournalSchema>;

export function journalOffsets(j: AndroidJournal): Partial<Record<TrackKey, number>> {
  return computeTrackOffsets({
    videoT0Us: j.video.t0Us,
    deviceAudioT0Us: j.deviceAudio?.t0Us ?? null,
    devToWallMs: j.clock.devToWallMs,
    latencyMs: j.clock.latencyMs,
    qpcToWallMs: j.clock.qpcToWallMs,
    helperStartNs: { mic: j.helper?.mic?.startNs ?? null, system: j.helper?.system?.startNs ?? null },
    rendererStartWallMs: { camera: j.renderer.camera?.startWallMs ?? null, mic: j.renderer.mic?.startWallMs ?? null },
  });
}

/** Video duration known from the journal (the remuxed file's own duration is preferred when readable). */
export function journalDurationSec(j: AndroidJournal): number {
  if (j.video.t0Us === null || j.video.lastUs === null) return 0;
  return Math.max(0, (j.video.lastUs - j.video.t0Us) / 1e6) + 1 / j.fps;
}
