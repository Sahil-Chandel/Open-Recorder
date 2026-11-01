/**
 * Virtual camera path (plan §6.5, §6.8) — ZOOM-03/05/06, STY-02/03, M3D-*.
 * Simulated in OUTPUT time so speed-ups/cuts feel natural; targets are looked up in SOURCE time.
 * Track channels: z, cx, cy, m3d(0..1), rx, ry, rz, px, py, fov.
 */
import { zoomAt } from './autozoom';
import { cursorAt, type CursorSample } from './events';
import type { AnimationSettings, Clip, M3D, ZoomSegment } from './schema';
import { clamp, resolveSpring, simulateSprings, type SampledTrack } from './spring';
import { outToSrc, outputDuration } from './time';

export const CAM = { Z: 0, CX: 1, CY: 2, M3D: 3, RX: 4, RY: 5, RZ: 6, PX: 7, PY: 8, FOV: 9 } as const;
export const CAM_CHANNELS = 10;

export interface CameraState {
  z: number;
  cx: number;
  cy: number;
  m3d: number;
  rx: number;
  ry: number;
  rz: number;
  px: number;
  py: number;
  fov: number;
}

export const MAX_TILT = { subtle: 6, default: 10, strong: 16 } as const;

/** Viewport size (normalised source units) at zoom 1 — aspect-aware for vertical fill (§6.5). */
export function baseViewport(sourceAspect: number, stageAspect: number, verticalFill: boolean): { w: number; h: number } {
  if (!verticalFill || stageAspect >= sourceAspect) return { w: 1, h: 1 };
  return { w: stageAspect / sourceAspect, h: 1 };
}

export interface CameraInputs {
  clips: readonly Clip[];
  zooms: readonly ZoomSegment[];
  cursor: readonly CursorSample[];
  animation: AnimationSettings;
  fixedZoom: boolean;
  viewport: { w: number; h: number };
}

const TILT_PRESETS: Array<M3D['tilt']> = [
  { x: 8, y: -12, z: 0, fov: 45 },
  { x: 8, y: 12, z: 0, fov: 45 },
  { x: 14, y: 0, z: 0, fov: 45 },
  { x: -10, y: -16, z: 2, fov: 50 },
  { x: 18, y: -20, z: -4, fov: 40 },
  { x: 0, y: -24, z: 0, fov: 55 },
];
export const tiltPresets = (): Array<M3D['tilt']> => TILT_PRESETS.map((t) => ({ ...t }));

/** Is there meaningful mouse activity inside [a,b)? Used for auto→manual 3D fallback (M3D-04). */
export function hasMouseActivity(cursor: readonly CursorSample[], a: number, b: number, eps = 0.01): boolean {
  let first: CursorSample | undefined;
  for (const c of cursor) {
    if (c.t < a) continue;
    if (c.t >= b) break;
    if (!first) first = c;
    else if (Math.hypot(c.x - first.x, c.y - first.y) > eps) return true;
  }
  return false;
}

/**
 * Where a follow-zoom points when it must not pan (Fixed Zoom Part, STY-03): the mean cursor position
 * while the zoom is active (≈ the click/typing area that created it), falling back to the cursor at its start.
 * Cursor samples are time-sorted, so the window is found by binary search.
 */
export function zoomActivityCentre(cursor: readonly CursorSample[], start: number, end: number): { x: number; y: number } {
  if (!cursor.length) return { x: 0.5, y: 0.5 };
  let lo = 0, hi = cursor.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cursor[mid]!.t < start) lo = mid + 1;
    else hi = mid;
  }
  let sx = 0, sy = 0, n = 0;
  for (let i = lo; i < cursor.length && cursor[i]!.t < end; i++) {
    sx += cursor[i]!.x;
    sy += cursor[i]!.y;
    n++;
  }
  if (n) return { x: sx / n, y: sy / n };
  const c = cursorAt(cursor, start);
  return { x: c.x, y: c.y };
}

