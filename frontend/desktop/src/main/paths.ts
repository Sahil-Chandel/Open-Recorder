import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Dev builds keep all app data inside the repo (RECORDER_DATA_DIR) — nothing is written elsewhere. */
export function configurePaths(): void {
  const dataDir = process.env.RECORDER_DATA_DIR;
  if (dataDir) {
    app.setPath('userData', join(dataDir, 'userData'));
    app.setPath('logs', join(dataDir, 'logs'));
    app.setPath('crashDumps', join(dataDir, 'crashDumps'));
    app.setPath('sessionData', join(dataDir, 'session'));
  }
}

export const defaultSaveDir = (): string =>
  process.env.RECORDER_DATA_DIR ? join(process.env.RECORDER_DATA_DIR, 'Recordings') : join(app.getPath('videos'), 'Open-Recorder');
export const defaultExportDir = (): string =>
  process.env.RECORDER_DATA_DIR ? join(process.env.RECORDER_DATA_DIR, 'Exports') : join(app.getPath('videos'), 'Open-Recorder', 'Exports');

/** Bundled binaries (helper, ffmpeg, adb, whisper) — resources/bin/<os>-<arch> when packaged. */
export function binPath(name: string): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates: string[] = [];
  if (app.isPackaged) candidates.push(join(process.resourcesPath, 'bin', `${process.platform}-${process.arch}`, exe));
  const repo = resolve(app.getAppPath(), '..', '..');
  if (name === 'win-helper') {
    candidates.push(join(repo, 'backend', 'native', 'win-helper', 'bin', 'Release', 'net8.0-windows10.0.22621.0', exe));
    candidates.push(join(repo, 'backend', 'native', 'win-helper', 'bin', 'Debug', 'net8.0-windows10.0.22621.0', exe));
  }
  if (name === 'mac-helper') candidates.push(join(repo, 'backend', 'native', 'mac-helper', '.build', 'release', exe));
  candidates.push(join(repo, '.cache', 'bin', exe));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** ffmpeg: bundled → repo cache → PATH. */
export const ffmpegPath = (): string => process.env.RECORDER_FFMPEG || binPath('ffmpeg') || 'ffmpeg';
export const modelsDir = (): string => join(app.getPath('userData'), 'models');