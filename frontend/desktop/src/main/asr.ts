/**
 * Local ASR (tasks 10.1/10.2, CAP-01): whisper.cpp CLI downloaded on demand into userData/bin (Windows x64
 * release zip; macOS/Linux use a bundled or PATH `whisper-cli`), quantised ggml models (Nano/Basic/Pro ≈
 * tiny/base/small). Word-level timestamps via --max-len 1 --split-on-word; filler biasing prompt (§6.11).
 * Child process per job → crash-isolated, cancellable.
 */
import { app, BrowserWindow, net } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fillerPrompt, type CaptionWord } from '@rec/shared';
import { addHandler } from './ipc';
import { logger } from './log';
import { ensureModel } from './models';
import { allowRoot, runFfmpeg } from './projects';
import { findExe } from './whisperBin';

const log = logger.child('asr');
const PINNED_RELEASE = 'b5454';
/** SHA-256 of whisper-bin-x64.zip in PINNED_RELEASE (GitHub asset digest, verified 2026-10-30). */
const PINNED_ZIP_SHA256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb';

async function fileSha256(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function binDir(): string {
  const d = join(app.getPath('userData'), 'bin', 'whisper');
  mkdirSync(d, { recursive: true });
  return d;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'Open-Recorder' } });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

export async function ensureWhisper(): Promise<string> {
  const env = process.env.RECORDER_WHISPER;
  if (env && existsSync(env)) return env;
  const dir = binDir();
  const found = findExe(dir);
  if (found) return found;
  if (process.platform !== 'win32') return 'whisper-cli'; // macOS/Linux: bundled in resources or on PATH
  // Pinned release first (known CLI flags); the newest release is only a fallback if the pinned asset is gone.
  const zip = join(dir, 'whisper.zip');
  const pinned = `https://github.com/ggml-org/whisper.cpp/releases/download/${PINNED_RELEASE}/whisper-bin-x64.zip`;
  // executables are only unpacked after their SHA-256 matches the published digest
  try {
    log.info('asr.binary.download', { url: pinned });
    await download(pinned, zip);
    if ((await fileSha256(zip)) !== PINNED_ZIP_SHA256) throw new Error('speech engine download is corrupted (checksum mismatch)');
  } catch (e) {
    log.warn('asr.binary.pinnedFailed', { message: (e as Error).message });
    const rel = (await (await net.fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10', { headers: { 'User-Agent': 'Open-Recorder' } })).json()) as Array<{ assets: Array<{ name: string; browser_download_url: string; digest?: string }> }>;
    const asset = rel.flatMap((r) => r.assets).find((a) => a.name === 'whisper-bin-x64.zip' && a.digest?.startsWith('sha256:'));
    if (!asset) throw new Error('No verified Windows build of the speech engine is available right now. Please try again later.');
    log.info('asr.binary.download', { url: asset.browser_download_url });
    await download(asset.browser_download_url, zip);
    if ((await fileSha256(zip)) !== asset.digest!.slice(7)) throw new Error('Speech engine download is corrupted (checksum mismatch). Please try again.');
  }
  await new Promise<void>((res, rej) => {
    const p = spawn('tar', ['-xf', zip, '-C', dir], { windowsHide: true });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`unzip failed (${c})`))));
    p.on('error', rej);
  });
  const exe = findExe(dir);
  if (!exe) throw new Error('whisper binary not found in release archive');
  return exe;
}

export interface TranscribeArgs { dir: string; model: 'nano' | 'basic' | 'pro'; language: string; files: string[] }
export interface TranscribeResult { language: string; words: CaptionWord[]; durationSec: number }

const running = new Map<number, ReturnType<typeof spawn>>();

export async function transcribe(args: TranscribeArgs, progress: (p: number, stage: string) => void): Promise<TranscribeResult> {
  allowRoot(args.dir);
  progress(0.01, 'Preparing speech engine');
  const exe = await ensureWhisper();
  const model = await ensureModel(`whisper-${args.model}`, (p) => progress(0.02 + p * 0.18, 'Downloading model'));
  // mix the requested tracks → 16 kHz mono WAV
  const wav = join(args.dir, 'cache', 'asr-16k.wav');
  const inputs = args.files.flatMap((f) => ['-i', join(args.dir, f)]);
  const filter = args.files.length > 1 ? ['-filter_complex', `amix=inputs=${args.files.length}:normalize=0`] : [];
  await runFfmpeg([...inputs, ...filter, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const outBase = join(args.dir, 'cache', 'asr');
  const lang = args.language === 'auto' ? 'auto' : args.language.startsWith('zh') ? 'zh' : args.language;
  const threads = Math.max(2, Math.min(8, (await import('node:os')).cpus().length - 1));
  const cli = ['-m', model.path, '-f', wav, '-l', lang, '-t', String(threads), '-ml', '1', '-sow', '-oj', '-of', outBase, '-pp', ...(fillerPrompt(args.language) ? ['--prompt', fillerPrompt(args.language)] : [])];
  progress(0.2, 'Transcribing');
  await new Promise<void>((res, rej) => {
    const p = spawn(exe, cli, { windowsHide: true });
    const id = p.pid ?? Date.now();
    running.set(id, p);
    let err = '';
    const onData = (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-3000);
      const m = /progress\s*=\s*(\d+)%/.exec(s);
      if (m) progress(0.2 + (Number(m[1]) / 100) * 0.78, 'Transcribing');
    };
    p.stderr.on('data', onData);
    p.stdout.on('data', onData);
    p.on('error', rej);
    p.on('exit', (code) => {
      running.delete(id);
      code === 0 ? res() : rej(new Error(`whisper exited ${code}: ${err.split('\n').slice(-3).join(' ')}`));
    });
  });
  const json = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as {
    result?: { language?: string };
    transcription: Array<{ offsets: { from: number; to: number }; text: string }>;
  };
  const words: CaptionWord[] = [];
  for (const seg of json.transcription) {
    const w = seg.text.trim();
    if (!w || /^\[.*\]$/.test(w) || /^\(.*\)$/.test(w)) continue; // [BLANK_AUDIO], (music)
    words.push({ w, start: seg.offsets.from / 1000, end: Math.max(seg.offsets.to, seg.offsets.from + 50) / 1000 });
  }
  progress(1, 'Done');
  const durationSec = statSync(wav).size / 32000;
  log.info('asr.done', { words: words.length, model: args.model, lang: json.result?.language ?? lang });
  return { language: json.result?.language ?? lang, words, durationSec };
}

export function registerAsr(): void {
  addHandler('asr:transcribe', (e, args: TranscribeArgs) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return transcribe(args, (p, stage) => win?.webContents.send('asr:progress', { progress: p, stage }));
  });
  addHandler('asr:models', () => ({ installed: existsSync(binDir()) ? Boolean(findExe(binDir())) : false }));
  addHandler('asr:download', async (_e, m: 'nano' | 'basic' | 'pro') => {
    await ensureWhisper();
    return ensureModel(`whisper-${m}`);
  });
}
