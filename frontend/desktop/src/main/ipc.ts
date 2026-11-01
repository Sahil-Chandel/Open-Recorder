/**
 * IPC registration: every invoke channel from the contract is validated with zod before reaching a handler.
 * Unknown channels are impossible (preload allow-list) and invalid payloads are rejected with a clear error.
 */
import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { INVOKE, type InvokeChannel } from '../shared/ipc';
import { areaDone, selectArea } from './area';
import { abortExport, beginExport, finishExport, writeExport } from './exportSink';
import { helper } from './helper';
import { hotkeyStatus } from './hotkeys';
import { logFilePath, logger } from './log';
import { openPermissionSettings, permissionStatus } from './permissions';
import { deletePreset, exportPresetFile, importPresetFile, listPresets, materializePreset, savePreset, setDefaultPreset } from './presets';
import {
  allowRoot,
  extractSources,
  importAsset,
  importVideo,
  listProjects,
  openProject,
  listCache,
  readCache,
  renameProject,
  saveProjectAs,
  trashProjects,
  writeCache,
  writeProject,
} from './projects';
import {
  cameraChunk,
  cameraDone,
  cameraStarted,
  countdownDone,
  discardRecording,
  findInterrupted,
  openTeleprompter,
  pauseRecording,
  recState,
  restartRecording,
  restoreInterrupted,
  resumeRecording,
  startRecording,
  stopRecording,
  toggleMicMute,
  toggleKeyCapture,
} from './recording';
import { settings } from './settings';
import { openEditor, openRecorder, openWindow } from './windows';

type Handler = (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;
const extra = new Map<InvokeChannel, Handler>();
/**
 * Feature modules (asr, android, cloud…) register their handlers here. Lookup happens per call, so modules
 * that register after an await (e.g. the packaged updater overriding app:checkUpdates) still take effect.
 */
export function addHandler(ch: InvokeChannel, h: Handler): void {
  extra.set(ch, h);
}

const senderWin = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);

