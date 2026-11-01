/**
 * evaluateScene (plan §6.14): pure function OUTPUT time → everything the compositor draws.
 * Used identically by preview and export → "what you see = what you export".
 */
import { blockAt, activeWordIndex } from './captions';
import { cameraAt, baseViewport, computeCameraTrack, type CameraState } from './camera';
import { activeClicks, clicksToOutput, computeCursorTrack, cursorStateAt, type CursorState, type OutputClick } from './cursor';
import { buildShortcutEvents, CURSOR_HIDDEN, cursorAt, detectTypingBursts, speedUpSuggestions, type ShortcutEvent, type SpeedUpSuggestion, type Telemetry, type TypingBurst } from './events';
import { canvasAspect, croppedSourceSize, isPipRect, layoutAt, orientationOf, shrinkOnZoomScale, stageRect, type Rect, type ResolvedLayout } from './layout';
import type { Annotation, CaptionBlock, Project } from './schema';
import { clamp, type SampledTrack, lerp } from './spring';
import { outToSrc, outputDuration } from './time';

export interface Derived {
  telemetry: Telemetry;
  cameraTrack: SampledTrack;
  cursorTrack: SampledTrack;
  outClicks: OutputClick[];
  shortcuts: ShortcutEvent[];
  typing: TypingBurst[];
  speedUps: SpeedUpSuggestion[];
  duration: number;
  canvasAspect: number;
  sourceAspect: number;
}

/** Recompute derived tracks. Callers memoise on (project.clips, zooms, animation, cursor, canvas) identity. */
/**
 * The project parts buildDerived reads. Immer keeps unchanged subtrees identical, so comparing these by
 * reference tells whether an edit (e.g. typing in a text annotation or a caption) can skip the O(duration)
 * camera / cursor simulation.
 */
export function derivedInputs(p: Project): readonly unknown[] {
  return [p.source, p.clips, p.zooms, p.animation, p.cursor, p.canvas, p.camera, p.keys.singleKeys];
}

export function buildDerived(project: Project, telemetry: Telemetry, mac = false): Derived {
  const src = croppedSourceSize(project.source.width, project.source.height, project.canvas.crop);
  const sourceAspect = src.w / src.h;
  const cAspect = canvasAspect(project.canvas, project.source.width, project.source.height);
  // the stage aspect for vertical fill uses the screen region of the current default layout
  const orientation = orientationOf(cAspect);
  const lay = layoutAt([], project.camera, 0, orientation);
  const stageAspect = (cAspect * lay.screen.w) / lay.screen.h;
  const viewport = baseViewport(sourceAspect, stageAspect, project.canvas.verticalFill);
  const crop = project.canvas.crop;
  // telemetry is in full-source normalised coords → map into cropped space
  const toCrop = crop
    ? (p: { x: number; y: number }) => ({ x: (p.x - crop.x) / crop.w, y: (p.y - crop.y) / crop.h })
    : (p: { x: number; y: number }) => p;
  const cursor = crop ? telemetry.cursor.map((c) => ({ ...c, ...toCrop(c) })) : telemetry.cursor;
  const clicks = crop ? telemetry.clicks.map((c) => ({ ...c, ...toCrop(c) })) : telemetry.clicks;
  const zooms = project.source.hasTelemetry || project.zooms.length ? project.zooms : [];
  const cameraTrack = computeCameraTrack({ clips: project.clips, zooms, cursor, animation: project.animation, fixedZoom: project.canvas.fixedZoom, viewport });
  const cursorTrack = computeCursorTrack({ clips: project.clips, cursor, clicks, settings: project.cursor, animation: project.animation, aspect: sourceAspect });
  const typing = detectTypingBursts(telemetry.keys, telemetry.clicks);
  return {
    telemetry: { cursor, clicks, keys: telemetry.keys },
    cameraTrack,
    cursorTrack,
    outClicks: clicksToOutput(clicks, project.clips),
    shortcuts: buildShortcutEvents(telemetry.keys, project.keys.singleKeys, mac),
    typing,
    speedUps: speedUpSuggestions(typing),
    duration: outputDuration(project.clips),
    canvasAspect: cAspect,
    sourceAspect,
  };
}

export interface AnnotationInstance {
  a: Annotation;
  /** 0..1 in-animation progress, 1 = fully visible; out-animation reduces it again. */
  appear: number;
  phase: 'in' | 'hold' | 'out';
}

