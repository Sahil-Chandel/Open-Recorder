/**
 * Feature modules that register extra IPC handlers (captions/ASR, Android, local vocal enhancement, updater).
 * Each phase adds its module here; ipc.ts picks the handlers up via addHandler().
 */
import { BrowserWindow } from 'electron';
import { addHandler } from './ipc';
import { ensureModel } from './models';
import { registerAsr } from './asr';
import { registerAndroid } from './android';
import { registerUpdater } from './updater';
import { registerVocal } from './vocal';
import { openEditor } from './windows';

export function registerFeatureModules(): void {
  registerAsr();
  registerAndroid();
  registerVocal();
  void registerUpdater(); // packaged builds with an update feed override the base app:checkUpdates
  addHandler('projects:sample', async () => {
    const { createFixture } = await import('./fixture');
    const dir = await createFixture(12);
    openEditor(dir);
    return dir;
  });
  addHandler('models:ensure', (e, name: string) => ensureModel(name, (p) => BrowserWindow.fromWebContents(e.sender)?.webContents.send('asr:progress', { model: name, progress: p })));
}