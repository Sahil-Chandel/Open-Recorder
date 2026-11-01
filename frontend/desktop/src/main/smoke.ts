/**
 * Headless smoke mode (RECORDER_SMOKE=<dir>): windows stay hidden, no tray / global hotkeys are installed,
 * each window is rendered to PNG via capturePage (only our own pages — never the desktop), console errors
 * are collected, then the app quits. Used by the e2e smoke script and CI.
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { helper } from './helper';

export const SMOKE_DIR = process.env.RECORDER_SMOKE || '';
export const isSmoke = (): boolean => SMOKE_DIR !== '';

const consoleLog: Array<{ window: string; level: number; message: string }> = [];

export function watchConsole(name: string, win: BrowserWindow): void {
  if (!isSmoke()) return;
  win.webContents.on('console-message', (e) => {
    const ev = e as unknown as { level: number | string; message: string };
    const level = typeof ev.level === 'number' ? ev.level : ev.level === 'error' ? 3 : ev.level === 'warning' ? 2 : 1;
    if (level >= 2 || String(ev.message).startsWith('SMOKE')) consoleLog.push({ window: name, level, message: String(ev.message).slice(0, 500) });
  });
}

/**
 * `until` keeps the app alive past `waitMs` until the collected console says the run is complete (e.g. the
 * GIF export finished — ffmpeg's palette pass outlives a fixed wait), bounded by `maxWaitMs`.
 */
export async function runSmoke(open: Array<() => BrowserWindow>, waitMs = 6000, until?: (log: typeof consoleLog) => boolean, maxWaitMs = 120000): Promise<void> {
  mkdirSync(SMOKE_DIR, { recursive: true });
  const wins = open.map((f) => f());
  await new Promise((r) => setTimeout(r, waitMs));
  for (const t0 = Date.now(); until && !until(consoleLog) && Date.now() - t0 < maxWaitMs; ) await new Promise((r) => setTimeout(r, 500));
  const shots: string[] = [];
  for (const [i, w] of wins.entries()) {
    if (w.isDestroyed()) continue;
    const img = await w.webContents.capturePage();
    const name = `${i}-${new URL(w.webContents.getURL()).hash.replace(/[^\w-]/g, '_') || 'page'}.png`;
    writeFileSync(join(SMOKE_DIR, name), img.toPNG());
    shots.push(name);
  }
  writeFileSync(join(SMOKE_DIR, 'smoke.json'), JSON.stringify({ helper: helper.state, helperInfo: helper.info, shots, console: consoleLog }, null, 2));
  app.exit(0);
}