export interface SceneState {
  tOut: number;
  src: number;
  clipIndex: number;
  canvas: { w: number; h: number };
  /** screen region (layout) in canvas px, before padding */
  screenRegion: Rect;
  /** stage rect in canvas px (z = 1) */
  stage: Rect;
  sourceAspect: number;
  viewport: { w: number; h: number };
  cam: CameraState;
  camPrev: CameraState; // for motion blur (shutter Δ)
  cursor: (CursorState & { prevX: number; prevY: number }) | null;
  clicks: Array<OutputClick & { progress: number }>;
  cameraLayer: { rect: Rect; alpha: number; behind: boolean; roundness: number; scale: number } | null;
  annotations: AnnotationInstance[];
  caption: { block: CaptionBlock; word: number } | null;
  keys: Array<{ ev: ShortcutEvent; alpha: number }>;
  watermark: boolean;
}

function annotationPhase(a: Annotation, s: number): AnnotationInstance | null {
  if (s < a.start || s >= a.end) return null;
  const d = Math.max(0.001, a.anim.durSec);
  const sinceIn = s - a.start;
  const untilOut = a.end - s;
  if (a.anim.in !== 'none' && sinceIn < d) return { a, appear: sinceIn / d, phase: 'in' };
  if (a.anim.out !== 'none' && untilOut < d) return { a, appear: untilOut / d, phase: 'out' };
  return { a, appear: 1, phase: 'hold' };
}

