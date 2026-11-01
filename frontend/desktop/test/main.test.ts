import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_RECORD_SHORTCUTS, migrateSettings, platformMod } from '../src/main/settingsMigrations';
import { findExe } from '../src/main/whisperBin';
import { rendererUrl } from '../src/main/rendererUrl';
import { APP_ID } from '../src/shared/project';

// scratch space stays inside the repo (.cache/), never the system temp dir
const tmp = resolve(__dirname, '../../../.cache/test-tmp/main');

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('settings migrations', () => {
  it('replaces the old Ctrl+Shift record shortcuts but keeps user-chosen ones', () => {
    const raw = { shortcuts: { record: { newRecording: 'CommandOrControl+Shift+N', fullScreen: 'F9', pauseResume: 'CommandOrControl+Shift+P' } } };
    expect(migrateSettings(raw)).toBe(true);
    expect(raw.shortcuts.record.newRecording).toBe(DEFAULT_RECORD_SHORTCUTS.newRecording);
    expect(raw.shortcuts.record.pauseResume).toBe(DEFAULT_RECORD_SHORTCUTS.pauseResume);
    expect(raw.shortcuts.record.fullScreen).toBe('F9');
    expect(migrateSettings(raw)).toBe(false); // idempotent
  });

  it('never defaults to Ctrl/⌘+Shift combos and avoids ⌥⇧ on macOS', () => {
    for (const v of Object.values(DEFAULT_RECORD_SHORTCUTS)) expect(v).not.toMatch(/^CommandOrControl\+Shift/);
    expect(platformMod('darwin')).toBe('Command+Alt');
    expect(platformMod('win32')).toBe('Alt+Shift');
    expect(new Set(Object.values(DEFAULT_RECORD_SHORTCUTS)).size).toBe(Object.keys(DEFAULT_RECORD_SHORTCUTS).length);
  });

  it('tolerates files without shortcuts', () => {
    expect(migrateSettings({})).toBe(false);
    expect(migrateSettings({ shortcuts: {} })).toBe(false);
  });
});

describe('media info without ffprobe', () => {
  it('reads duration, codecs, size and fps from ffmpeg -i output', async () => {
    const { parseFfmpegInfo } = await import('../src/main/mediaInfo');
    const info = parseFfmpegInfo([
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
      '  Duration: 00:01:12.50, start: 0.000000, bitrate: 2674 kb/s',
      '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709/bt709/iec61966-2-1, progressive), 1280x720 [SAR 1:1 DAR 16:9], 2481 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)',
      '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 192 kb/s (default)',
      'At least one output file must be specified',
    ].join('\n'));
    expect(Number(info.format.duration)).toBeCloseTo(72.5);
    expect(info.streams).toHaveLength(2);
    expect(info.streams[0]).toMatchObject({ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '29970/1000' });
    expect(info.streams[1]).toMatchObject({ codec_type: 'audio', codec_name: 'aac' });
  });

  it('copes with WebM from MediaRecorder (no duration) and audio-only WAV', async () => {
    const { parseFfmpegInfo } = await import('../src/main/mediaInfo');
    const webm = parseFfmpegInfo("Input #0, matroska,webm, from 'cam.webm':\n  Duration: N/A, start: 0.000000, bitrate: N/A\n  Stream #0:0(eng): Video: vp9 (Profile 0), yuv420p(tv), 1280x720, SAR 1:1 DAR 16:9, 30 fps, 30 tbr, 1k tbn (default)");
    expect(webm.format.duration).toBeUndefined();
    expect(webm.streams[0]).toMatchObject({ codec_name: 'vp9', width: 1280, height: 720 });
    const wav = parseFfmpegInfo("Input #0, wav, from 'mic.wav':\n  Duration: 00:00:03.00, bitrate: 1536 kb/s\n  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 48000 Hz, 2 channels, s16, 1536 kb/s");
    expect(Number(wav.format.duration)).toBe(3);
    expect(wav.streams).toEqual([{ codec_type: 'audio', codec_name: 'pcm_s16le' }]);
  });
});

describe('whisper binary lookup', () => {
  it('prefers whisper-cli over the deprecated main stub regardless of directory order', () => {
    const dir = join(tmp, 'whisper-a');
    mkdirSync(join(dir, 'Release'), { recursive: true });
    writeFileSync(join(dir, 'Release', 'main.exe'), '');
    writeFileSync(join(dir, 'Release', 'whisper-cli.exe'), '');
    expect(findExe(dir, 'win32')).toBe(join(dir, 'Release', 'whisper-cli.exe'));
  });

  it('falls back to main for old archives and returns null when nothing is there', () => {
    const dir = join(tmp, 'whisper-b');
    mkdirSync(dir, { recursive: true });
    expect(findExe(dir, 'win32')).toBeNull();
    writeFileSync(join(dir, 'main.exe'), '');
    expect(findExe(dir, 'win32')).toBe(join(dir, 'main.exe'));
    expect(findExe(join(tmp, 'missing'), 'win32')).toBeNull();
  });
});

describe('packaged app identity', () => {
  const yml = readFileSync(resolve(__dirname, '../electron-builder.yml'), 'utf8');
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { name: string; productName?: string };

  // the runtime name picks the data folder and the single-instance lock; the installed app once shared both
  // with `npm run dev` ("desktop") and quit at launch whenever a dev build was running
  it('gives the installed app its own name, distinct from dev builds', () => {
    const productName = /^productName: (\S+)\s*$/m.exec(yml)?.[1];
    const injected = /^extraMetadata:\s*\n\s+productName: (\S+)\s*$/m.exec(yml)?.[1];
    expect(productName).toBe('Open-Recorder');
    expect(injected).toBe(productName);
    expect(pkg.productName).toBeUndefined(); // dev builds keep package.json's name
    expect(pkg.name).not.toBe(injected);
  });

  it('uses the installer appId as the Windows AppUserModelID', () => {
    expect(/^appId: (\S+)\s*$/m.exec(yml)?.[1]).toBe(APP_ID);
  });
});

describe('renderer URLs', () => {
  it('keeps install paths with "#", "%" and spaces intact', () => {
    const html = resolve('/', 'Users', 'Ravi #1', '50% off', 'Open-Recorder', 'index.html');
    const url = new URL(rendererUrl(html, 'editor', { dir: 'D:\\My Videos\\a#b.recproj' }));
    expect(fileURLToPath(url)).toBe(html);
    expect(url.hash).toBe(`#/editor?${new URLSearchParams({ dir: 'D:\\My Videos\\a#b.recproj' })}`);
    expect(new URLSearchParams(url.hash.split('?')[1]).get('dir')).toBe('D:\\My Videos\\a#b.recproj');
  });

  it('uses the dev server when there is one', () => {
    expect(rendererUrl('/x/index.html', 'recorder', {}, 'http://localhost:5173')).toBe('http://localhost:5173/index.html#/recorder');
    expect(rendererUrl('/x/index.html', 'recorder', { meters: '0' }, 'http://localhost:5173')).toBe('http://localhost:5173/index.html#/recorder?meters=0');
  });
});
