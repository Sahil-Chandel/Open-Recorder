/**
 * project.json schema (plan §5.2). Validated with zod at every boundary (load, IPC, import).
 * Everything the editor mutates lives here; the renderer derives everything else.
 * Times are SOURCE seconds unless noted (§5.3); x/y/w/h are normalised 0..1.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

const N = z.number().min(-10).max(10); // normalised; generous bounds so off-frame placements stay valid
const Sec = z.number().min(0);
export const RectN = z.object({ x: N, y: N, w: z.number().min(0).max(10), h: z.number().min(0).max(10) });
export type RectN = z.infer<typeof RectN>;

export const SpringSchema = z.object({
  tension: z.number().min(1).max(2000),
  friction: z.number().min(0).max(500),
  mass: z.number().min(0.05).max(50),
});
export type Spring = z.infer<typeof SpringSchema>;
export const SpeedPresetSchema = z.enum(['slow', 'medium', 'fast', 'rapid']);
export type SpeedPreset = z.infer<typeof SpeedPresetSchema>;

export const SourceInfoSchema = z.object({
  kind: z.enum(['display', 'window', 'area', 'android', 'ios', 'import']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive().max(240),
  scaleFactor: z.number().positive().default(1),
  segments: z.array(z.object({ file: z.string(), startNs: z.number(), durationNs: z.number().nonnegative() })),
  tracks: z.object({
    screen: z.string().optional(), // concatenated, faststart playback file (segments joined)
    camera: z.string().optional(),
    mic: z.string().optional(),
    system: z.string().optional(),
    device: z.string().optional(),
  }),
  hasTelemetry: z.boolean(),
  durationSec: Sec,
  /** seconds a track starts after source t=0 (camera recorded in the renderer is offset-measured, §4.4.2) */
  trackOffsets: z.record(z.string(), z.number()).default({}),
});
export type SourceInfo = z.infer<typeof SourceInfoSchema>;
export type SourceInfoInput = z.input<typeof SourceInfoSchema>;

export const AspectSchema = z.enum(['auto', '16:9', '9:16', '1:1', '4:3', '4:5']);
export type Aspect = z.infer<typeof AspectSchema>;

export const BackgroundSchema = z.object({
  type: z.enum(['wallpaper', 'gradient', 'color', 'image', 'video']), // video = looping, muted (RM-17)
  value: z.string(),
});

export const CanvasSettingsSchema = z.object({
  aspect: AspectSchema,
  padding: z.number().min(0).max(0.4), // fraction of canvas short side
  inset: z.number().min(0).max(0.2),
  roundness: z.number().min(0).max(1), // 0..1 → 0..min(w,h)/2 px of the stage
  shadow: z.number().min(0).max(1),
  backgroundBlur: z.number().min(0).max(1),
  background: BackgroundSchema,
  crop: RectN.optional(),
  deviceFrame: z.string().optional(),
  fixedZoom: z.boolean(),
  verticalFill: z.boolean(),
  /** social target id (social.ts) the canvas was set up for — drives export defaults + safe-zone overlay */
  target: z.string().max(40).optional(),
});
export type CanvasSettings = z.infer<typeof CanvasSettingsSchema>;

export const ClipSchema = z.object({
  id: z.string(),
  srcStart: Sec,
  srcEnd: Sec,
  speed: z.number().min(0.25).max(8),
  showCursor: z.boolean(),
  volume: z.object({ mic: z.number().min(0).max(3), system: z.number().min(0).max(3), device: z.number().min(0).max(3) }),
});
export type Clip = z.infer<typeof ClipSchema>;

export const M3DSchema = z.object({
  auto: z.boolean(),
  intensity: z.enum(['subtle', 'default', 'strong']),
  tilt: z.object({ x: z.number().min(-45).max(45), y: z.number().min(-45).max(45), z: z.number().min(-45).max(45), fov: z.number().min(20).max(90) }),
  position: z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }),
  focusArea: RectN.optional(),
  recipe: z.enum(['none', 'entrance', 'showcase']).default('none'),
});
export type M3D = z.infer<typeof M3DSchema>;

