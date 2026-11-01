/**
 * Window manager (task 0.3): named windows sharing one hardened webPreferences profile.
 * Overlays (area, countdown, control bar, teleprompter) use setContentProtection(true) so they are
 * excluded from capture (WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+, sharingType none on macOS).
 */
import { BrowserWindow, screen, shell, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';
import { join } from 'node:path';
import { logger } from './log';
import { rendererUrl } from './rendererUrl';
import { isSmoke, watchConsole } from './smoke';

export type WinName = 'recorder' | 'editor' | 'settings' | 'teleprompter' | 'library' | 'onboarding' | 'controlbar' | 'countdown' | `area-${string}`;

const windows = new Map<string, BrowserWindow>();

const routeUrl = (route: string, query: Record<string, string> = {}): string =>
  rendererUrl(join(__dirname, '../renderer/index.html'), route, query, process.env.ELECTRON_RENDERER_URL);

const baseWeb = (): BrowserWindowConstructorOptions['webPreferences'] => ({
  preload: join(__dirname, '../preload/index.cjs'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
  backgroundThrottling: false,
});

export function getWin(name: WinName): BrowserWindow | undefined {
  const w = windows.get(name);
  return w && !w.isDestroyed() ? w : undefined;
}

export function allWindows(): BrowserWindow[] {
  return [...windows.values()].filter((w) => !w.isDestroyed());
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const w of allWindows()) w.webContents.send(channel, payload);
}

export function openWindow(name: WinName, opts: BrowserWindowConstructorOptions & { route?: string; query?: Record<string, string>; protect?: boolean } = {}): BrowserWindow {
  const existing = getWin(name);
  if (existing) {
    if (opts.query) void existing.loadURL(routeUrl(opts.route ?? name, opts.query));
    if (existing.isMinimized()) existing.restore();
    if (!existing.isVisible()) existing.show();
    existing.focus();
    return existing;
  }
  const { route, query, protect, ...bw } = opts;
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: bw.transparent ? '#00000000' : '#0f0f14',
    autoHideMenuBar: true,
    ...bw,
    webPreferences: { ...baseWeb(), ...bw.webPreferences },
  });
  if (protect) win.setContentProtection(true);
  watchConsole(name, win);
  windows.set(name, win);
  win.on('closed', () => windows.delete(name));
  win.once('ready-to-show', () => {
    if (bw.show !== false && !isSmoke()) win.show();
  });
  // never let content navigate the window or open arbitrary new windows
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault();
  });
  win.webContents.on('render-process-gone', (_e, d) => logger.error('window.renderGone', new Error(d.reason), { name }));
  // a page that never loads never fires ready-to-show, so the window stays hidden: leave a trace in the log
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) logger.error('window.loadFailed', new Error(desc), { name, code }); // -3: superseded by a newer loadURL
  });
  void win.loadURL(routeUrl(route ?? name, query));
  return win;
}

/**
 * `show: false` creates the recorder hidden (tray/hotkey recordings still need its camera capture);
 * `query` passes a one-shot intent such as `{ pick: 'window' }` to a freshly loaded page.
 */
export function openRecorder(opts: { show?: boolean; query?: Record<string, string> } = {}): BrowserWindow {
  const existing = getWin('recorder');
  if (existing && opts.show === false) return existing;
  return openWindow('recorder', { width: 420, height: 640, resizable: false, frame: false, title: 'Open-Recorder', maximizable: false, ...(opts.show === false ? { show: false } : {}), ...(opts.query && !existing ? { query: opts.query } : {}) });
}

export function openEditor(dir: string): BrowserWindow {
  const w = getWin('editor');
  if (w) {
    w.webContents.send('project:opened', dir);
    w.show();
    w.focus();
    return w;
  }
  const { workArea } = screen.getPrimaryDisplay();
  // the editor is where GPU speed matters: explain a hybrid-GPU setup once (task 14.5)
  if (!isSmoke()) setTimeout(() => void import('./gpu').then((m) => m.checkGpuOnce()), 4000);
  return openWindow('editor', {
    width: Math.min(1600, workArea.width),
    height: Math.min(1000, workArea.height),
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    title: 'Editor',
    query: { dir },
  });
}

export function openOverlay(name: WinName, bounds: Rectangle, route: string, query: Record<string, string> = {}, focusable = true): BrowserWindow {
  const w = openWindow(name, {
    ...bounds,
    route,
    query,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable,
    enableLargerThanScreen: true,
    protect: true,
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return w;
}

export function closeWindow(name: WinName): void {
  getWin(name)?.close();
}
