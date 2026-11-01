/**
 * Preload (sandboxed, contextIsolation). Exposes a minimal, allow-listed bridge — no Node APIs leak.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { EVENTS, INVOKE, type EventChannel, type InvokeChannel } from '../shared/ipc';

const invokeAllowed = new Set(Object.keys(INVOKE));
const eventsAllowed = new Set<string>(EVENTS);

const api = {
  platform: process.platform,
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown> {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: EventChannel, cb: (payload: unknown) => void): () => void {
    if (!eventsAllowed.has(channel)) throw new Error(`blocked event ${channel}`);
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** absolute path of a dropped/selected File (for drag-drop imports) */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
};

contextBridge.exposeInMainWorld('api', api);
export type PreloadApi = typeof api;