export const ZoomFocusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('follow') }),
  z.object({ type: z.literal('fixed'), x: N, y: N }),
]);
export type ZoomFocus = z.infer<typeof ZoomFocusSchema>;

export const ZoomSegmentSchema = z.object({
  id: z.string(),
  start: Sec,
  end: Sec,
  enabled: z.boolean(),
  source: z.enum(['auto-click', 'auto-typing', 'manual']),
  mode: z.enum(['2d', '3d']),
  level: z.number().min(1).max(4),
  focus: ZoomFocusSchema,
  m3d: M3DSchema.optional(),
});
export type ZoomSegment = z.infer<typeof ZoomSegmentSchema>;

const SpringOrPreset = z.union([SpeedPresetSchema, SpringSchema]);
export const AnimationSettingsSchema = z.object({
  zoomPan: SpringOrPreset,
  cursorMove: z.union([SpeedPresetSchema, SpringSchema, z.literal('off')]),
  motionBlur: z.object({
    enabled: z.boolean(),
    zoom: z.number().min(0).max(100),
    screen: z.number().min(0).max(100),
    cursor: z.number().min(0).max(100),
  }),
});
export type AnimationSettings = z.infer<typeof AnimationSettingsSchema>;

export const CursorSettingsSchema = z.object({
  show: z.boolean(),
  size: z.number().min(0.25).max(5),
  styleId: z.string(),
  color: z.string().optional(),
  angle: z.number().min(-90).max(90),
  dynamicDirection: z.boolean(),
  clickEffect: z.object({ id: z.string().nullable(), color: z.string() }),
  clickSound: z.object({ enabled: z.boolean(), soundId: z.string(), volume: z.number().min(0).max(1) }),
  hideWhenIdle: z.object({ enabled: z.boolean(), afterSec: z.number().min(0.5).max(5), animation: z.enum(['fade', 'scale', 'none']) }),
  smoothPath: z.object({ enabled: z.boolean(), level: z.number().min(0).max(100) }),
  endBehavior: z.object({ mode: z.enum(['stay', 'returnToStart']), durationSec: z.number().min(0).max(5) }),
  /** RM-11: imported cursor image (project asset) replacing every shape; hotspot in image px */
  custom: z.object({ file: z.string(), hotspot: z.tuple([z.number(), z.number()]), size: z.number().positive() }).optional(),
});
export type CursorSettings = z.infer<typeof CursorSettingsSchema>;

export const LayoutDefSchema = z.object({
  orientation: z.enum(['landscape', 'portrait']),
  screen: RectN,
  camera: RectN.nullable(),
  cameraBehindScreen: z.boolean(),
  cameraRoundness: z.number().min(0).max(1).optional(),
});
export type LayoutDef = z.infer<typeof LayoutDefSchema>;

export const LayoutSegmentSchema = z.object({
  id: z.string(),
  start: Sec,
  end: Sec,
  layoutId: z.string(),
  custom: LayoutDefSchema.optional(),
  transitionSec: z.number().min(0).max(3),
});
export type LayoutSegment = z.infer<typeof LayoutSegmentSchema>;

export const CameraSettingsSchema = z.object({
  visible: z.boolean(),
  size: z.number().min(0.3).max(2),
  roundness: z.number().min(0).max(1),
  border: z.object({ color: z.string(), width: z.number().min(0).max(20) }),
  frameId: z.string().optional(),
  mirror: z.boolean(),
  flipH: z.boolean(), // legacy: XOR-ed with mirror
  flipV: z.boolean().default(false),
  filterId: z.string().optional(),
  shrinkOnZoom: z.boolean(),
  crop: RectN.optional(),
  layoutId: z.string(), // default layout when no LayoutSegment covers t
  customLayout: LayoutDefSchema.optional(),
  background: z.object({
    mode: z.enum(['original', 'remove', 'blur', 'image', 'color']),
    value: z.string().optional(),
    blur: z.number().min(0).max(1).optional(),
  }),
  beauty: z.object({ enabled: z.boolean(), intensity: z.number().min(0).max(1) }),
  /** RM-12: a separately recorded face-cam video used instead of the webcam track; offset aligns it */
  facecam: z.object({ file: z.string(), offsetSec: z.number().min(-60).max(60) }).optional(),
  avatar: z.object({ avatarId: z.string(), videoFile: z.string() }).optional(),
});
export type CameraSettings = z.infer<typeof CameraSettingsSchema>;

