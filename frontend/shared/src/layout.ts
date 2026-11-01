/**
 * Canvas geometry + camera layouts (plan §6.1, §6.9) — STY-01/02/03/06, CAM-02/03/04/07.
 * All layout rects are canvas-normalised (0..1) and stored per orientation, so custom layouts
 * survive aspect-ratio changes (STY-06).
 */
import type { Aspect, CameraSettings, CanvasSettings, LayoutDef, LayoutSegment, RectN } from './schema';
import { clamp, easeInOutCubic, lerp, smoothstep } from './spring';

export const ASPECTS: Record<Exclude<Aspect, 'auto'>, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '4:5': 4 / 5 };

export const SOCIAL_PRESETS: Array<{ label: string; aspect: Exclude<Aspect, 'auto'>; platforms: string[] }> = [
  { label: 'Landscape', aspect: '16:9', platforms: ['YouTube', 'X', 'LinkedIn'] },
  { label: 'Vertical', aspect: '9:16', platforms: ['TikTok', 'Shorts', 'Reels'] },
  { label: 'Square', aspect: '1:1', platforms: ['Instagram', 'LinkedIn'] },
  { label: 'Portrait', aspect: '4:5', platforms: ['Instagram post', 'LinkedIn', 'Facebook feed'] },
  { label: 'Classic', aspect: '4:3', platforms: ['Slides', 'Presentations'] },
];

/** Effective source size after crop. */
export function croppedSourceSize(srcW: number, srcH: number, crop?: RectN): { w: number; h: number } {
  return crop ? { w: srcW * crop.w, h: srcH * crop.h } : { w: srcW, h: srcH };
}

export function canvasAspect(canvas: CanvasSettings, srcW: number, srcH: number): number {
  if (canvas.aspect !== 'auto') return ASPECTS[canvas.aspect];
  const s = croppedSourceSize(srcW, srcH, canvas.crop);
  return s.w / s.h;
}

