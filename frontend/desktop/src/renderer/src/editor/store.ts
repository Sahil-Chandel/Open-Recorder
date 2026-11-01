/**
 * Editor state (task 3.9/3.10): project.json is the single source of truth; every edit is an Immer
 * recipe recorded as patches → Undo/Redo (command pattern). Slider drags coalesce into one history entry.
 * Autosave is debounced (~1.5 s) and atomic in main.
 */
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { create } from 'zustand';
import {
  buildDerived,
  derivedInputs,
  ClickEventSchema,
  decodeCursorBin,
  emptyTelemetry,
  KeyEventSchema,
  normaliseTelemetry,
  outputDuration,
  parseJsonl,
  type Derived,
  type Project,
  type Telemetry,
} from '@rec/shared';
import type { OpenedProject } from '../../../shared/ipc';
import { api, errMsg } from '../lib/api';
import { toast } from '../ui';

enablePatches();

export type ModuleId = 'video' | 'cursor' | 'camera' | 'animations' | 'keys' | 'annotation' | 'audio' | 'captions' | 'smartcut' | 'watermark';
export type SelKind = 'clip' | 'zoom' | 'layout' | 'annotation' | 'caption' | 'music' | null;

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  key?: string;
  at: number;
}

export interface EditorState {
  dir: string;
  opened: OpenedProject | null;
  project: Project | null;
  telemetry: Telemetry;
  derived: Derived | null;
  time: number;
  playing: boolean;
  loop: { start: number; end: number } | null;
  module: ModuleId;
  selection: { kind: SelKind; id: string | null };
  past: HistoryEntry[];
  future: HistoryEntry[];
  dirty: boolean;
  savedAt: string | null;
  propsClipboard: { kind: SelKind; data: unknown } | null;
  timelineZoom: number; // px per second
  /** preview-only overlay of the social target's UI areas (VideoPanel toggle) */
  safeZones: boolean;
  setSafeZones: (v: boolean) => void;
  load: (dir: string) => Promise<void>;
  edit: (label: string, recipe: (d: Draft<Project>) => void, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  select: (kind: SelKind, id: string | null) => void;
  setModule: (m: ModuleId) => void;
  save: () => Promise<void>;
  recompute: () => void;
  setTimelineZoom: (z: number) => void;
  /** preview loop range in OUTPUT seconds (null clears); clamped to the edited duration, min 0.1 s */
  setLoop: (l: { start: number; end: number } | null) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let deriveTimer: ReturnType<typeof setTimeout> | null = null;
let lastInputs: readonly unknown[] | null = null;
const sameInputs = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const HISTORY_LIMIT = 300;

function decodeTelemetry(o: OpenedProject): Telemetry {
  const p = o.project;
  if (!p.source.hasTelemetry) return emptyTelemetry();
  const bin = Uint8Array.from(atob(o.telemetryRaw.cursorB64), (c) => c.charCodeAt(0));
  return normaliseTelemetry(
    { cursor: decodeCursorBin(bin), clicks: parseJsonl(o.telemetryRaw.clicks, ClickEventSchema), keys: parseJsonl(o.telemetryRaw.keys, KeyEventSchema) },
    p.source.segments,
    p.source.width,
    p.source.height,
  );
}

export const useEditor = create<EditorState>((set, get) => ({
  dir: '',
  opened: null,
  project: null,
  telemetry: emptyTelemetry(),
  derived: null,
  time: 0,
  playing: false,
  loop: null,
  module: 'video',
  selection: { kind: null, id: null },
  past: [],
  future: [],
  dirty: false,
  savedAt: null,
  propsClipboard: null,
  timelineZoom: 60,
  safeZones: true,
  setSafeZones(v) {
    set({ safeZones: v });
  },

  async load(dir) {
    // a debounced autosave of the project being replaced would otherwise be cancelled with it
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (get().project && get().dirty) await get().save().catch(() => undefined);
    }
    const opened = await api.invoke<OpenedProject>('projects:open', dir);
    const telemetry = decodeTelemetry(opened);
    const project = opened.project;
    set({
      dir,
      opened,
      project,
      telemetry,
      derived: (lastInputs = derivedInputs(project), buildDerived(project, telemetry, api.platform() === 'darwin')),
      time: 0,
      playing: false,
      past: [],
      future: [],
      dirty: false,
      selection: { kind: null, id: null },
      loop: null,
    });
    document.title = `${project.name} — Editor`;
  },

  edit(label, recipe, coalesceKey) {
    const { project, past } = get();
    if (!project) return;
    const [next, patches, inverse] = produceWithPatches(project, recipe);
    if (!patches.length) return;
    const now = Date.now();
    const last = past[past.length - 1];
    let newPast: HistoryEntry[];
    if (coalesceKey && last && last.key === coalesceKey && now - last.at < 800) {
      // merge: keep the oldest inverse, append the newest forward patches
      newPast = [...past.slice(0, -1), { ...last, patches: [...last.patches, ...patches], inverse: [...inverse, ...last.inverse], at: now }];
    } else {
      newPast = [...past, { label, patches, inverse, ...(coalesceKey ? { key: coalesceKey } : {}), at: now }].slice(-HISTORY_LIMIT);
    }
    set({ project: next, past: newPast, future: [], dirty: true });
    get().recompute();
    scheduleSave();
  },

  undo() {
    const { past, future, project } = get();
    const e = past[past.length - 1];
    if (!e || !project) return;
    set({ project: applyPatches(project, e.inverse), past: past.slice(0, -1), future: [e, ...future], dirty: true });
    get().recompute();
    scheduleSave();
    toast(`Undo: ${e.label}`);
  },

  redo() {
    const { past, future, project } = get();
    const e = future[0];
    if (!e || !project) return;
    set({ project: applyPatches(project, e.patches), past: [...past, e], future: future.slice(1), dirty: true });
    get().recompute();
    scheduleSave();
  },

  setTime(t) {
    const d = get().derived;
    set({ time: Math.min(Math.max(0, t), d?.duration ?? t) });
  },
  setPlaying(p) {
    set({ playing: p });
  },
  select(kind, id) {
    set({ selection: { kind, id } });
  },
  setModule(m) {
    set({ module: m });
  },
  setTimelineZoom(z) {
    set({ timelineZoom: Math.min(800, Math.max(2, z)) });
  },
  setLoop(l) {
    if (!l || !Number.isFinite(l.start) || !Number.isFinite(l.end)) return set({ loop: null });
    const dur = get().derived?.duration ?? Infinity;
    const start = Math.max(0, Math.min(l.start, l.end));
    const end = Math.min(dur, Math.max(l.start, l.end));
    set({ loop: end - start >= 0.1 ? { start, end } : null });
  },

  recompute() {
    // derived tracks are cheap but not free (O(duration·240)); skip edits that can't affect them and
    // debounce bursts of the ones that can
    const p0 = get().project;
    if (p0 && lastInputs && sameInputs(lastInputs, derivedInputs(p0))) return;
    if (deriveTimer) clearTimeout(deriveTimer);
    const run = () => {
      const { project, telemetry } = get();
      if (!project) return;
      lastInputs = derivedInputs(project);
      const derived = buildDerived(project, telemetry, api.platform() === 'darwin');
      set({ derived, time: Math.min(get().time, outputDuration(project.clips)) });
    };
    const dur = get().derived?.duration ?? 0;
    if (dur < 120) run();
    else deriveTimer = setTimeout(run, 60);
  },

  async save() {
    const { project, dir } = get();
    if (!project || !dir) return;
    try {
      const r = await api.invoke<{ savedAt: string }>('projects:save', dir, project);
      set({ dirty: false, savedAt: r.savedAt });
    } catch (e) {
      toast(`Save failed: ${errMsg(e)}`, 'error');
    }
  },
}));

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void useEditor.getState().save(), 1500);
}

window.addEventListener('beforeunload', () => {
  if (useEditor.getState().dirty) void useEditor.getState().save();
});

/** Convenience: current project (throws if not loaded — only used inside the loaded editor). */
export const useProject = (): Project => useEditor((s) => s.project!) as Project;
