/**
 * Electron main entry: single instance, custom protocols, settings, logging, helper supervisor,
 * tray, hotkeys, IPC, crash recovery.
 */
import { app, BrowserWindow, dialog, session } from 'electron';
import { configurePaths } from './paths';

configurePaths(); // must run before anything touches app paths

import { initLogging, logger } from './log';
import { settings } from './settings';
import { helper } from './helper';
import { registerIpc } from './ipc';
import { registerMediaProtocol, registerMediaSchemePrivileges } from './projects';
import { registerHotkeys } from './hotkeys';
import { pauseRecording, recEvents, recState, toggleKeyCapture, restoreDesktop, resumeRecording, startRecording, stopRecording, findInterrupted, restoreInterrupted } from './recording';
import { updateTray } from './tray';
import { broadcast, getWin, openEditor, openRecorder, openWindow } from './windows';
import { selectArea } from './area';
import { registerFeatureModules } from './features';
import type { RecState } from '../shared/ipc';
import { isSmoke, runSmoke } from './smoke';
import { preferDiscreteGpu } from './gpu';
import { APP_ID } from '../shared/project';

initLogging();
registerMediaSchemePrivileges();
preferDiscreteGpu(); // dual-GPU laptops: Chromium switch, must be set before ready
// same AppUserModelID as the installer's shortcuts, so Windows groups and pins the running app with them
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) {
  // another instance with the same data folder is running; it comes to the front via 'second-instance'
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // double-clicking a .recproj while the app runs opens it in the editor
    const project = argv.find((a) => a.endsWith('.recproj'));
    if (project) return void openEditor(project);
    showApp();
  });
  void main();
}

function openOnboarding(): BrowserWindow {
  return openWindow('onboarding', { width: 640, height: 560, frame: false, resizable: false });
}

/** Launching the app again (or a Dock click) brings it to the front — also when its windows are hidden. */
function showApp(): void {
  // while recording the recorder stays hidden (it would be in the video); only the control bar is offered
  const st = recState().state;
  if (st !== 'idle' && st !== 'error') return void getWin('controlbar')?.show();
  const editor = getWin('editor');
  if (!editor) return void (settings.get().onboardingDone ? openRecorder() : openOnboarding());
  if (editor.isMinimized()) editor.restore();
  editor.show();
  editor.focus();
}

/** Devices for tray/hotkey recordings: exactly what the recorder window would use. */
function quickDevices(s: ReturnType<typeof settings.get>) {
  const d = s.devices;
  return {
    camera: { enabled: d.cameraEnabled, ...(d.cameraId ? { deviceId: d.cameraId } : {}) },
    mic: { enabled: d.micEnabled, ...(d.micId ? { deviceId: d.micId } : {}) },
    systemAudio: { enabled: d.systemAudioEnabled, ...(d.outputId ? { deviceId: d.outputId } : {}), ...(d.appPid ? { appPid: d.appPid } : {}) },
    zoomMode: s.record.zoomMode,
  };
}

async function quickRecord(mode: 'display' | 'window' | 'area'): Promise<void> {
  const s = settings.get();
  try {
    if (mode === 'area') {
      const area = await selectArea();
      if (!area) return;
      await startRecording({
        mode: 'area', displayId: area.displayId, area, // helper display is resolved from the area in startRecording
        ...quickDevices(s),
      });
    } else if (mode === 'window') {
      // an open recorder gets the intent as a message; a new one reads it from its URL once mounted
      const existing = getWin('recorder');
      if (existing) {
        openRecorder();
        existing.webContents.send('hotkey', 'pickWindow');
      } else openRecorder({ query: { pick: 'window' } });
    } else {
      const displays = (await helper.call<Array<{ id: string; primary: boolean }>>('listDisplays')) ?? [];
      const d = displays.find((x) => x.primary) ?? displays[0];
      if (!d) throw new Error('No display found');
      await startRecording({
        mode: 'display', displayId: d.id,
        ...quickDevices(s),
      });
    }
  } catch (e) {
    logger.error('quickRecord', e, { mode });
    dialog.showErrorBox('Could not start recording', (e as Error).message);
  }
}

const trayActions = {
  quick: (m: 'display' | 'window' | 'area') => void quickRecord(m),
  stop: () => void stopRecording(),
  pauseResume: () => void (recState().state === 'paused' ? resumeRecording() : pauseRecording()),
};

function applyHotkeys(): void {
  const st0 = recState().state;
  registerHotkeys(settings.get().shortcuts.record, (a) => {
    const st = recState().state;
    if (a === 'finish') return void stopRecording();
    if (a === 'pauseResume') return trayActions.pauseResume();
    if (a === 'pauseKeys') return void toggleKeyCapture();
    if (st === 'recording' || st === 'paused') return;
    if (a === 'newRecording') return void openRecorder();
    if (a === 'fullScreen') return void quickRecord('display');
    if (a === 'custom') return void quickRecord('area');
    if (a === 'window') return void quickRecord('window');
  }, st0 === 'recording' || st0 === 'paused');
}

