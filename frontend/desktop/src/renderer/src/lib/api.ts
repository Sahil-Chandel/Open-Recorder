/** Thin typed wrappers over the preload bridge. */
import type { InvokeChannel, EventChannel } from '../../../shared/ipc';

export const api = {
  invoke: <T = unknown>(ch: InvokeChannel, ...args: unknown[]): Promise<T> => window.api.invoke<T>(ch, ...args),
  on: (ch: EventChannel, cb: (p: any) => void): (() => void) => window.api.on(ch, cb),
  platform: () => window.api?.platform ?? 'web',
};

export function route(): { name: string; query: URLSearchParams } {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [name = 'recorder', qs = ''] = hash.split('?');
  return { name, query: new URLSearchParams(qs) };
}

export const isMac = (): boolean => api.platform() === 'darwin';
export const modKey = (): string => (isMac() ? '⌘' : 'Ctrl');

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}