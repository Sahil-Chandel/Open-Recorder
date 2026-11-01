/**
 * Tray / menu-bar quick record (task 2.5, SET-02): start Full Screen / Window / Custom without the main window,
 * show recording state + Stop, recent projects.
 */
import { Menu, nativeImage, Tray, app } from 'electron';
import type { RecState } from '../shared/ipc';
import { listProjects } from './projects';
import { openEditor, openRecorder, openWindow } from './windows';

let tray: Tray | null = null;

// 16×16 purple dot, generated at runtime (no bundled art needed)
function icon(recording: boolean): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5);
      const o = (y * size + x) * 4;
      const a = Math.max(0, Math.min(1, 13 - d));
      const [r, g, b] = recording ? [239, 68, 68] : [124, 92, 255];
      buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = Math.round(a * 255);
    }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

export interface TrayActions {
  quick: (mode: 'display' | 'window' | 'area') => void;
  stop: () => void;
  pauseResume: () => void;
}

export async function updateTray(state: RecState, actions: TrayActions): Promise<void> {
  if (!tray) tray = new Tray(icon(false));
  const recording = state.state === 'recording' || state.state === 'paused';
  tray.setImage(icon(recording));
  tray.setToolTip(recording ? `Recording… ${Math.floor(state.elapsedSec)}s` : 'Open-Recorder');
  const recent = (await listProjects().catch(() => [])).slice(0, 5);
  const menu = Menu.buildFromTemplate(
    recording
      ? [
          { label: state.state === 'paused' ? 'Continue' : 'Pause', click: actions.pauseResume },
          { label: 'Stop recording', click: actions.stop },
        ]
      : [
          { label: 'Record full screen', click: () => actions.quick('display') },
          { label: 'Record window…', click: () => actions.quick('window') },
          { label: 'Record custom area…', click: () => actions.quick('area') },
          { type: 'separator' },
          { label: 'Open recorder', click: () => openRecorder() },
          { label: 'Project history', click: () => openWindow('library', { width: 1080, height: 720, frame: false }) },
          { label: 'Recent', submenu: recent.length ? recent.map((p) => ({ label: p.name, click: () => openEditor(p.dir) })) : [{ label: 'No projects yet', enabled: false }] },
          { type: 'separator' },
          { label: 'Quit', click: () => app.quit() },
        ],
  );
  tray.setContextMenu(menu);
  tray.removeAllListeners('click');
  tray.on('click', () => (recording ? actions.stop() : openRecorder()));
}