export function evaluateScene(project: Project, d: Derived, tOut: number, canvasW: number, canvasH: number, fps = 60): SceneState {
  const t = clamp(tOut, 0, d.duration);
  const { src, clipIndex, clip } = outToSrc(project.clips, t);
  const orientation = orientationOf(canvasW / canvasH);
  const hasCamera = Boolean(project.source.tracks.camera || project.camera.avatar || project.camera.facecam) && project.camera.visible;
  const lay = layoutAt(hasCamera ? project.layouts : [], project.camera, src, orientation);
  const screenNorm = hasCamera ? lay.screen : { x: 0, y: 0, w: 1, h: 1 };
  const screenRegion = { x: screenNorm.x * canvasW, y: screenNorm.y * canvasH, w: screenNorm.w * canvasW, h: screenNorm.h * canvasH };
  const stage = stageRect(canvasW, canvasH, d.sourceAspect, project.canvas, screenRegion);
  const viewport = baseViewport(d.sourceAspect, stage.w / stage.h, project.canvas.verticalFill);
  const cam = cameraAt(d.cameraTrack, t);
  const blur = project.animation.motionBlur;
  const shutter = blur.enabled ? (Math.max(blur.zoom, blur.screen) / 100) * (1 / fps) : 0;
  const camPrev = shutter > 0 ? cameraAt(d.cameraTrack, Math.max(0, t - shutter)) : cam;

  let cursor: SceneState['cursor'] = null;
  if (project.source.hasTelemetry && project.cursor.show && clip.showCursor) {
    const raw = cursorAt(d.telemetry.cursor, src);
    const cs = cursorStateAt(d.cursorTrack, t, raw.shape);
    const cShutter = blur.enabled ? (blur.cursor / 100) * (1 / fps) : 0;
    const prev = cShutter > 0 ? cursorStateAt(d.cursorTrack, Math.max(0, t - cShutter), raw.shape) : cs;
    if (cs.visibility > 0.001 && raw.shape !== CURSOR_HIDDEN) cursor = { ...cs, prevX: prev.x, prevY: prev.y };
  }
  const clicks = project.source.hasTelemetry && project.cursor.clickEffect.id && cursor ? activeClicks(d.outClicks, t) : [];

  let cameraLayer: SceneState['cameraLayer'] = null;
  if (hasCamera && lay.camera && lay.cameraAlpha > 0.001) {
    // preset PiP rects become squares sized by camera.size; full / side / stack rects and user-drawn rects are
    // used as-is. Transitions interpolate the two FINAL pixel rects, so PiP ↔ full never jumps mid-way.
    const place = (l: ResolvedLayout): { rect: Rect; roundness: number; shrink: number } | null => {
      const r = l.camera;
      if (!r) return null;
      const pip = !l.cameraExact && isPipRect(r);
      const shrink = project.camera.shrinkOnZoom && (pip || l.cameraExact) ? shrinkOnZoomScale(cam.z) : 1;
      if (!pip) {
        const w = r.w * canvasW * shrink, h = r.h * canvasH * shrink;
        const cx = (r.x + r.w / 2) * canvasW, cy = (r.y + r.h / 2) * canvasH;
        return { rect: { x: cx - w / 2, y: cy - h / 2, w, h }, roundness: l.cameraRoundness ?? (l.cameraExact ? project.camera.roundness : Math.min(project.camera.roundness, 0.15)), shrink };
      }
      const side = Math.min(r.w, r.h) * Math.min(canvasW, canvasH) * 1.25 * project.camera.size * shrink;
      const cx = clamp((r.x + r.w / 2) * canvasW, side / 2, canvasW - side / 2);
      const cy = clamp((r.y + r.h / 2) * canvasH, side / 2, canvasH - side / 2);
      return { rect: { x: cx - side / 2, y: cy - side / 2, w: side, h: side }, roundness: project.camera.roundness, shrink };
    };
    let placed = place(lay);
    if (lay.transition) {
      const a = place(lay.transition.from), b = place(lay.transition.to);
      const e = lay.transition.e;
      if (a && b) {
        placed = {
          rect: { x: lerp(a.rect.x, b.rect.x, e), y: lerp(a.rect.y, b.rect.y, e), w: lerp(a.rect.w, b.rect.w, e), h: lerp(a.rect.h, b.rect.h, e) },
          roundness: lerp(a.roundness, b.roundness, e),
          shrink: lerp(a.shrink, b.shrink, e),
        };
      } else placed = a ?? b ?? placed; // camera appears / disappears: fade at its final position
    }
    if (placed) cameraLayer = { rect: placed.rect, alpha: lay.cameraAlpha, behind: lay.cameraBehind, roundness: placed.roundness, scale: placed.shrink };
  }

  const annotations: AnnotationInstance[] = [];
  for (const a of project.annotations) {
    const inst = annotationPhase(a, src);
    if (inst) annotations.push(inst);
  }
  annotations.sort((x, y) => x.a.lane - y.a.lane);

  let caption: SceneState['caption'] = null;
  if (project.captions?.enabled) {
    const b = blockAt(project.captions.blocks, src);
    if (b) caption = { block: b, word: activeWordIndex(b, src) };
  }

  const keys: SceneState['keys'] = [];
  if (project.keys.enabled && project.source.hasTelemetry) {
    const hidden = new Set(project.keys.hiddenEventIds);
    for (const ev of d.shortcuts) {
      if (hidden.has(ev.id)) continue;
      const dt = src - ev.t;
      if (dt < 0 || dt > ev.duration + 0.25) continue;
      const alpha = dt < 0.08 ? dt / 0.08 : dt > ev.duration ? 1 - (dt - ev.duration) / 0.25 : 1;
      keys.push({ ev, alpha: clamp(alpha, 0, 1) });
    }
    keys.splice(0, Math.max(0, keys.length - 3)); // show at most the last 3 combos
  }

  return {
    tOut: t,
    src,
    clipIndex,
    canvas: { w: canvasW, h: canvasH },
    screenRegion,
    stage,
    sourceAspect: d.sourceAspect,
    viewport,
    cam,
    camPrev,
    cursor,
    clicks,
    cameraLayer,
    annotations,
    caption,
    keys,
    watermark: Boolean(project.watermark?.visible),
  };
}

/**
 * Stage transform helpers (§6.1): map a normalised source point to canvas px under camera (cx,cy,z).
 * The camera scales the stage around the stage centre and translates so (cx,cy) lands at the centre.
 */
export function sourceToCanvas(stage: Rect, viewport: { w: number; h: number }, cam: { z: number; cx: number; cy: number }, p: { x: number; y: number }): { x: number; y: number } {
  // full source size in px at z = 1, given the viewport fraction visible in the stage
  const fullW = stage.w / viewport.w;
  const fullH = stage.h / viewport.h;
  const sx = stage.x + stage.w / 2 + (p.x - cam.cx) * fullW * cam.z;
  const sy = stage.y + stage.h / 2 + (p.y - cam.cy) * fullH * cam.z;
  return { x: sx, y: sy };
}

export function canvasToSource(stage: Rect, viewport: { w: number; h: number }, cam: { z: number; cx: number; cy: number }, q: { x: number; y: number }): { x: number; y: number } {
  const fullW = stage.w / viewport.w;
  const fullH = stage.h / viewport.h;
  return { x: cam.cx + (q.x - stage.x - stage.w / 2) / (fullW * cam.z), y: cam.cy + (q.y - stage.y - stage.h / 2) / (fullH * cam.z) };
}
