/**
 * Area selector (task 2.2): one transparent, capture-excluded overlay per display. The first overlay that
 * reports a rectangle wins; Esc on any overlay cancels.
 */
import { screen } from 'electron';
import type { Area } from '../shared/ipc';
import { closeWindow, getWin, openOverlay } from './windows';
import { settings } from './settings';

let pending: ((a: Area | null) => void) | null = null;
let names: string[] = [];

export function selectArea(): Promise<Area | null> {
  if (pending) pending(null);
  const last = settings.get().devices.lastArea;
  names = [];
  for (const d of screen.getAllDisplays()) {
    const name = `area-${d.id}` as const;
    names.push(name);
    openOverlay(name, d.bounds, 'area', {
      displayId: String(d.id),
      ox: String(d.bounds.x),
      oy: String(d.bounds.y),
      ...(last && last.displayId === String(d.id) ? { last: JSON.stringify(last) } : {}),
    });
  }
  getWin(names[0] as `area-${string}`)?.focus();
  return new Promise((res) => {
    pending = res;
  });
}

export function areaDone(a: Area | null): void {
  for (const n of names) closeWindow(n as `area-${string}`);
  names = [];
  const p = pending;
  pending = null;
  p?.(a);
}