async function main(): Promise<void> {
  await app.whenReady();
  const s = settings.load();
  logger.info('app.start', { version: app.getVersion(), name: app.getName(), packaged: app.isPackaged, platform: process.platform, arch: process.arch });
  // strict CSP for every renderer response (task 0.2)
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const csp = [
      "default-src 'self' rec-media:",
      "script-src 'self' 'wasm-unsafe-eval'" + (process.env.ELECTRON_RENDERER_URL ? " 'unsafe-inline'" : ''),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: rec-media: https:",
      "media-src 'self' blob: rec-media: mediastream:",
      "connect-src 'self' rec-media: blob: data: http://localhost:* https: ws://localhost:*",
      "worker-src 'self' blob:",
      "font-src 'self' data:",
    ].join('; ');
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  // media permissions: only for our own app pages
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
    const own = wc.getURL().startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://');
    cb(own && ['media', 'clipboard-sanitized-write', 'fullscreen'].includes(perm));
  });
  registerMediaProtocol();
  registerFeatureModules();
  registerIpc();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.general.launchAtLogin });

  helper.on('state', (st) => broadcast('helper:state', st));
  helper.on('notification', (method: string, params: unknown) => {
    if (method === 'levels') broadcast('rec:levels', params);
    else if (method === 'diskLow') {
      broadcast('notify', { kind: 'warning', message: 'Disk space is low' });
      if ((params as { action?: string })?.action === 'stop') void stopRecording();
    } else if (method === 'error') broadcast('notify', { kind: 'error', message: (params as { message?: string })?.message ?? 'Capture error' });
    else if (method === 'frameDrop') logger.warn('capture.frameDrop', params as Record<string, unknown>);
  });
  helper.once('state', (st) => {
    if (st === 'ready') void restoreDesktop(); // crash left the desktop hidden? restore it
  });
  helper.start();
  if (isSmoke()) {
    const q = { width: 1280, height: 800 };
    let smokeProject = process.env.RECORDER_SMOKE_PROJECT;
    if (process.env.RECORDER_SMOKE_FIXTURE) smokeProject = await (await import('./fixture')).createFixture();
    await runSmoke([
      () => openRecorder({ query: { meters: '0' } }), // automated runs never open the microphone, not even for meters
      () => openWindow('settings', { ...q }),
      () => openWindow('library', { ...q }),
      () => openWindow('onboarding', { width: 640, height: 560 }),
      ...(smokeProject ? [() => openWindow('editor', { width: 1500, height: 950, query: { dir: smokeProject, tour: '0', ...(process.env.RECORDER_SMOKE_EXPORT ? { smokeExport: '1' } : {}), ...(process.env.RECORDER_SMOKE_ASR ? { smokeAsr: '1' } : {}) } })] : []),
    ], Number(process.env.RECORDER_SMOKE_WAIT ?? 7000), process.env.RECORDER_SMOKE_EXPORT ? (log) => log.some((m) => m.message.startsWith('SMOKE_EXPORT') && (m.message.includes('"format":"gif"') || m.message.includes('"ok":false'))) : undefined);
    return;
  }

  let last: RecState['state'] | null = null;
  const refreshTray = (st: RecState) => {
    if (st.state !== last) {
      last = st.state;
      void updateTray(st, trayActions);
    }
  };
  refreshTray(recState());
  const { ipcMain } = await import('electron');
  ipcMain.on('__noop', () => undefined);
  setInterval(() => refreshTray(recState()), 1000);

  applyHotkeys();
  let hotkeyTierRecording = false;
  recEvents.on('state', (st) => {
    const rec = st.state === 'recording' || st.state === 'paused';
    if (rec !== hotkeyTierRecording) {
      hotkeyTierRecording = rec;
      applyHotkeys();
    }
  });
  // re-register global shortcuts only when they change: settings are saved on every teleprompter
  // keystroke / slider tick, and re-registering each time is wasteful and briefly drops the hotkeys
  let shortcutsKey = JSON.stringify(s.shortcuts.record);
  settings.on('changed', (next) => {
    const key = JSON.stringify(next.shortcuts.record);
    if (key !== shortcutsKey) {
      shortcutsKey = key;
      applyHotkeys(); // before the broadcast so a Settings window re-reading hotkeys:status sees fresh results
    }
    broadcast('settings:changed', next);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.general.launchAtLogin });
  });

  const openArg = process.argv.find((a) => a.endsWith('.recproj'));
  if (openArg) openEditor(openArg);
  else if (!s.onboardingDone) openOnboarding();
  else openRecorder();

  // crash recovery prompt (task 1.18)
  setTimeout(async () => {
    const pending = findInterrupted();
    if (!pending.length) return;
    const r = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Restore', 'Later'],
      defaultId: 0,
      message: 'A recording was interrupted',
      detail: 'Restore the last recording? Everything up to the last couple of seconds can be recovered.',
    });
    if (r.response === 0) {
      for (const d of pending) {
        try {
          openEditor(await restoreInterrupted(d));
        } catch (e) {
          logger.error('recovery.failed', e, { d });
        }
      }
    }
  }, 2500);

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().some((w) => w.isVisible())) showApp();
  });
}

app.on('window-all-closed', () => {
  // keep running in the tray (quick record); quit explicitly from the tray menu
});
app.on('will-quit', () => {
  helper.stop();
});