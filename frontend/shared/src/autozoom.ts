/**
 * Auto-zoom generation (plan §6.3) — ZOOM-01/02, M3D-02.
 * Click sessions: greedy single pass over click-downs (O(n)), then O(k log k) merge of segments.
 */
import { cloneData, uid } from './defaults';
import type { ClickEvent, TypingBurst } from './events';
import type { M3D, ZoomFocus, ZoomSegment } from './schema';
import { clamp } from './spring';

export const AUTO_ZOOM_PARAMS = {
  leadIn: 0.5,
  hold: 1.8,
  maxGap: 2.5,
  maxJump: 0.35,
  mergeGap: 0.8,
  minLen: 1.2,
  defaultZoom: 2.0,
  minZoom: 1.25,
  maxZoom: 4.0,
  margin: 0.12,
};
export type AutoZoomParams = typeof AUTO_ZOOM_PARAMS;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
function bbox(cs: readonly ClickEvent[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cs) {
    x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export const DEFAULT_M3D = (auto: boolean): M3D => ({
  auto,
  intensity: 'default',
  tilt: { x: 8, y: -12, z: 0, fov: 45 },
  position: { x: 0, y: 0 },
  recipe: 'none',
});

export function makeZoom(
  start: number,
  end: number,
  level: number,
  focus: ZoomFocus,
  source: ZoomSegment['source'],
  mode: '2d' | '3d' = '2d',
): ZoomSegment {
  const z: ZoomSegment = { id: uid('zoom'), start: Math.max(0, start), end, enabled: true, source, mode, level, focus };
  if (mode === '3d') z.m3d = DEFAULT_M3D(source !== 'manual');
  return z;
}

/** Merge segments whose gap < mergeGap. Keeps the higher level and 'follow' focus when merging differing focuses. */
export function mergeOverlaps(segs: ZoomSegment[], mergeGap: number): ZoomSegment[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out: ZoomSegment[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && s.start - prev.end < mergeGap) {
      prev.end = Math.max(prev.end, s.end);
      prev.level = Math.max(prev.level, s.level);
      if (prev.focus.type !== s.focus.type) prev.focus = { type: 'follow' };
      if (prev.source !== s.source) prev.source = 'auto-click';
    } else out.push({ ...s });
  }
  return out;
}

export function autoZooms(
  clicks: readonly ClickEvent[],
  typing: readonly TypingBurst[],
  opts: { duration: number; mode?: '2d' | '3d'; params?: Partial<AutoZoomParams> } = { duration: Infinity },
): ZoomSegment[] {
  const P = { ...AUTO_ZOOM_PARAMS, ...opts.params };
  const mode = opts.mode ?? '2d';
  const sessions: ClickEvent[][] = [];
  for (const c of clicks) {
    if (c.phase !== 'down') continue;
    const s = sessions[sessions.length - 1];
    const last = s?.[s.length - 1];
    const newSession = !last || c.t - last.t > P.maxGap || (c.t - last.t > 1 && dist(c, centre(bbox(s!))) > P.maxJump);
    if (newSession) sessions.push([c]);
    else s!.push(c);
  }
  const segs = sessions.map((s) => {
    const b = bbox(s);
    const fit = Math.min(1 / (b.w + P.margin), 1 / (b.h + P.margin));
    const level = clamp(Math.min(P.defaultZoom, fit), P.minZoom, P.maxZoom);
    return makeZoom(s[0]!.t - P.leadIn, s[s.length - 1]!.t + P.hold, level, { type: 'follow' }, 'auto-click', mode);
  });
  for (const b of typing) {
    segs.push(
      makeZoom(b.start - 0.5, b.end + 1.0, P.defaultZoom, b.caret ? { type: 'fixed', x: b.caret.x, y: b.caret.y } : { type: 'follow' }, 'auto-typing', mode),
    );
  }
  return mergeOverlaps(segs, P.mergeGap)
    .map((z) => ({ ...z, end: Math.min(z.end, opts.duration) }))
    .filter((z) => z.end - z.start >= P.minLen);
}

/** Zoom covering source time s (last wins on overlap — manual zooms are appended last). O(n). */
export function zoomAt(zooms: readonly ZoomSegment[], s: number): ZoomSegment | null {
  let hit: ZoomSegment | null = null;
  for (const z of zooms) if (z.enabled && s >= z.start && s < z.end) hit = z;
  return hit;
}

/** Split a zoom at source time s; both parts keep settings and can be re-targeted (ZOOM-05). */
export function splitZoom(zooms: readonly ZoomSegment[], id: string, s: number): ZoomSegment[] {
  const out: ZoomSegment[] = [];
  for (const z of zooms) {
    if (z.id === id && s > z.start + 0.1 && s < z.end - 0.1) {
      out.push({ ...z, end: s }, { ...cloneData(z), id: uid('zoom'), start: s });
    } else out.push(z);
  }
  return out;
}

/** Apply level/mode/focus/m3d of one zoom to all (ZOOM-05 "Apply to all"). */
export function applyZoomSettingsToAll(zooms: readonly ZoomSegment[], fromId: string): ZoomSegment[] {
  const src = zooms.find((z) => z.id === fromId);
  if (!src) return zooms.slice();
  return zooms.map((z) => (z.id === fromId ? z : { ...z, level: src.level, mode: src.mode, m3d: src.m3d ? cloneData(src.m3d) : undefined }));
}