export function registerIpc(): void {
  const h: Partial<Record<InvokeChannel, Handler>> = {
    'app:info': () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron, helper: helper.info, helperState: helper.state }),
    'app:openExternal': (_e, url: string) => {
      if (!/^https?:\/\//.test(url)) throw new Error('only http(s) links');
      return shell.openExternal(url);
    },
    'app:showItemInFolder': (_e, p: string) => shell.showItemInFolder(p),
    'app:openPath': (_e, p: string) => shell.openPath(p),
    'app:openLogs': () => shell.showItemInFolder(logFilePath()),
    // base answer; packaged builds with an update feed register the real updater over it (updater.ts)
    'app:checkUpdates': () => ({ configured: false, current: app.getVersion() }),
    'app:copyFileToClipboard': async (_e, p: string) => {
      if (process.platform === 'win32') return helper.call('copyFileToClipboard', { path: p });
      const { clipboard } = await import('electron');
      (clipboard as unknown as { writeBuffer: (f: string, b: Buffer) => void }).writeBuffer('public.file-url', Buffer.from(`file://${encodeURI(p)}`));
      return { ok: true };
    },
    'settings:get': () => settings.get(),
    'settings:set': (_e, patch: Record<string, unknown>) => settings.set(patch),
    'hotkeys:status': () => hotkeyStatus(),
    'devices:displays': () => helper.call('listDisplays'),
    'devices:windows': () => helper.call('listWindows', { excludePids: [process.pid] }),
    'devices:windowThumbnail': (_e, id: string) => helper.call('windowThumbnail', { id }),
    'devices:audioInputs': () => helper.call('listAudioInputs'),
    'devices:audioOutputs': () => helper.call('listAudioOutputs'),
    'devices:audioApps': () => helper.call('listAudioApps'),
    'devices:startLevels': (_e, o: { micId?: string; outputId?: string }) => helper.call('startLevels', o),
    'devices:stopLevels': () => helper.call('stopLevels'),
    'permissions:status': () => permissionStatus(),
    'permissions:open': (_e, k) => openPermissionSettings(k),
    'helper:status': () => ({ state: helper.state, info: helper.info }),
    'rec:start': (_e, input) => startRecording(input),
    'rec:pause': () => pauseRecording(),
    'rec:resume': () => resumeRecording(),
    'rec:stop': () => stopRecording(),
    'rec:restart': () => restartRecording(),
    'rec:discard': () => discardRecording(),
    'rec:status': () => recState(),
    'rec:toggleMicMute': () => toggleMicMute(),
    'rec:toggleKeyCapture': () => toggleKeyCapture(),
    'rec:cameraChunk': (_e, data) => cameraChunk(data),
    'rec:cameraStarted': (_e, wall: number) => cameraStarted(wall),
    'rec:cameraDone': () => cameraDone(),
    'area:select': () => selectArea(),
    'area:done': (_e, a) => areaDone(a),
    'countdown:done': () => countdownDone(),
    'win:open': (_e, name: string, q?: Record<string, string>) => {
      if (name === 'recorder') return void openRecorder();
      if (name === 'teleprompter') return void openTeleprompter();
      if (name === 'editor' && q?.dir) return void openEditor(q.dir);
      if (name === 'settings') return void openWindow('settings', { width: 760, height: 620, frame: false, resizable: true, minWidth: 640, minHeight: 520, ...(q ? { query: q } : {}) });
      if (name === 'library') return void openWindow('library', { width: 1080, height: 720, frame: false, minWidth: 720, minHeight: 480 });
      if (name === 'onboarding') return void openWindow('onboarding', { width: 640, height: 560, frame: false, resizable: false });
      return undefined;
    },
    'win:close': (e) => senderWin(e)?.close(),
    'win:minimize': (e) => senderWin(e)?.minimize(),
    'win:setSize': (e, w: number, hgt: number) => senderWin(e)?.setSize(Math.round(w), Math.round(hgt)),
    'projects:list': () => listProjects(),
    'projects:open': (_e, dir: string) => openProject(dir),
    'projects:save': (_e, dir: string, project) => {
      allowRoot(dir);
      writeProject(dir, project);
      return { ok: true, savedAt: new Date().toISOString() };
    },
    'projects:saveAs': (_e, dir: string, project) => saveProjectAs(dir, project),
    'projects:rename': (_e, dir: string, name: string) => renameProject(dir, name),
    'projects:delete': (_e, dirs: string[]) => trashProjects(dirs),
    'projects:import': () => importVideo(),
    'projects:extract': (_e, dir: string) => extractSources(dir),
    'projects:writeCache': (_e, dir: string, name: string, data) => writeCache(dir, name, data instanceof Uint8Array ? data : new Uint8Array(data)),
    'projects:readCache': (_e, dir: string, name: string) => readCache(dir, name),
    'projects:listCache': (_e, dir: string, prefix: string) => listCache(dir, prefix),
    'projects:importAsset': (_e, dir: string, kind: string) => importAsset(dir, kind),
    'projects:restorePending': () => findInterrupted(),
    'projects:restore': async (_e, dir: string) => {
      const d = await restoreInterrupted(dir);
      openEditor(d);
      return d;
    },
    'export:chooseDir': async (e, def?: string) => {
      const w = senderWin(e);
      const opts = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>, defaultPath: def ?? settings.get().general.exportDir };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return null;
      allowRoot(r.filePaths[0]); // a folder the user picked may receive exports
      return r.filePaths[0];
    },
    'export:begin': (_e, o) => beginExport(o),
    'export:writeText': async (_e, name: string, text: string) => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const dir = settings.get().general.exportDir;
      mkdirSync(dir, { recursive: true });
      const p = (await import('node:path')).join(dir, name.replace(/[<>:"/\\|?*]/g, '_'));
      writeFileSync(p, text, 'utf8');
      return p;
    },
    'export:write': (_e, id: number, pos: number, data) => writeExport(id, pos, data),
    'export:finish': (_e, id: number) => finishExport(id),
    'export:abort': (_e, id: number) => abortExport(id),
    'presets:list': () => listPresets(),
    'presets:save': (_e, p, projectDir?: string) => savePreset(p, projectDir),
    'presets:materialize': (_e, id: string, projectDir: string) => {
      const p = listPresets().find((x) => x.id === id);
      if (!p) throw new Error('Preset not found');
      return materializePreset(p, projectDir);
    },
    'presets:delete': (_e, id: string) => deletePreset(id),
    'presets:setDefault': (_e, id: string | null) => setDefaultPreset(id),
    'presets:import': () => importPresetFile(),
    'presets:export': (_e, id: string) => exportPresetFile(id),
    'dialog:openFile': async (e, filters: Electron.FileFilter[]) => {
      const w = senderWin(e);
      const opts = { properties: ['openFile'] as Array<'openFile'>, filters };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return null;
      return { path: r.filePaths[0], text: /\.(srt|vtt|json|txt)$/i.test(r.filePaths[0]) ? await readFile(r.filePaths[0], 'utf8') : undefined };
    },
  };
  for (const ch of Object.keys(INVOKE) as InvokeChannel[]) {
    const schema = INVOKE[ch];
    ipcMain.handle(ch, async (e, ...args: unknown[]) => {
      const fn = extra.get(ch) ?? h[ch];
      if (!fn) throw new Error(`${ch} is not available in this build`);
      const parsed = schema ? schema.safeParse(args) : { success: true as const, data: [] as unknown[] };
      if (!parsed.success) {
        logger.warn('ipc.invalid', { ch, issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`) });
        throw new Error(`Invalid arguments for ${ch}`);
      }
      try {
        return await fn(e, ...(parsed.data as unknown[]));
      } catch (err) {
        // being offline is an expected condition, not an app failure
        if ((err as Error)?.name === 'CloudUnreachableError') logger.warn('ipc.handler.offline', { ch, message: (err as Error).message });
        else logger.error('ipc.handler', err, { ch });
        throw err;
      }
    });
  }
}