export function computeCameraTrack(inp: CameraInputs): SampledTrack {
  const dur = outputDuration(inp.clips);
  const spring = resolveSpring(inp.animation.zoomPan);
  const { w: vw0, h: vh0 } = inp.viewport;
  const activity = new Map<string, boolean>();
  const fixedFocus = new Map<string, { x: number; y: number }>();
  const init = [1, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 45];

  return simulateSprings(dur, CAM_CHANNELS, spring, init, (t, st, tgt) => {
    const { src } = outToSrc(inp.clips, t);
    const zoom = zoomAt(inp.zooms, src);
    const z = zoom ? zoom.level : 1;
    const halfW = (vw0 / z) / 2;
    const halfH = (vh0 / z) / 2;
    let cx = st[CAM.CX]!;
    let cy = st[CAM.CY]!;
    const followCursor = vw0 < 1 || !!zoom; // vertical fill pans even without a zoom
    if (followCursor) {
      let p: { x: number; y: number };
      if (zoom && (zoom.focus.type === 'fixed' || inp.fixedZoom)) {
        if (zoom.focus.type === 'fixed') p = zoom.focus;
        else {
          // locking to the current camera centre made every fixed zoom land on the middle of the screen
          let f = fixedFocus.get(zoom.id);
          if (!f) fixedFocus.set(zoom.id, (f = zoomActivityCentre(inp.cursor, zoom.start, zoom.end)));
          p = f;
        }
        cx = p.x;
        cy = p.y;
      } else {
        p = inp.cursor.length ? cursorAt(inp.cursor, src) : { x: 0.5, y: 0.5 };
        const deadW = halfW * 0.6;
        const deadH = halfH * 0.6;
        if (p.x < cx - deadW) cx = p.x + deadW;
        else if (p.x > cx + deadW) cx = p.x - deadW;
        if (p.y < cy - deadH) cy = p.y + deadH;
        else if (p.y > cy + deadH) cy = p.y - deadH;
      }
    } else {
      cx = 0.5;
      cy = 0.5;
    }
    tgt[CAM.Z] = z;
    tgt[CAM.CX] = halfW >= 0.5 ? 0.5 : clamp(cx, halfW, 1 - halfW);
    tgt[CAM.CY] = halfH >= 0.5 ? 0.5 : clamp(cy, halfH, 1 - halfH);

    // 3D channels
    if (zoom && zoom.mode === '3d') {
      const m = zoom.m3d ?? { auto: true, intensity: 'default' as const, tilt: TILT_PRESETS[0]!, position: { x: 0, y: 0 }, recipe: 'none' as const };
      let auto = m.auto;
      if (auto) {
        let a = activity.get(zoom.id);
        if (a === undefined) {
          a = hasMouseActivity(inp.cursor, zoom.start, zoom.end);
          activity.set(zoom.id, a);
        }
        auto = a;
      }
      tgt[CAM.M3D] = 1;
      if (auto) {
        const p = inp.cursor.length ? cursorAt(inp.cursor, src) : { x: 0.5, y: 0.5 };
        const max = MAX_TILT[m.intensity];
        // cursor relative to the current viewport centre, normalised to ±0.5
        const rx = clamp((p.x - st[CAM.CX]!) / (2 * halfW), -0.5, 0.5);
        const ry = clamp((p.y - st[CAM.CY]!) / (2 * halfH), -0.5, 0.5);
        tgt[CAM.RY] = rx * 2 * max;
        tgt[CAM.RX] = -ry * 2 * max;
        tgt[CAM.RZ] = 0;
        tgt[CAM.FOV] = 45;
        tgt[CAM.PX] = 0;
        tgt[CAM.PY] = 0;
      } else {
        tgt[CAM.RX] = m.tilt.x;
        tgt[CAM.RY] = m.tilt.y;
        tgt[CAM.RZ] = m.tilt.z;
        tgt[CAM.FOV] = m.tilt.fov;
        let px = m.position.x;
        if (m.recipe === 'entrance') {
          const k = (src - zoom.start) / Math.max(zoom.end - zoom.start, 0.001);
          px = k < 0.05 ? 0.8 : 0; // spring carries the stage in from +80 %
        }
        tgt[CAM.PX] = px;
        tgt[CAM.PY] = m.position.y;
      }
      if (m.focusArea && !auto) {
        tgt[CAM.CX] = clamp(m.focusArea.x + m.focusArea.w / 2, halfW, 1 - halfW);
        tgt[CAM.CY] = clamp(m.focusArea.y + m.focusArea.h / 2, halfH, 1 - halfH);
      }
    } else {
      tgt[CAM.M3D] = 0;
      tgt[CAM.RX] = 0;
      tgt[CAM.RY] = 0;
      tgt[CAM.RZ] = 0;
      tgt[CAM.PX] = 0;
      tgt[CAM.PY] = 0;
      tgt[CAM.FOV] = 45;
    }
  });
}

const scratch = new Float64Array(CAM_CHANNELS);
export function cameraAt(track: SampledTrack, t: number): CameraState {
  const s = track.sample(t, scratch);
  return {
    z: Math.max(1, s[CAM.Z]!),
    cx: s[CAM.CX]!,
    cy: s[CAM.CY]!,
    m3d: clamp(s[CAM.M3D]!, 0, 1),
    rx: s[CAM.RX]!,
    ry: s[CAM.RY]!,
    rz: s[CAM.RZ]!,
    px: s[CAM.PX]!,
    py: s[CAM.PY]!,
    fov: s[CAM.FOV]!,
  };
}

/** zoomLevelAt(t) for camera shrink-on-zoom (task 5.8). */
export function zoomLevelAt(track: SampledTrack, t: number): number {
  return Math.max(1, track.sample(t, scratch)[CAM.Z]!);
}
