/**
 * Presets (plan §11.1) — PRE-01…04, REC-15.
 * A preset is a snapshot of *style* attributes only (no media, no timing). Applying is partial:
 * only attributes that make sense for the project are applied (PRE-03).
 */
import { z } from 'zod';
import {
  AnimationSettingsSchema,
  CameraSettingsSchema,
  CanvasSettingsSchema,
  CaptionStyleSchema,
  CursorSettingsSchema,
  KeyOverlaySettingsSchema,
  WatermarkSchema,
  type Project,
} from './schema';
import { cloneData, uid } from './defaults';

export const PresetSchema = z.object({
  kind: z.literal('recorder-preset'),
  version: z.literal(1),
  id: z.string(),
  name: z.string().min(1).max(80),
  createdAt: z.string(),
  canvas: CanvasSettingsSchema.omit({ crop: true }),
  cursor: CursorSettingsSchema,
  animation: AnimationSettingsSchema,
  camera: CameraSettingsSchema.omit({ avatar: true, crop: true, facecam: true }),
  keys: KeyOverlaySettingsSchema.omit({ hiddenEventIds: true }),
  captionStyle: CaptionStyleSchema.optional(),
  /** exported .preset.json only: asset ref → data URL, so images travel with the file */
  assets: z.record(z.string(), z.string()).optional(),
  watermark: WatermarkSchema.optional(),
});
export type Preset = z.infer<typeof PresetSchema>;

export function createPreset(project: Project, name: string, now = new Date()): Preset {
  const { crop: _crop, ...canvas } = project.canvas;
  const { avatar: _a, crop: _c, facecam: _f, ...camera } = project.camera;
  const { hiddenEventIds: _h, ...keys } = project.keys;
  return PresetSchema.parse({
    kind: 'recorder-preset',
    version: 1,
    id: uid('pre'),
    name,
    createdAt: now.toISOString(),
    canvas: cloneData(canvas),
    cursor: cloneData(project.cursor),
    animation: cloneData(project.animation),
    camera: cloneData(camera),
    keys: cloneData(keys),
    ...(project.captions ? { captionStyle: cloneData(project.captions.style) } : {}),
    ...(project.watermark ? { watermark: cloneData(project.watermark) } : {}),
  });
}

export interface ApplyReport {
  applied: string[];
  skipped: string[];
}

/** PRE-03: partial apply. Returns a new project and a report of what was applied/skipped. */
export function applyPreset(project: Project, preset: Preset): { project: Project; report: ApplyReport } {
  const p = cloneData(project);
  const applied: string[] = [];
  const skipped: string[] = [];
  p.canvas = { ...p.canvas, ...cloneData(preset.canvas), crop: p.canvas.crop };
  if (!p.source.kind.match(/android|ios/)) p.canvas.deviceFrame = project.canvas.deviceFrame;
  applied.push('canvas', 'animation');
  p.animation = cloneData(preset.animation);
  if (p.source.hasTelemetry) {
    p.cursor = cloneData(preset.cursor);
    p.keys = { ...cloneData(preset.keys), hiddenEventIds: p.keys.hiddenEventIds };
    applied.push('cursor', 'keys');
  } else skipped.push('cursor', 'keys');
  if (p.source.tracks.camera || p.camera.avatar) {
    p.camera = { ...cloneData(preset.camera), avatar: p.camera.avatar, crop: p.camera.crop, facecam: p.camera.facecam };
    applied.push('camera');
  } else skipped.push('camera');
  if (preset.captionStyle && p.captions) {
    p.captions.style = cloneData(preset.captionStyle);
    applied.push('captions');
  } else if (preset.captionStyle) skipped.push('captions');
  if (preset.watermark) {
    p.watermark = cloneData(preset.watermark);
    applied.push('watermark');
  }
  p.appliedPresetId = preset.id;
  return { project: p, report: { applied, skipped } };
}

/** PRE-04: shareable `.preset.json`. Watermark image is embedded by the caller as a data URL if desired. */
export const serializePreset = (p: Preset): string => JSON.stringify(p, null, 2);
export function parsePreset(text: string): Preset {
  const raw = JSON.parse(text) as unknown;
  const parsed = PresetSchema.parse(raw);
  return { ...parsed, id: uid('pre') }; // imported presets get a fresh id
}

/**
 * Every file a preset can reference (background image / video, camera background image, watermark, imported
 * cursor). `fn` maps each reference; returns a new preset. Used to carry assets between projects.
 */
export function mapPresetAssets(preset: Preset, fn: (ref: string) => string): Preset {
  const p = cloneData(preset);
  if (p.canvas.background.type === 'image' || p.canvas.background.type === 'video') p.canvas.background.value = fn(p.canvas.background.value);
  if (p.camera.background.mode === 'image' && p.camera.background.value) p.camera.background.value = fn(p.camera.background.value);
  if (p.watermark?.file) p.watermark.file = fn(p.watermark.file);
  if (p.cursor.custom?.file) p.cursor.custom.file = fn(p.cursor.custom.file);
  return p;
}

/** A project-relative file path (not a URL / preset ref / absolute path). */
export const isProjectAssetRef = (ref: string): boolean => !/^[a-z][\w+.-]*:/i.test(ref) && !/^([\\/]|[a-z]:)/i.test(ref);
