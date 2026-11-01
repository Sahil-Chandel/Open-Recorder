/**
 * Vocal enhancement on this computer (AUD-05): the studio-voice ffmpeg chain — high-pass, spectral denoise,
 * de-ess, presence EQ, compressor and −16 LUFS loudness — written to cache/mic.enhanced.wav with exactly the
 * input's length, so it stays sample-aligned with the video. Nothing is uploaded.
 */
import { BrowserWindow } from 'electron';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { addHandler } from './ipc';
import { logger } from './log';
import { allowRoot, ffprobeJson, runFfmpeg } from './projects';

const log = logger.child('vocal');

export const VOCAL_CHAIN = [
  'highpass=f=80',
  'afftdn=nr=18:nf=-38:tn=1',
  'deesser=i=0.4:m=0.5:f=0.5',
  'equalizer=f=200:t=q:w=1:g=-2',
  'equalizer=f=3500:t=q:w=1.2:g=3',
  'acompressor=threshold=-20dB:ratio=3:attack=10:release=200:makeup=2',
  'loudnorm=I=-16:TP=-1.5:LRA=11',
].join(',');

export const ENHANCED_FILE = 'cache/mic.enhanced.wav';

export async function enhanceVoice(dir: string, micRel: string, onProgress: (p: number) => void): Promise<{ file: string }> {
  if (micRel.includes('..') || /^([\\/]|[a-z]:)/i.test(micRel)) throw new Error('invalid track path');
  allowRoot(dir);
  const input = join(dir, micRel);
  const dur = Number((await ffprobeJson(input)).format.duration ?? 0);
  if (!(dur > 0)) throw new Error('The microphone track is empty');
  mkdirSync(join(dir, 'cache'), { recursive: true });
  const out = join(dir, ENHANCED_FILE);
  const tmp = `${out}.part.wav`;
  const t0 = Date.now();
  await runFfmpeg(
    ['-i', input, '-af', `${VOCAL_CHAIN},aresample=48000,apad,atrim=end_sample=${Math.round(dur * 48000)}`, '-ar', '48000', '-c:a', 'pcm_s16le', tmp],
    (sec) => onProgress(Math.min(0.99, sec / dur)),
  );
  renameSync(tmp, out); // the editor only ever sees a complete file
  log.info('vocal.done', { durationSec: Math.round(dur), ms: Date.now() - t0 });
  onProgress(1);
  return { file: ENHANCED_FILE };
}

export function registerVocal(): void {
  addHandler('audio:enhanceVoice', (e, dir: string, micRel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return enhanceVoice(dir, micRel, (progress) => win?.webContents.send('audio:progress', { progress }));
  });
}
