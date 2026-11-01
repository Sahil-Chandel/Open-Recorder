/**
 * Dev/test fixture: a synthetic project (ffmpeg test pattern + tone + camera pattern + scripted telemetry)
 * so the editor and export can be exercised end-to-end without capturing anyone's real screen.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySocialTarget, autoZooms, createProject, detectTypingBursts, encodeCursorSamples, socialTarget } from '@rec/shared';
import { allowRoot, makeThumbnail, runFfmpeg, uniqueDir, writeProject } from './projects';
import { h264Args } from './h264';
import { settings } from './settings';

/** Windows SAPI text-to-speech → WAV, so captions / Smart Cut can be tested on real speech. */
async function speechTrack(out: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const text = 'Hello, um, this is a quick test of the recorder. Uh, we are checking automatic captions and smart cut.';
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.SetOutputToWaveFile('${out.replace(/'/g, "''")}'); $s.Speak('${text}'); $s.Dispose()`;
  return new Promise((res) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    p.on('exit', (c) => res(c === 0));
    p.on('error', () => res(false));
  });
}

export async function createFixture(seconds = 12): Promise<string> {
  const dir = uniqueDir(settings.get().general.saveDir, 'Fixture');
  for (const d of ['media', 'events', 'cache']) mkdirSync(join(dir, d), { recursive: true });
  allowRoot(dir);
  const W = 1920, H = 1080, fps = 30;
  await runFfmpeg(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${fps}:duration=${seconds}`, ...(await h264Args(18)), '-g', String(fps), join(dir, 'media', 'screen.mp4')]);
  if (!(await speechTrack(join(dir, 'cache', 'tts.wav')))) {
    await runFfmpeg(['-f', 'lavfi', '-i', `aevalsrc=0.3*sin(2*PI*220*t)*lt(mod(t\\,3)\\,2):s=48000:d=${seconds}`, '-ac', '2', '-c:a', 'pcm_f32le', join(dir, 'media', 'mic.wav')]);
  } else {
    // speech starts at 0.5 s, padded/trimmed to the video length
    await runFfmpeg(['-i', join(dir, 'cache', 'tts.wav'), '-af', `adelay=500|500,apad,atrim=0:${seconds}`, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_f32le', join(dir, 'media', 'mic.wav')]);
  }
  await runFfmpeg(['-f', 'lavfi', '-i', `testsrc=size=640x480:rate=30:duration=${seconds}`, ...(await h264Args(22)), join(dir, 'media', 'camera.mp4')]);
  // telemetry: 120 Hz cursor tracing a figure-eight, clicks, a shortcut and a typing burst
  const cursor: Array<{ tNs: number; x: number; y: number; shape: number }> = [];
  for (let i = 0; i < seconds * 120; i++) {
    const t = i / 120;
    cursor.push({ tNs: t * 1e9, x: W * (0.5 + 0.3 * Math.sin(t * 0.8)), y: H * (0.5 + 0.25 * Math.sin(t * 1.6)), shape: t > 8 && t < 11 ? 1 : 0 });
  }
  writeFileSync(join(dir, 'events', 'cursor.bin'), encodeCursorSamples(cursor));
  const at = (t: number) => cursor[Math.min(cursor.length - 1, Math.round(t * 120))]!;
  const clicks = [2, 2.6, 6.5].flatMap((t) => [
    { t: t * 1e9, x: at(t).x, y: at(t).y, button: 'left', phase: 'down' },
    { t: (t + 0.08) * 1e9, x: at(t).x, y: at(t).y, button: 'left', phase: 'up' },
  ]);
  writeFileSync(join(dir, 'events', 'clicks.jsonl'), clicks.map((c) => JSON.stringify(c)).join('\n'));
  const keys = [{ t: 5e9, code: 'KeyS', mods: ['Ctrl'], phase: 'down', printable: false }];
  for (let i = 0; i < 16; i++) keys.push({ t: (8 + i * 0.18) * 1e9, mods: [], phase: 'down', printable: true } as never);
  writeFileSync(join(dir, 'events', 'keys.jsonl'), keys.map((k) => JSON.stringify(k)).join('\n'));
  const segments = [{ file: 'media/screen.mp4', startNs: 0, durationNs: seconds * 1e9 }];
  const p = createProject('Fixture', {
    kind: 'display', width: W, height: H, fps, scaleFactor: 1, segments,
    tracks: { screen: 'media/screen.mp4', mic: 'media/mic.wav', camera: 'media/camera.mp4' },
    hasTelemetry: true, durationSec: seconds, trackOffsets: { camera: 0 },
  });
  const nClicks = clicks.filter((c) => c.phase === 'down').map((c) => ({ ...c, t: c.t / 1e9, x: c.x / W, y: c.y / H, button: 'left' as const, phase: 'down' as const }));
  const nKeys = keys.map((k) => ({ ...k, t: k.t / 1e9 })) as never;
  p.zooms = autoZooms(nClicks, detectTypingBursts(nKeys, nClicks), { duration: seconds });
  p.annotations.push({ id: 'ann_fixture', type: 'text', start: 1, end: 5, lane: 0, space: 'canvas', rect: { x: 0.3, y: 0.06, w: 0.4, h: 0.1 }, rotation: 0, anim: { in: 'fade', out: 'fade', durSec: 0.3 }, text: 'Fixture title', style: { preset: 'outline', font: 'Inter', size: 72, color: '#ffd23f', color2: '#000000', bold: true, italic: false, underline: false, align: 'center' } });
  p.annotations.push({ id: 'ann_spot', type: 'spotlight', start: 6, end: 9, lane: 1, space: 'content', rect: { x: 0.4, y: 0.35, w: 0.25, h: 0.25 }, rotation: 0, anim: { in: 'fade', out: 'fade', durSec: 0.3 }, opacity: 0.6, feather: 0.3, softness: 1 });
  // smoke hook: preview the fixture framed for a social target (e.g. RECORDER_SMOKE_TARGET=youtube-shorts)
  const target = socialTarget(process.env.RECORDER_SMOKE_TARGET);
  if (target) applySocialTarget(target, p.canvas, { sourceAspect: W / H, hasCamera: false });
  writeProject(dir, p);
  await makeThumbnail(dir, join(dir, 'media', 'screen.mp4'), 1);
  return dir;
}
