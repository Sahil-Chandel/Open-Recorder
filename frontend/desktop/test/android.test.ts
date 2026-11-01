import { describe, expect, it } from 'vitest';
import {
  adbCandidates,
  androidLock,
  AndroidJournalSchema,
  avcCodec,
  bestClockOffset,
  computeTrackOffsets,
  DEVICE_LATENCY_MS,
  DeviceClock,
  findAdb,
  isAndroidLock,
  journalDurationSec,
  journalOffsets,
  MAX_OFFSET_SEC,
  parseAdbDevices,
  parsePacketHeader,
  placePcm,
  platformToolsUrl,
  RAW_AUDIO_CODEC,
  scrcpyServerArgs,
  SlidingMin,
  transition,
  wavHeader,
  wavSizeFix,
  type AndroidJournal,
} from '../src/main/androidSync';

const header = (ptsUs: bigint, size: number, flags: { config?: boolean; key?: boolean } = {}) => {
  const b = new Uint8Array(12);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, ptsUs | (flags.config ? 1n << 63n : 0n) | (flags.key ? 1n << 62n : 0n));
  dv.setUint32(8, size);
  return b;
};

const journal = (over: Partial<AndroidJournal> = {}): AndroidJournal => ({
  v: 1, device: 'Pixel 8', serial: 'R58M', width: 1080, height: 2400, fps: 60, startedAt: '2026-10-30T10:00:00.000Z',
  video: { file: 'media/screen.frag.mp4', t0Us: 10_000_000, lastUs: 20_000_000 },
  deviceAudio: { file: 'media/device.wav', t0Us: 9_700_000, rate: 48000, channels: 2 },
  clock: { devToWallMs: 1_000_000, latencyMs: 35, qpcToWallMs: 500_000, settled: true },
  helper: { mic: { file: 'media/mic.wav', startNs: 509_000_000_000 }, system: { file: 'media/system.wav', startNs: 509_000_000_000 } },
  renderer: { camera: { file: 'media/camera_000.webm', startWallMs: 1_010_200 }, mic: null },
  ...over,
});

describe('scrcpy server options', () => {
  it('asks for a key frame every second and raw device audio (A/V alignment, C31b)', () => {
    const a = scrcpyServerArgs('R58M', { scid: '0badc0de', audio: true });
    expect(a.slice(0, 3)).toEqual(['-s', 'R58M', 'shell']);
    expect(a).toContain('com.genymobile.scrcpy.Server');
    expect(a).toContain('3.3.3');
    expect(a).toContain('scid=0badc0de');
    expect(a).toContain('video_codec_options=i-frame-interval:int=1');
    expect(a).toContain('audio=true');
    expect(a).toContain('audio_codec=raw');
    expect(a).toContain('tunnel_forward=true');
    expect(a).toContain('send_dummy_byte=true');
  });

  it('disables audio below Android 11 and clamps fps / bitrate / key-frame interval', () => {
    const a = scrcpyServerArgs('emulator-5554', { scid: '00000001', audio: false, maxFps: 500, bitrate: 1, keyFrameIntervalSec: 0.2 });
    expect(a).toContain('audio=false');
    expect(a.some((x) => x.startsWith('audio_codec'))).toBe(false);
    expect(a).toContain('max_fps=120');
    expect(a).toContain('video_bit_rate=500000');
    expect(a).toContain('video_codec_options=i-frame-interval:int=1');
    expect(scrcpyServerArgs('x', { scid: '00000001', audio: true, maxFps: 30, bitrate: 4_000_000 })).toContain('max_fps=30');
  });

  it('rejects socket ids scrcpy cannot parse', () => {
    expect(() => scrcpyServerArgs('x', { scid: 'zz', audio: true })).toThrow(/scid/);
    expect(() => scrcpyServerArgs('x', { scid: 'ffffffff', audio: true })).toThrow(/scid/); // > 31 bits
    expect(() => scrcpyServerArgs('x', { scid: '0BADC0DE', audio: true })).toThrow(/scid/);
  });

  it('parses frame headers: config / key flags and 62-bit pts', () => {
    expect(parsePacketHeader(header(123_456_789n, 4096, { key: true }))).toEqual({ config: false, key: true, ptsUs: 123_456_789, size: 4096 });
    expect(parsePacketHeader(header(0n, 30, { config: true }))).toMatchObject({ config: true, key: false, size: 30 });
    const big = (1n << 61n) + 5n;
    expect(parsePacketHeader(header(big, 1)).ptsUs).toBe(Number(big));
    // a header sliced out of a larger socket buffer (non-zero byteOffset)
    const buf = new Uint8Array(20);
    buf.set(header(42n, 7), 5);
    expect(parsePacketHeader(buf.subarray(5, 17))).toMatchObject({ ptsUs: 42, size: 7 });
    expect(() => parsePacketHeader(new Uint8Array(4))).toThrow();
    expect(RAW_AUDIO_CODEC).toBe(0x00726177);
  });

  it('derives the avc1 codec string from the SPS', () => {
    expect(avcCodec(new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac]))).toBe('avc1.64002a');
    expect(avcCodec(new Uint8Array([0, 0, 1, 0x68, 1, 2, 3]))).toBe('avc1.640028'); // PPS only → default
    expect(avcCodec(null)).toBe('avc1.640028');
  });
});

