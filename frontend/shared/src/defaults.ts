import {
  ProjectSchema,
  SCHEMA_VERSION,
  type AnimationSettings,
  type AudioSettings,
  type CameraSettings,
  type CanvasSettings,
  type CaptionStyle,
  type Clip,
  type CursorSettings,
  type KeyOverlaySettings,
  type Project,
  SourceInfoSchema,
  type SourceInfoInput,
} from './schema';

let counter = 0;
/** Collision-safe id: random UUID when available, monotonic fallback for exotic runtimes. */
/**
 * Deep copy of project data that also works on Immer drafts (structuredClone throws DataCloneError on the
 * Proxy objects an edit recipe hands out). Project data is plain JSON, so a JSON round-trip is lossless.
 */
export function cloneData<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function uid(prefix = ''): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const id = g.crypto?.randomUUID ? g.crypto.randomUUID().slice(0, 12) : `${Date.now().toString(36)}${(counter++).toString(36)}`;
  return prefix ? `${prefix}_${id}` : id;
}

export const DEFAULT_CANVAS: CanvasSettings = {
  aspect: 'auto',
  padding: 0.08,
  inset: 0,
  roundness: 0.12,
  shadow: 0.5,
  backgroundBlur: 0,
  background: { type: 'gradient', value: 'aurora' },
  fixedZoom: false,
  verticalFill: false,
};

export const DEFAULT_ANIMATION: AnimationSettings = {
  zoomPan: 'slow',
  cursorMove: 'medium',
  motionBlur: { enabled: true, zoom: 50, screen: 50, cursor: 50 },
};

export const DEFAULT_CURSOR: CursorSettings = {
  show: true,
  size: 1.5,
  styleId: 'classic-white',
  angle: 0,
  dynamicDirection: false,
  clickEffect: { id: 'ripple', color: '#7c5cff' },
  clickSound: { enabled: false, soundId: 'soft-tick', volume: 0.6 },
  hideWhenIdle: { enabled: false, afterSec: 2, animation: 'fade' },
  smoothPath: { enabled: true, level: 50 },
  endBehavior: { mode: 'stay', durationSec: 0.6 },
};

export const DEFAULT_CAMERA: CameraSettings = {
  visible: true,
  size: 1,
  roundness: 1,
  border: { color: '#ffffff', width: 0 },
  mirror: false,
  flipH: false,
  flipV: false,
  shrinkOnZoom: true,
  layoutId: 'pip-br',
  background: { mode: 'original' },
  beauty: { enabled: false, intensity: 0.5 },
};

export const DEFAULT_KEYS: KeyOverlaySettings = {
  enabled: true,
  singleKeys: false,
  styleId: 'dark',
  fontColor: '#ffffff',
  bgColor: '#111111',
  bgOpacity: 0.8,
  size: 1,
  position: 'bottom-center',
  hiddenEventIds: [],
};

export const DEFAULT_AUDIO: AudioSettings = {
  mic: { mute: false, volume: 1, denoise: false, enhance: false, balance: false },
  system: { mute: false, volume: 1 },
  device: { mute: false, volume: 1 },
  ducking: false,
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  styleId: 'classic',
  font: 'Inter',
  size: 44,
  wordColor: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 3,
  shadow: { color: '#000000', size: 8, x: 0, y: 2, opacity: 0.5 },
  highlightColor: '#ffd23f',
  highlightOpacity: 1,
  position: 0.08,
  spacing: 1.2,
};

export function makeClip(srcStart: number, srcEnd: number, patch: Partial<Clip> = {}): Clip {
  return {
    id: uid('clip'),
    srcStart,
    srcEnd,
    speed: 1,
    showCursor: true,
    volume: { mic: 1, system: 1, device: 1 },
    ...patch,
  };
}

export function createProject(name: string, sourceIn: SourceInfoInput, now = new Date()): Project {
  const source = SourceInfoSchema.parse(sourceIn);
  const iso = now.toISOString();
  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: uid('prj'),
    name,
    createdAt: iso,
    lastOpenedAt: iso,
    source,
    canvas: structuredClone(DEFAULT_CANVAS),
    clips: [makeClip(0, Math.max(source.durationSec, 0.001))],
    zooms: [],
    layouts: [],
    annotations: [],
    chapters: [],
    cursor: structuredClone(DEFAULT_CURSOR),
    animation: structuredClone(DEFAULT_ANIMATION),
    camera: { ...structuredClone(DEFAULT_CAMERA), visible: Boolean(source.tracks.camera) },
    keys: structuredClone(DEFAULT_KEYS),
    audio: structuredClone(DEFAULT_AUDIO),
  };
  if (!source.hasTelemetry) {
    project.cursor.show = false; // DEV-06: device recordings & imports have no cursor telemetry
    project.keys.enabled = false;
  }
  return ProjectSchema.parse(project);
}
