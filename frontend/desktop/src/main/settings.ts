/**
 * Settings store (task 0.4): JSON in userData, zod-validated, defaults deep-merged, atomic writes.
 */
import { app } from 'electron';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_EXPORT } from '@rec/shared';
import { SettingsSchema, type Settings } from '../shared/ipc';
import { logger } from './log';
import { defaultExportDir, defaultSaveDir } from './paths';
import { DEFAULT_RECORD_SHORTCUTS, migrateSettings } from './settingsMigrations';

export const DEFAULT_EDIT_SHORTCUTS: Record<string, string> = {
  split: 'C',
  crop: 'Mod+R',
  addZoom: 'Z',
  save: 'Mod+S',
  saveAs: 'Mod+Shift+S',
  toStart: 'Home',
  toEnd: 'End',
  zoomInTimeline: 'Mod+=',
  zoomOutTimeline: 'Mod+-',
  copyProps: 'Mod+Alt+C',
  pasteProps: 'Mod+Alt+V',
  history: 'Mod+H',
  undo: 'Mod+Z',
  redo: 'Mod+Shift+Z',
  reset: 'Mod+Shift+R',
  playPause: 'Space',
  delete: 'Delete',
  addText: 'T',
  addBlur: 'B',
  addSpotlight: 'S',
  addArrow: 'A',
};

export function defaultSettings(): Settings {
  return {
    general: {
      saveDir: defaultSaveDir(),
      exportDir: defaultExportDir(),
      launchAtLogin: false,
      autoplayInEditor: true,
      language: 'en',
      recordingEngine: 'modern',
      theme: 'dark',
      previewQuality: 'auto',
      gpuHintShown: false,
      tourDone: false,
    },
    record: { autoZoom: true, zoomMode: '2d', hideDesktopIcons: false, hideTaskbar: false, quality: 'high', fps: 60, countdown: 3, encoder: 'auto' },
    shortcuts: { record: { ...DEFAULT_RECORD_SHORTCUTS }, edit: { ...DEFAULT_EDIT_SHORTCUTS } },
    export: { ...DEFAULT_EXPORT },
    devices: { cameraEnabled: false, micEnabled: true, systemAudioEnabled: true, lastMode: 'display' },
    teleprompter: { script: '', speed: 1, fontSize: 36, color: '#ffffff', bgOpacity: 0.75 },
    onboardingDone: false,
    analyticsOptIn: false,
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out as T;
}

class SettingsStore extends EventEmitter {
  private data: Settings = defaultSettings();
  private file = '';

  load(): Settings {
    this.file = join(app.getPath('userData'), 'settings.json');
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      const migrated = isObj(raw) && migrateSettings(raw);
      const merged = deepMerge(defaultSettings(), raw);
      const r = SettingsSchema.safeParse(merged);
      if (r.success) {
        this.data = r.data;
        if (migrated) {
          logger.info('settings.migrated', { shortcuts: this.data.shortcuts.record });
          this.persist(this.data);
        }
      } else logger.warn('settings.load.invalid', { issues: r.error.issues.slice(0, 5).map((i) => i.path.join('.')) });
    } catch {
      logger.info('settings.load.defaults');
    }
    return this.data;
  }

  get(): Settings {
    return this.data;
  }

  set(patch: unknown): Settings {
    const next = SettingsSchema.parse(deepMerge(this.data, patch));
    this.data = next;
    this.persist(next);
    this.emit('changed', next);
    return next;
  }

  private persist(data: Settings): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }
}

export const settings = new SettingsStore();