describe('adb', () => {
  it('parses `adb devices -l` incl. daemon chatter, unauthorized and network devices', () => {
    const out = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'R58M123ABC             device usb:1-1 product:o1sxeea model:SM_G991B device:o1s transport_id:3',
      '192.168.1.5:5555       unauthorized transport_id:4',
      'emulator-5554\tdevice product:sdk_gphone64 model:sdk_gphone64_x86_64 device:emu64x transport_id:1',
      '',
    ].join('\r\n');
    expect(parseAdbDevices(out)).toEqual([
      { serial: 'R58M123ABC', state: 'device', model: 'SM G991B', product: 'o1sxeea', transport: '3' },
      { serial: '192.168.1.5:5555', state: 'unauthorized', model: '', product: '', transport: '4' },
      { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64', product: 'sdk_gphone64', transport: '1' },
    ]);
    expect(parseAdbDevices('List of devices attached\n\n')).toEqual([]);
  });

  const lookup = (files: string[], env: Record<string, string | undefined> = {}, platform = 'win32') => ({
    platform,
    env,
    bundledDir: null as string | null,
    downloadDir: platform === 'win32' ? 'C:\\Users\\u\\AppData\\Roaming\\desktop\\bin\\platform-tools' : '/home/u/.config/desktop/bin/platform-tools',
    exists: (p: string) => files.includes(p),
  });

  it('prefers an explicit override, then bundled, the SDK, PATH and finally the downloaded copy', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PATH: 'C:\\Windows;"C:\\Tools\\adb dir";' };
    const dl = 'C:\\Users\\u\\AppData\\Roaming\\desktop\\bin\\platform-tools\\adb.exe';
    const sdk = 'C:\\Users\\u\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
    const onPath = 'C:\\Tools\\adb dir\\adb.exe';
    expect(findAdb(lookup([dl], env))).toEqual({ path: dl, source: 'downloaded' });
    expect(findAdb(lookup([dl, onPath], env))).toEqual({ path: onPath, source: 'path' }); // quoted PATH entry
    expect(findAdb(lookup([dl, onPath, sdk], env))).toEqual({ path: sdk, source: 'sdk' });
    expect(findAdb(lookup([dl, sdk], { ...env, RECORDER_ADB: 'D:\\adb.exe' }))?.source).toBe('sdk'); // override must exist
    expect(findAdb(lookup(['D:\\adb.exe', sdk], { ...env, RECORDER_ADB: 'D:\\adb.exe' }))).toEqual({ path: 'D:\\adb.exe', source: 'env' });
    const bundled = { ...lookup(['C:\\app\\resources\\bin\\win32-x64\\adb.exe', sdk], env), bundledDir: 'C:\\app\\resources\\bin\\win32-x64' };
    expect(findAdb(bundled)?.source).toBe('bundled');
    expect(findAdb(lookup([], env))).toBeNull();
  });

  it('uses POSIX paths and ":" PATH separators on macOS / Linux', () => {
    const c = adbCandidates(lookup([], { HOME: '/Users/u', PATH: '/usr/local/bin:/opt/homebrew/bin' }, 'darwin'));
    expect(c.map((x) => x.path)).toEqual([
      '/Users/u/Library/Android/sdk/platform-tools/adb',
      '/usr/local/bin/adb',
      '/opt/homebrew/bin/adb',
      '/home/u/.config/desktop/bin/platform-tools/adb',
    ]);
    expect(adbCandidates(lookup([], { HOME: '/home/u', Path: '/usr/bin' }, 'linux')).map((x) => x.path)).toContain('/home/u/Android/Sdk/platform-tools/adb');
  });

  it('knows Google’s platform-tools archive per OS', () => {
    expect(platformToolsUrl('win32')).toBe('https://dl.google.com/android/repository/platform-tools-latest-windows.zip');
    expect(platformToolsUrl('darwin')).toBe('https://dl.google.com/android/repository/platform-tools-latest-darwin.zip');
    expect(platformToolsUrl('linux')).toBe('https://dl.google.com/android/repository/platform-tools-latest-linux.zip');
    expect(platformToolsUrl('freebsd')).toBeNull();
  });
});

