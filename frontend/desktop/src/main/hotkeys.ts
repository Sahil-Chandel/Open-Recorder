/**
 * Global recording hotkeys (task 2.6) with conflict detection: a shortcut that fails to register is
 * reported back so the Settings UI can flag it.
 *
 * Two tiers keep us from stealing other apps' shortcuts: "start" hotkeys are global while idle, while
 * pause/finish are only registered during a recording (and only probed for availability while idle).
 */
import { globalShortcut } from 'electron';
import { logger } from './log';

export type HotkeyAction = 'newRecording' | 'fullScreen' | 'custom' | 'window' | 'pauseResume' | 'finish' | 'pauseKeys';

const RECORDING_TIER = new Set<string>(['pauseResume', 'finish', 'pauseKeys']);

let lastFailed: string[] = [];

/** Actions whose shortcut could not be registered (taken by another app, invalid, or duplicated). */
export const hotkeyStatus = (): { failed: string[] } => ({ failed: [...lastFailed] });

export function registerHotkeys(map: Record<string, string>, handler: (a: HotkeyAction) => void, recording = false): { failed: string[] } {
  globalShortcut.unregisterAll();
  const failed: string[] = [];
  const seen = new Map<string, string>();
  for (const [action, accel] of Object.entries(map)) {
    if (!accel) continue;
    if (seen.has(accel)) {
      failed.push(action);
      continue;
    }
    seen.set(accel, action);
    const live = recording ? RECORDING_TIER.has(action) : !RECORDING_TIER.has(action);
    try {
      if (live) {
        if (!globalShortcut.register(accel, () => handler(action as HotkeyAction))) failed.push(action);
      } else if (!recording) {
        // probe only: can we take it when the recording starts?
        if (globalShortcut.register(accel, () => undefined)) globalShortcut.unregister(accel);
        else failed.push(action);
      } else if (lastFailed.includes(action)) failed.push(action); // not probed mid-recording: keep last verdict
    } catch (e) {
      logger.warn('hotkeys.invalid', { action, accel, message: (e as Error).message });
      failed.push(action);
    }
  }
  if (failed.join() !== lastFailed.join() && failed.length) logger.warn('hotkeys.conflicts', { failed });
  lastFailed = failed;
  return { failed };
}
