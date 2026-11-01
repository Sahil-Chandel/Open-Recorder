/**
 * Pure geometry for the online recorder (no DOM): crop-rectangle editing, object-fit math, the camera bubble and the
 * mini-editor zoom viewport. Rects are normalised to the source frame (0…1) so they survive preview resizes and
 * source-size changes; pixel values are only derived at the edges (encoder sizes, canvas draws).
 */

/** Normalised rectangle (fractions of the source frame). */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
/** What a pointer drag edits: the whole box, or one edge / corner (compass direction). */
export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const FULL_FRAME: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** Quick crop buttons (kept from the original fixed presets). */
export const CROP_PRESETS: ReadonlyArray<{ id: string; label: string; rect: Rect }> = [
  { id: 'full', label: 'Full', rect: FULL_FRAME },
  { id: 'center', label: 'Center 80%', rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
  { id: 'left', label: 'Left half', rect: { x: 0, y: 0, w: 0.5, h: 1 } },
  { id: 'right', label: 'Right half', rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
];

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Smallest allowed crop: 5 % of the frame or `minPx` source pixels, whichever is larger (never above the frame). */
export function minCropSize(src: Size, minPx = 64, minFrac = 0.05): Size {
  return {
    w: Math.min(1, Math.max(minFrac, minPx / Math.max(1, src.w))),
    h: Math.min(1, Math.max(minFrac, minPx / Math.max(1, src.h))),
  };
}

/** Clamps a rect into the frame and grows it to the minimum size. */
export function normalizeRect(r: Rect, min: Size): Rect {
  const w = clamp(r.w, min.w, 1);
  const h = clamp(r.h, min.h, 1);
  return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h };
}

/**
 * Rect after dragging `handle` by (dx, dy) — normalised deltas measured from the drag start, so repeated pointer moves
 * never accumulate rounding. Edges opposite to the handle stay fixed; the rect never leaves the frame or shrinks below
 * `min`. O(1).
 */
export function dragRect(start: Rect, handle: Handle, dx: number, dy: number, min: Size): Rect {
  const s = normalizeRect(start, min);
  if (handle === 'move') return { ...s, x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h) };
  let l = s.x;
  let t = s.y;
  let r = s.x + s.w;
  let b = s.y + s.h;
  if (handle.includes('w')) l = clamp(l + dx, 0, r - min.w);
  if (handle.includes('e')) r = clamp(r + dx, l + min.w, 1);
  if (handle.includes('n')) t = clamp(t + dy, 0, b - min.h);
  if (handle.includes('s')) b = clamp(b + dy, t + min.h, 1);
  return { x: l, y: t, w: r - l, h: b - t };
}

/** Rect spanned by a new selection dragged from anchor `a` to `b` (normalised), grown to `min` away from the anchor. */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number, min: Size): Rect {
  const a = { x: clamp(ax, 0, 1), y: clamp(ay, 0, 1) };
  const b = { x: clamp(bx, 0, 1), y: clamp(by, 0, 1) };
  let x = Math.min(a.x, b.x);
  let y = Math.min(a.y, b.y);
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (w < min.w) { w = min.w; x = b.x >= a.x ? a.x : a.x - min.w; }
  if (h < min.h) { h = min.h; y = b.y >= a.y ? a.y : a.y - min.h; }
  return normalizeRect({ x, y, w, h }, min);
}

export const sameRect = (a: Rect, b: Rect, eps = 1e-3): boolean =>
  Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps;

export const isFullFrame = (r: Rect): boolean => sameRect(r, FULL_FRAME);

/** Even integer ≥ 2 — H.264 / VP9 with 4:2:0 chroma need even frame dimensions. */
export const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/** Source-pixel rectangle of a crop (what to read from each frame). */
export function cropSource(r: Rect, src: Size): { sx: number; sy: number; sw: number; sh: number } {
  const sx = clamp(Math.round(r.x * src.w), 0, Math.max(0, src.w - 1));
  const sy = clamp(Math.round(r.y * src.h), 0, Math.max(0, src.h - 1));
  const sw = clamp(Math.round(r.w * src.w), 1, src.w - sx);
  const sh = clamp(Math.round(r.h * src.h), 1, src.h - sy);
  return { sx, sy, sw, sh };
}

/** Encoded size of a crop: even dimensions, long edge capped at `maxEdge` (keeps 5K screens encodable in real time). */
export function cropOutputSize(r: Rect, src: Size, maxEdge = 3840): Size {
  const { sw, sh } = cropSource(r, src);
  const k = Math.min(1, maxEdge / Math.max(sw, sh));
  return { w: even(sw * k), h: even(sh * k) };
}

/** Where `content` lands inside `box` with object-fit: contain (centred, letter-boxed). */
export function fitContain(content: Size, box: Size): { left: number; top: number; width: number; height: number } {
  if (content.w <= 0 || content.h <= 0 || box.w <= 0 || box.h <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  const s = Math.min(box.w / content.w, box.h / content.h);
  const width = content.w * s;
  const height = content.h * s;
  return { left: (box.w - width) / 2, top: (box.h - height) / 2, width, height };
}

/**
 * Camera bubble in output pixels: bottom-right circle sized from the SHORT edge, so a portrait crop doesn't get a
 * bubble wider than half the frame. For 1920×1080 this is the original r = 151 px with a 30 px margin.
 */
export function bubbleGeometry(out: Size): { cx: number; cy: number; r: number } {
  const m = Math.min(out.w, out.h);
  const r = Math.round(m * 0.14);
  const margin = Math.round(m * 0.028);
  return { cx: out.w - r - margin, cy: out.h - r - margin, r };
}

/** A manual zoom in the mini editor: [start, end) seconds, focus point (normalised) and magnification. */
export interface Zoom { id: number; start: number; end: number; x: number; y: number; level: number }

const RAMP_SEC = 0.4;
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * Visible source window at time `t`: eases into a zoom over 0.4 s (or half the zoom if shorter), holds, eases out.
 * The window is clamped inside the frame so zooming near an edge never shows outside the picture. O(z) per frame
 * for z zooms (a handful), so no interval tree is needed.
 */
export function zoomViewport(t: number, zooms: readonly Zoom[], src: Size): { sx: number; sy: number; sw: number; sh: number } {
  const z = zooms.find((x) => t >= x.start && t < x.end);
  let level = 1;
  if (z) {
    const ramp = Math.min(RAMP_SEC, (z.end - z.start) / 2);
    const k = smoothstep(clamp(Math.min((t - z.start) / ramp, (z.end - t) / ramp), 0, 1));
    level = 1 + (Math.max(1, z.level) - 1) * k;
  }
  const sw = src.w / level;
  const sh = src.h / level;
  const fx = z ? z.x : 0.5;
  const fy = z ? z.y : 0.5;
  return { sx: clamp(fx * src.w - sw / 2, 0, src.w - sw), sy: clamp(fy * src.h - sh / 2, 0, src.h - sh), sw, sh };
}