describe('clock mapping', () => {
  it('SlidingMin keeps the minimum of the last window', () => {
    const m = new SlidingMin(10);
    expect(m.min()).toBeNull();
    m.push(0, 5);
    m.push(1, 3);
    m.push(2, 4);
    expect(m.min()).toBe(3);
    m.push(12, 9); // window is now [2, 12]: t=1 (3) ages out, t=2 (4) sits on the edge and stays
    expect(m.min()).toBe(4);
    m.push(13, 8);
    expect(m.min()).toBe(8);
    m.push(14, 1);
    expect(m.min()).toBe(1);
  });

  it('SlidingMin is linear: a million pushes stay fast and compact', () => {
    const m = new SlidingMin(5000);
    const t0 = performance.now();
    for (let i = 0; i < 1_000_000; i++) m.push(i * 16.7, 100 + ((i * 7919) % 50));
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(m.min()).toBe(100);
  });

  it('DeviceClock: minimum transport delay wins over jitter, and old samples age out (drift)', () => {
    const c = new DeviceClock(5000);
    const offset = 1_700_000_000_000; // wall ms at device pts 0
    for (let i = 0; i < 300; i++) {
      const ptsUs = 50_000_000 + i * 16_667;
      const delay = 8 + ((i * 37) % 40); // 8..47 ms transport delay
      c.observe(ptsUs, offset + ptsUs / 1000 + delay);
    }
    expect(c.offsetMs).toBeCloseTo(offset + 8, 2); // wall-clock ms at 1.7e12 carry ~2e-4 ms of float noise
    // 10 s later the clocks drifted by 20 ms: the window follows instead of keeping the stale minimum
    for (let i = 0; i < 300; i++) {
      const ptsUs = 60_000_000 + i * 16_667;
      c.observe(ptsUs, offset + 20 + ptsUs / 1000 + 12 + (i % 5));
    }
    expect(c.offsetMs).toBeCloseTo(offset + 32, 2);
  });

  it('bestClockOffset picks the ping with the smallest round trip', () => {
    expect(bestClockOffset([])).toBeNull();
    const off = bestClockOffset([
      { sentMs: 1000, recvMs: 1010, remoteNs: 990e6 }, // rtt 10
      { sentMs: 2000, recvMs: 2002, remoteNs: 1995e6 }, // rtt 2 → offset 2001 − 1995 = 6
      { sentMs: 3000, recvMs: 2999, remoteNs: 0 }, // clock went backwards: ignored
    ]);
    expect(off).toBeCloseTo(6, 9);
  });
});

