/**
 * Auto-update (task 14.3) via electron-updater (generic provider; staged rollout with `stagingPercentage`
 * in latest.yml, delta updates via blockmaps). Only active in signed, packaged builds.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addHandler } from './ipc';
import { logger } from './log';
import { broadcast } from './windows';

export async function registerUpdater(): Promise<void> {
  // the feed URL is baked into packaged builds by electron-builder (publish.url → app-update.yml);
  // dev builds use cloud.ts's notify-only /updates/latest check instead
  if (!app.isPackaged) return;
  // no feed configured at build time (electron-builder `publish`) → keep the base "not configured" answer
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return;
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.logger = { info: (m: unknown) => logger.info('updater', { m: String(m) }), warn: (m: unknown) => logger.warn('updater', { m: String(m) }), error: (m: unknown) => logger.error('updater', m), debug: () => undefined } as never;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', (i) => broadcast('notify', { kind: 'info', message: `Update ${i.version} is ready — it installs when you quit.` }));
  addHandler('app:checkUpdates', async () => {
    const r = await autoUpdater.checkForUpdates();
    const latest = r?.updateInfo.version ?? app.getVersion();
    const newer = latest !== app.getVersion();
    broadcast('notify', { kind: 'info', message: newer ? `Downloading version ${latest}…` : 'You are on the latest version' });
    return { current: app.getVersion(), latest, newer };
  });
  setTimeout(() => void autoUpdater.checkForUpdatesAndNotify().catch((e: Error) => logger.warn('updater.check', { message: e.message })), 15000);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), 6 * 3600 * 1000).unref();
}