const AnimDir = z.enum(['none', 'fade', 'scale', 'slide']);
const AnnotationBase = z.object({
  id: z.string(),
  start: Sec,
  end: Sec,
  lane: z.number().int().min(0),
  space: z.enum(['canvas', 'content']),
  rect: RectN,
  rotation: z.number(),
  anim: z.object({ in: AnimDir, out: AnimDir, durSec: z.number().min(0).max(2) }),
});

export const TextStyleSchema = z.object({
  preset: z.enum(['basic', 'outline', 'shadow', 'gradient', 'pill']),
  font: z.string(),
  size: z.number().min(4).max(400),
  color: z.string(),
  color2: z.string().optional(),
  bold: z.boolean(),
  italic: z.boolean(),
  underline: z.boolean(),
  align: z.enum(['left', 'center', 'right']),
  bg: z.string().optional(),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;
export const ShapeStyleSchema = z.object({
  color: z.string(),
  fill: z.string().nullable(),
  opacity: z.number().min(0).max(1),
  strokeWidth: z.number().min(0).max(60),
  cornerRadius: z.number().min(0).max(200),
  head: z.enum(['none', 'triangle', 'open', 'dot']).default('triangle'),
  curved: z.boolean().default(false),
});
export type ShapeStyle = z.infer<typeof ShapeStyleSchema>;

export const AnnotationSchema = z.discriminatedUnion('type', [
  AnnotationBase.extend({ type: z.literal('text'), text: z.string().max(5000), style: TextStyleSchema }),
  AnnotationBase.extend({
    type: z.literal('shape'),
    shape: z.enum(['arrow', 'line', 'rect', 'ellipse', 'highlight']),
    style: ShapeStyleSchema,
  }),
  AnnotationBase.extend({
    type: z.literal('blur'),
    intensity: z.number().min(0).max(1),
    softness: z.number().min(0).max(1), // 0 = rectangle, 1 = ellipse
    pixelate: z.boolean(),
  }),
  AnnotationBase.extend({
    type: z.literal('spotlight'),
    opacity: z.number().min(0).max(1),
    feather: z.number().min(0).max(1),
    softness: z.number().min(0).max(1),
  }),
  AnnotationBase.extend({ type: z.literal('magnifier'), scale: z.number().min(1).max(6), border: z.string().default('#ffffff') }),
  AnnotationBase.extend({
    type: z.literal('callout'),
    scale: z.number().min(1).max(3),
    popout: z.boolean(),
    marquee: z.boolean(),
    color: z.string(),
    roundness: z.number().min(0).max(1),
    maskOpacity: z.number().min(0).max(1),
  }),
]);
export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationType = Annotation['type'];

export const KeyOverlaySettingsSchema = z.object({
  enabled: z.boolean(),
  singleKeys: z.boolean(),
  styleId: z.string(),
  fontColor: z.string(),
  bgColor: z.string(),
  bgOpacity: z.number().min(0).max(1),
  size: z.number().min(0.3).max(3),
  position: z.union([
    z.enum(['bottom-center', 'bottom-left', 'bottom-right', 'top-center']),
    z.object({ x: N, y: N }),
  ]),
  hiddenEventIds: z.array(z.string()),
});
export type KeyOverlaySettings = z.infer<typeof KeyOverlaySettingsSchema>;

export const AudioSettingsSchema = z.object({
  mic: z.object({ mute: z.boolean(), volume: z.number().min(0).max(3), denoise: z.boolean(), enhance: z.boolean(), balance: z.boolean().default(false) }),
  system: z.object({ mute: z.boolean(), volume: z.number().min(0).max(3) }),
  device: z.object({ mute: z.boolean(), volume: z.number().min(0).max(3) }),
  ducking: z.boolean().default(false),
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;

/** Music range lives in OUTPUT time (§5.3). */
export const MusicTrackSchema = z.object({
  file: z.string(),
  name: z.string().default(''),
  trimStart: Sec,
  trimEnd: Sec,
  volume: z.number().min(0).max(1),
  fadeIn: Sec,
  fadeOut: Sec,
  loop: z.boolean(),
  rangeStart: Sec,
  rangeEnd: Sec,
});
export type MusicTrack = z.infer<typeof MusicTrackSchema>;

export const CaptionStyleSchema = z.object({
  styleId: z.enum(['classic', 'boxed', 'minimal', 'highlight-color', 'highlight-pop']),
  font: z.string(),
  size: z.number().min(8).max(200),
  wordColor: z.string(),
  strokeColor: z.string(),
  strokeWidth: z.number().min(0).max(20),
  shadow: z.object({ color: z.string(), size: z.number().min(0).max(40), x: z.number(), y: z.number(), opacity: z.number().min(0).max(1) }),
  highlightColor: z.string(),
  highlightOpacity: z.number().min(0).max(1),
  position: z.number().min(0).max(1), // 0 = bottom, 1 = top ("higher = up")
  spacing: z.number().min(0.8).max(3),
  bgColor: z.string().optional(),
});
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const CaptionWordSchema = z.object({ w: z.string(), start: Sec, end: Sec });
export const CaptionBlockSchema = z.object({
  id: z.string(),
  start: Sec,
  end: Sec,
  text: z.string(),
  words: z.array(CaptionWordSchema).optional(),
});
export type CaptionBlock = z.infer<typeof CaptionBlockSchema>;
export type CaptionWord = z.infer<typeof CaptionWordSchema>;

export const CaptionTrackSchema = z.object({
  enabled: z.boolean(),
  language: z.string(),
  model: z.enum(['nano', 'basic', 'pro', 'advanced', 'srt']),
  blocks: z.array(CaptionBlockSchema),
  style: CaptionStyleSchema,
});
export type CaptionTrack = z.infer<typeof CaptionTrackSchema>;

export const SmartCutItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['silence', 'filler']),
  start: Sec,
  end: Sec,
  text: z.string().optional(),
  selected: z.boolean(),
  deleted: z.boolean(),
});
export type SmartCutItem = z.infer<typeof SmartCutItemSchema>;
export const SmartCutResultSchema = z.object({
  language: z.string(),
  items: z.array(SmartCutItemSchema),
  transcript: z.array(CaptionWordSchema).default([]),
  initialItems: z.array(SmartCutItemSchema).default([]),
  /** clips before the first applied cut → Reset restores them (CUT-04) */
  clipsBefore: z.array(ClipSchema).optional(),
});
export type SmartCutResult = z.infer<typeof SmartCutResultSchema>;

/** Watermark position lives in OUTPUT (canvas) space. */
export const WatermarkSchema = z.object({
  file: z.string(), // empty when a text watermark is used
  /** text watermark (improvement over image-only) */
  text: z.string().max(120).optional(),
  color: z.string().optional(),
  x: N,
  y: N,
  scale: z.number().min(0.02).max(1),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(),
});
export type Watermark = z.infer<typeof WatermarkSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  name: z.string().min(1).max(200),
  createdAt: z.string(),
  lastOpenedAt: z.string(),
  source: SourceInfoSchema,
  canvas: CanvasSettingsSchema,
  clips: z.array(ClipSchema).min(1),
  zooms: z.array(ZoomSegmentSchema),
  layouts: z.array(LayoutSegmentSchema),
  annotations: z.array(AnnotationSchema),
  cursor: CursorSettingsSchema,
  animation: AnimationSettingsSchema,
  camera: CameraSettingsSchema,
  keys: KeyOverlaySettingsSchema,
  audio: AudioSettingsSchema,
  music: MusicTrackSchema.optional(),
  captions: CaptionTrackSchema.optional(),
  smartCut: SmartCutResultSchema.optional(),
  watermark: WatermarkSchema.optional(),
  appliedPresetId: z.string().optional(),
  /** RM-03: chapter markers (source time) → YouTube description chapters / navigation */
  chapters: z.array(z.object({ id: z.string(), t: Sec, title: z.string().max(100) })).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;