describe('track offsets (source.trackOffsets convention: + = starts after video t=0)', () => {
  it('device audio is exact (same phone clock), PC tracks go through both clock mappings', () => {
    const o = journalOffsets(journal());
    // device audio started 0.3 s before the first written frame
    expect(o.device).toBe(-0.3);
    // video t0 capture wall = 10 000 ms + 1 000 000 − 35 = 1 009 965 ms; helper start wall = 509 000 ms + 500 000 = 1 009 000
    expect(o.mic).toBeCloseTo(-0.965, 6);
    expect(o.system).toBeCloseTo(-0.965, 6);
    expect(o.camera).toBeCloseTo(0.235, 6);
  });

  it('a later latency estimate moves PC tracks later relative to the picture', () => {
    const base = computeTrackOffsets({ videoT0Us: 0, devToWallMs: 1000, latencyMs: 0, rendererStartWallMs: { camera: 1000 } });
    const later = computeTrackOffsets({ videoT0Us: 0, devToWallMs: 1000, latencyMs: 50, rendererStartWallMs: { camera: 1000 } });
    expect(base.camera).toBe(0);
    expect(later.camera).toBeCloseTo(0.05, 9);
    expect(computeTrackOffsets({ videoT0Us: 0, devToWallMs: 1000, rendererStartWallMs: { camera: 1000 } }).camera).toBeCloseTo(DEVICE_LATENCY_MS / 1000, 9);
  });

  it('omits what cannot be aligned instead of guessing', () => {
    expect(computeTrackOffsets({ videoT0Us: null, deviceAudioT0Us: 5 })).toEqual({});
    expect(computeTrackOffsets({ videoT0Us: 0, deviceAudioT0Us: 1_000_000, devToWallMs: null, rendererStartWallMs: { camera: 5 } })).toEqual({ device: 1 });
    expect(computeTrackOffsets({ videoT0Us: 0, devToWallMs: 0, qpcToWallMs: null, helperStartNs: { mic: 1e9 } })).toEqual({});
    // clock glitch: a minute+ of skew is not a real start offset
    expect(computeTrackOffsets({ videoT0Us: 0, devToWallMs: 0, latencyMs: 0, rendererStartWallMs: { camera: (MAX_OFFSET_SEC + 1) * 1000 } })).toEqual({});
  });

  it('the helper mic wins over a renderer mic, offsets are rounded to µs', () => {
    const o = computeTrackOffsets({
      videoT0Us: 0, devToWallMs: 0, latencyMs: 0, qpcToWallMs: 0,
      helperStartNs: { mic: 123_456_789 }, rendererStartWallMs: { mic: 999 },
    });
    expect(o.mic).toBe(0.123457); // 123.456789 ms
    const r = journalOffsets(journal({ helper: null, renderer: { camera: null, mic: { file: 'media/mic.webm', startWallMs: 1_009_965.5 } } }));
    expect(r.mic).toBe(0.0005);
    expect(r.system).toBeUndefined();
  });

  it('duration from the journal covers the last frame', () => {
    expect(journalDurationSec(journal())).toBeCloseTo(10 + 1 / 60, 9);
    expect(journalDurationSec(journal({ video: { file: 'media/screen.frag.mp4', t0Us: null, lastUs: null } }))).toBe(0);
  });
});

describe('device audio placement (raw PCM → gap-free WAV)', () => {
  const rate = 48000;

  it('contiguous packets and small jitter append as-is', () => {
    expect(placePcm(0, 0, 0, 240, rate)).toEqual({ silence: 0, skip: 0 });
    expect(placePcm(240, 5_000 + 3_000, 0, 240, rate)).toEqual({ silence: 0, skip: 0 }); // 3 ms late: jitter
    expect(placePcm(240, 5_000 - 3_000, 0, 240, rate)).toEqual({ silence: 0, skip: 0 }); // 3 ms early: jitter
  });

  it('a pause in the phone’s audio becomes silence, an overlap is trimmed', () => {
    expect(placePcm(48_000, 1_500_000, 0, 240, rate)).toEqual({ silence: 24_000, skip: 0 });
    expect(placePcm(48_000, 900_000, 0, 240, rate)).toEqual({ silence: 0, skip: 240 });
    expect(placePcm(48_000, 999_000, 0, 240, rate)).toEqual({ silence: 0, skip: 0 });
    expect(placePcm(48_000, 990_000, 0, 960, rate)).toEqual({ silence: 0, skip: 0 }); // 10 ms: within tolerance
    expect(placePcm(48_000, 970_000, 0, 960, rate)).toEqual({ silence: 0, skip: 960 }); // 30 ms overlap, capped at the packet
  });

  it('does not fill absurd jumps (clock reset)', () => {
    expect(placePcm(0, 3_600_000_000, 0, 240, rate)).toEqual({ silence: 0, skip: 0 });
  });

  it('a simulated stream with jitter and a 0.5 s dropout stays on its timestamps', () => {
    let written = 0;
    const t0 = 7_000_000;
    let pts = t0;
    for (let i = 0; i < 2000; i++) {
      if (i === 1000) pts += 500_000; // phone stopped sending audio for half a second
      const jitterMs = ((i * 13) % 7) - 3; // ±3 ms of timestamp jitter
      const { silence, skip } = placePcm(written, pts + jitterMs * 1000, t0, 240, rate);
      written += silence + (240 - skip);
      pts += 5_000;
    }
    const expected = ((pts - t0) * rate) / 1e6;
    expect(Math.abs(written - expected)).toBeLessThan(rate * 0.021);
  });
});