/** Output pixel size for a target "p" resolution (short side), even dimensions (H.264 requirement). */
export function outputSize(aspect: number, shortSide: number): { width: number; height: number } {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return aspect >= 1 ? { width: even(shortSide * aspect), height: even(shortSide) } : { width: even(shortSide), height: even(shortSide / aspect) };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Stage rect in canvas pixels: the recording (cropped) fitted inside the padded canvas area.
 * With verticalFill on a narrower canvas, the stage fills the padded area (the camera crops the source).
 */
export function stageRect(canvasW: number, canvasH: number, srcAspect: number, canvas: CanvasSettings, area?: Rect): Rect {
  const region = area ?? { x: 0, y: 0, w: canvasW, h: canvasH };
  const pad = canvas.padding * Math.min(region.w, region.h);
  const availW = Math.max(1, region.w - 2 * pad);
  const availH = Math.max(1, region.h - 2 * pad);
  const availAspect = availW / availH;
  let w: number, h: number;
  if (canvas.verticalFill && availAspect < srcAspect) {
    w = availW;
    h = availH;
  } else if (availAspect > srcAspect) {
    h = availH;
    w = h * srcAspect;
  } else {
    w = availW;
    h = w / srcAspect;
  }
  return { x: region.x + (region.w - w) / 2, y: region.y + (region.h - h) / 2, w, h };
}

// ---------------------------------------------------------------- layout presets (§6.9)

export interface LayoutPreset {
  id: string;
  name: string;
  orientation: 'landscape' | 'portrait';
  def: LayoutDef;
}

const L = (id: string, name: string, screen: RectN, camera: RectN | null, behind = false, roundness?: number): LayoutPreset => ({
  id,
  name,
  orientation: 'landscape',
  def: { orientation: 'landscape', screen, camera, cameraBehindScreen: behind, ...(roundness !== undefined ? { cameraRoundness: roundness } : {}) },
});
const P = (id: string, name: string, screen: RectN, camera: RectN | null, behind = false, roundness?: number): LayoutPreset => ({
  id,
  name,
  orientation: 'portrait',
  def: { orientation: 'portrait', screen, camera, cameraBehindScreen: behind, ...(roundness !== undefined ? { cameraRoundness: roundness } : {}) },
});

const FULL: RectN = { x: 0, y: 0, w: 1, h: 1 };
export const LAYOUT_PRESETS: LayoutPreset[] = [
  // landscape — camera rect is a square in canvas *height* units → see cameraRectPx
  L('pip-br', 'Corner (bottom right)', FULL, { x: 0.8, y: 0.7, w: 0.22, h: 0.22 }),
  L('pip-bl', 'Corner (bottom left)', FULL, { x: 0.02, y: 0.7, w: 0.22, h: 0.22 }),
  L('side', 'Side by side', { x: 0, y: 0, w: 0.65, h: 1 }, { x: 0.66, y: 0.12, w: 0.32, h: 0.76 }, false, 0.15),
  L('behind', 'Camera behind', { x: 0.15, y: 0.15, w: 0.7, h: 0.7 }, FULL, true, 0),
  L('camera-full', 'Camera only', FULL, FULL, false, 0),
  L('screen-only', 'Screen only', FULL, null),
  // portrait
  P('stack-screen-top', 'Screen top, camera bottom', { x: 0, y: 0, w: 1, h: 0.6 }, { x: 0, y: 0.6, w: 1, h: 0.4 }, false, 0),
  P('stack-camera-top', 'Camera top, screen bottom', { x: 0, y: 0.4, w: 1, h: 0.6 }, { x: 0, y: 0, w: 1, h: 0.4 }, false, 0),
  P('circle-bottom', 'Circle camera', { x: 0, y: 0, w: 1, h: 0.75 }, { x: 0.32, y: 0.76, w: 0.36, h: 0.2 }, false, 1),
  P('p-behind', 'Camera behind', { x: 0.06, y: 0.25, w: 0.88, h: 0.5 }, FULL, true, 0),
  P('p-camera-full', 'Camera only', FULL, FULL, false, 0),
  P('p-screen-only', 'Screen only', FULL, null),
];

export const presetsFor = (orientation: 'landscape' | 'portrait'): LayoutPreset[] => LAYOUT_PRESETS.filter((p) => p.orientation === orientation);
export const orientationOf = (aspect: number): 'landscape' | 'portrait' => (aspect >= 1 ? 'landscape' : 'portrait');

/** Map a layout id to the equivalent preset for the other orientation (keeps intent when the canvas flips). */
const CROSS: Record<string, string> = {
  'pip-br': 'circle-bottom', 'pip-bl': 'circle-bottom', side: 'stack-screen-top', behind: 'p-behind', 'camera-full': 'p-camera-full', 'screen-only': 'p-screen-only',
  'stack-screen-top': 'side', 'stack-camera-top': 'side', 'circle-bottom': 'pip-br', 'p-behind': 'behind', 'p-camera-full': 'camera-full', 'p-screen-only': 'screen-only',
};

export function resolveLayout(layoutId: string, custom: LayoutDef | undefined, orientation: 'landscape' | 'portrait'): LayoutDef {
  if (layoutId === 'custom' && custom && custom.orientation === orientation) return custom;
  let p = LAYOUT_PRESETS.find((x) => x.id === layoutId);
  if (p && p.orientation !== orientation) p = LAYOUT_PRESETS.find((x) => x.id === CROSS[p!.id]);
  return (p ?? presetsFor(orientation)[0]!).def;
}

export interface ResolvedLayout {
  screen: RectN;
  camera: RectN | null;
  cameraAlpha: number;
  cameraBehind: boolean;
  cameraRoundness: number | undefined;
  /** the camera rect was drawn by the user (Adjust Layout): render it exactly, never as a PiP square */
  cameraExact?: boolean;
  /** mid-transition: both endpoints + eased progress, so the renderer can interpolate final pixel rects */
  transition?: { from: ResolvedLayout; to: ResolvedLayout; e: number };
}

function lerpRect(a: RectN, b: RectN, k: number): RectN {
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) };
}

/**
 * Layout at SOURCE time s with animated transitions between segments (CAM-04, ≈400 ms).
 * Segments override camera.layoutId; outside segments the default layout applies.
 */
