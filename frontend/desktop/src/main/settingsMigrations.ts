/**
 * Pure settings defaults + migrations (no Electron imports, so they are unit-testable).
 *
 * Ctrl/⌘+Shift combos collide with very common app shortcuts (Ctrl+Shift+P command palette, Ctrl+Shift+S
 * Save As, Ctrl+Shift+N new window), and a global shortcut silently steals them from every app.
 * Alt+Shift (⌥⌘ on macOS, where ⌥⇧+letter types characters) is far less contested.
 */
export const platformMod = (platform: string): string => (platform === 'darwin' ? 'Command+Alt' : 'Alt+Shift');
const MOD = platformMod(process.platform);
export const DEFAULT_RECORD_SHORTCUTS: Record<string, string> = {
  newRecording: `${MOD}+N`,
  fullScreen: `${MOD}+1`,
  custom: `${MOD}+2`,
  window: `${MOD}+3`,
  pauseResume: `${MOD}+P`,
  finish: `${MOD}+S`,
  pauseKeys: `${MOD}+K`,
};

/** Defaults shipped before 0.1.1 — replaced on load unless the user changed them. */
const LEGACY_RECORD_SHORTCUTS: Record<string, string> = {
  newRecording: 'CommandOrControl+Shift+N',
  fullScreen: 'CommandOrControl+Shift+1',
  custom: 'CommandOrControl+Shift+2',
  window: 'CommandOrControl+Shift+3',
  pauseResume: 'CommandOrControl+Shift+P',
  finish: 'CommandOrControl+Shift+S',
};

/** Settings migrations applied to the raw file before validation. Returns true when something changed. */
export function migrateSettings(raw: Record<string, unknown>): boolean {
  let changed = false;
  const rec = (raw.shortcuts as { record?: Record<string, string> } | undefined)?.record;
  if (rec) {
    for (const [action, legacy] of Object.entries(LEGACY_RECORD_SHORTCUTS)) {
      if (rec[action] === legacy && DEFAULT_RECORD_SHORTCUTS[action]) {
        rec[action] = DEFAULT_RECORD_SHORTCUTS[action]!;
        changed = true;
      }
    }
  }
  return changed;
}