describe('WAV headers', () => {
  it('writes a canonical 44-byte PCM header', () => {
    const h = wavHeader(192_000, 48000, 2);
    const dv = new DataView(h.buffer);
    const tag = (o: number) => String.fromCharCode(...h.subarray(o, o + 4));
    expect(h.byteLength).toBe(44);
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(dv.getUint32(4, true)).toBe(36 + 192_000);
    expect(dv.getUint16(20, true)).toBe(1);
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint32(24, true)).toBe(48000);
    expect(dv.getUint32(28, true)).toBe(192_000);
    expect(dv.getUint16(32, true)).toBe(4);
    expect(dv.getUint32(40, true)).toBe(192_000);
  });

  it('repairs stale sizes after a crash, whole frames only', () => {
    const h = wavHeader(0, 48000, 2);
    expect(wavSizeFix(h, 44 + 1000 * 4 + 3)).toEqual([{ offset: 4, value: 36 + 4000 }, { offset: 40, value: 4000 }]);
    expect(wavSizeFix(wavHeader(4000, 48000, 2), 44 + 4000)).toBeNull(); // clean file: untouched
    expect(wavSizeFix(new Uint8Array(44), 1000)).toBeNull(); // not a WAV
  });

  it('handles NAudio-style float files (extensible fmt + fact chunk) and odd chunk padding', () => {
    const parts: number[] = [];
    const ascii = (s: string) => parts.push(...[...s].map((c) => c.charCodeAt(0)));
    const u32 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    const u16 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff);
    ascii('RIFF'); u32(0); ascii('WAVE');
    ascii('fmt '); u32(40); u16(0xfffe); u16(2); u32(48000); u32(384000); u16(8); u16(32); parts.push(...new Array(24).fill(0));
    ascii('junk'); u32(3); parts.push(1, 2, 3, 0); // odd size + pad byte
    ascii('fact'); u32(4); u32(0);
    ascii('data'); u32(0);
    const head = new Uint8Array(parts);
    const dataStart = head.byteLength;
    const fix = wavSizeFix(head, dataStart + 8 * 100 + 5);
    expect(fix).toEqual([{ offset: 4, value: dataStart + 800 - 8 }, { offset: dataStart - 4, value: 800 }]);
  });
});

describe('recording state machine', () => {
  it('walks idle → starting → recording → finalizing → idle', () => {
    expect(transition('idle', 'start')).toBe('starting');
    expect(transition('starting', 'started')).toBe('recording');
    expect(transition('recording', 'stop')).toBe('finalizing');
    expect(transition('finalizing', 'done')).toBe('idle');
  });

  it('stop is idempotent and a stop during start still finalises', () => {
    expect(transition('finalizing', 'stop')).toBeNull();
    expect(transition('idle', 'stop')).toBeNull();
    expect(transition('starting', 'stop')).toBe('finalizing');
    expect(transition('finalizing', 'started')).toBeNull(); // a late "started" cannot resurrect the take
    expect(transition('starting', 'failed')).toBe('idle');
    expect(transition('recording', 'start')).toBeNull();
  });
});

describe('crash journal', () => {
  it('round-trips through the schema', () => {
    const j = journal();
    expect(AndroidJournalSchema.parse(JSON.parse(JSON.stringify(j)))).toEqual(j);
  });

  it('rejects media paths outside the bundle', () => {
    for (const file of ['../../evil.mp4', 'C:\\x.mp4', 'media/../x.mp4', '/etc/passwd', 'media/sub/x.mp4']) {
      expect(AndroidJournalSchema.safeParse({ ...journal(), video: { file, t0Us: 0, lastUs: 0 } }).success).toBe(false);
    }
  });

  it('tells device locks from screen-recording locks', () => {
    expect(isAndroidLock(androidLock('R58M', 1234, new Date('2026-10-30T00:00:00Z')))).toBe(true);
    expect(JSON.parse(androidLock('R58M', 1234))).toMatchObject({ kind: 'android', pid: 1234, serial: 'R58M' });
    expect(isAndroidLock(JSON.stringify({ pid: 1, startedAt: 'x', t0Ns: 5 }))).toBe(false);
    expect(isAndroidLock('not json')).toBe(false);
    expect(isAndroidLock('null')).toBe(false);
  });
});