export function layoutAt(segments: readonly LayoutSegment[], camera: CameraSettings, s: number, orientation: 'landscape' | 'portrait'): ResolvedLayout {
  const def = resolveLayout(camera.layoutId, camera.customLayout, orientation);
  const isCustom = (seg: LayoutSegment | null): boolean => {
    const id = seg ? seg.layoutId : camera.layoutId;
    const c = seg ? seg.custom : camera.customLayout;
    return id === 'custom' && !!c && c.orientation === orientation;
  };
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const defOf = (seg: LayoutSegment | null): LayoutDef => (seg ? resolveLayout(seg.layoutId, seg.custom, orientation) : def);
  let cur: LayoutSegment | null = null;
  let prev: LayoutSegment | null = null;
  for (const seg of sorted) {
    if (s >= seg.start && s < seg.end) cur = seg;
  }
  // transition in: from the layout before cur.start to cur
  const toRes = (d: LayoutDef, exact = false): ResolvedLayout => ({
    screen: d.screen,
    camera: d.camera,
    cameraAlpha: d.camera ? 1 : 0,
    cameraBehind: d.cameraBehindScreen,
    cameraRoundness: d.cameraRoundness,
    ...(exact ? { cameraExact: true } : {}),
  });
  const blend = (a: LayoutDef, b: LayoutDef, k: number, aExact: boolean, bExact: boolean): ResolvedLayout => {
    const e = easeInOutCubic(k);
    const ca = a.camera ?? b.camera;
    const cb = b.camera ?? a.camera;
    return {
      screen: lerpRect(a.screen, b.screen, e),
      camera: ca && cb ? lerpRect(ca, cb, e) : null,
      cameraAlpha: lerp(a.camera ? 1 : 0, b.camera ? 1 : 0, e),
      cameraBehind: e < 0.5 ? a.cameraBehindScreen : b.cameraBehindScreen,
      cameraRoundness: a.cameraRoundness !== undefined && b.cameraRoundness !== undefined ? lerp(a.cameraRoundness, b.cameraRoundness, e) : e < 0.5 ? a.cameraRoundness : b.cameraRoundness,
      transition: { from: toRes(a, aExact), to: toRes(b, bExact), e },
    };
  };
  if (cur) {
    for (const seg of sorted) if (seg.end <= cur.start + 1e-6 && seg.end > cur.start - 1e-3) prev = seg;
    const tr = cur.transitionSec;
    if (tr > 0 && s < cur.start + tr) return blend(defOf(prev), defOf(cur), (s - cur.start) / tr, isCustom(prev), isCustom(cur));
    return toRes(defOf(cur), isCustom(cur));
  }
  // after a segment ended, transition back to default
  let ended: LayoutSegment | null = null;
  for (const seg of sorted) if (seg.end <= s) ended = seg;
  if (ended && ended.transitionSec > 0 && s < ended.end + ended.transitionSec) return blend(defOf(ended), def, (s - ended.end) / ended.transitionSec, isCustom(ended), isCustom(null));
  return toRes(def, isCustom(null));
}

/** CAM-07: cameraScale = lerp(1, 0.7, smoothstep(1.0, 1.5, z)). */
export const shrinkOnZoomScale = (z: number): number => lerp(1, 0.7, smoothstep(1.0, 1.5, z));

/**
 * Camera rect in canvas px. PiP presets are defined as squares in canvas-height units so the bubble
 * stays round in any aspect; full/side/stack rects are used as-is. size & shrink scale around the centre.
 */
export function cameraRectPx(rect: RectN, canvasW: number, canvasH: number, size: number, shrink: number, isPip: boolean): Rect {
  let w = rect.w * canvasW;
  let h = rect.h * canvasH;
  let x = rect.x * canvasW;
  let y = rect.y * canvasH;
  if (isPip) {
    const side = Math.min(rect.w, rect.h) * Math.min(canvasW, canvasH) * 1.25;
    const cxn = rect.x + rect.w / 2;
    const cyn = rect.y + rect.h / 2;
    w = h = side;
    x = clamp(cxn * canvasW - side / 2, 0, canvasW - side);
    y = clamp(cyn * canvasH - side / 2, 0, canvasH - side);
  }
  const k = size * shrink;
  if (k !== 1 && isPip) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    w *= k;
    h *= k;
    x = cx - w / 2;
    y = cy - h / 2;
  }
  return { x, y, w, h };
}

export const isPipRect = (r: RectN): boolean => r.w < 0.5 && r.h < 0.5;
