/**
 * Original visual assets, generated procedurally (plan §10: features yes, assets no):
 * gradients, wallpapers, 40 cursor styles × 14 semantic shapes, 8 click effects, camera filters.
 */

export interface GradientDef { id: string; name: string; colors: [string, string, string]; angle: number }
export const GRADIENTS: GradientDef[] = [
  { id: 'sunset', name: 'Sunset', colors: ['#ff7e5f', '#feb47b', '#ffd194'], angle: 45 },
  { id: 'ocean', name: 'Ocean', colors: ['#2e3192', '#1bffff', '#a8edea'], angle: 135 },
  { id: 'violet', name: 'Violet', colors: ['#41295a', '#7c5cff', '#2f0743'], angle: 90 },
  { id: 'mint', name: 'Mint', colors: ['#0fd850', '#4cd7c0', '#f9f047'], angle: 30 },
  { id: 'night', name: 'Night', colors: ['#0f2027', '#203a43', '#2c5364'], angle: 160 },
  { id: 'peach', name: 'Peach', colors: ['#ffecd2', '#fcb69f', '#ff9a9e'], angle: 60 },
  { id: 'steel', name: 'Steel', colors: ['#bdc3c7', '#8e9eab', '#2c3e50'], angle: 100 },
  { id: 'candy', name: 'Candy', colors: ['#f093fb', '#f5576c', '#ffd452'], angle: 20 },
  { id: 'forest', name: 'Forest', colors: ['#134e5e', '#2b7a4b', '#71b280'], angle: 120 },
  { id: 'mono', name: 'Graphite', colors: ['#232526', '#3a3d40', '#414345'], angle: 90 },
];

export interface WallpaperDef { id: string; name: string; pattern: number; colors: [string, string, string] }
export const WALLPAPERS: WallpaperDef[] = [
  { id: 'aurora', name: 'Aurora', pattern: 0, colors: ['#1a1446', '#6b4bff', '#38e1c6'] },
  { id: 'lagoon', name: 'Lagoon', pattern: 1, colors: ['#03122b', '#0f6ba8', '#8fe3ff'] },
  { id: 'ember', name: 'Ember', pattern: 2, colors: ['#ffb36b', '#e8456b', '#2a0b2e'] },
  { id: 'prism', name: 'Prism', pattern: 3, colors: ['#ff6ec7', '#7873f5', '#4ade80'] },
  { id: 'dunes', name: 'Dunes', pattern: 4, colors: ['#f8d9a0', '#e39b5b', '#6b3a2e'] },
  { id: 'glacier', name: 'Glacier', pattern: 0, colors: ['#e0f2ff', '#8ec5fc', '#4361ee'] },
  { id: 'meadow', name: 'Meadow', pattern: 1, colors: ['#e8ffd8', '#7ed957', '#1b5e20'] },
  { id: 'dusk', name: 'Dusk', pattern: 2, colors: ['#fbc2eb', '#a18cd1', '#2b2050'] },
  { id: 'citrus', name: 'Citrus', pattern: 3, colors: ['#fff27a', '#ffb347', '#ff5e62'] },
  { id: 'abyss', name: 'Abyss', pattern: 4, colors: ['#1e3c72', '#2a5298', '#0b1020'] },
  { id: 'rosewater', name: 'Rosewater', pattern: 0, colors: ['#fff1eb', '#ffc3a0', '#d4699e'] },
  { id: 'carbon', name: 'Carbon', pattern: 1, colors: ['#0d0d12', '#2a2a36', '#55556a'] },
];

export const SOLID_COLORS = ['#0e0e13', '#ffffff', '#f4f4f5', '#111827', '#1e293b', '#7c5cff', '#2563eb', '#16a34a', '#f59e0b', '#ef4444', '#ec4899', '#0ea5e9'];

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}

// ---------------------------------------------------------------- cursors (CUR-03)

/** Semantic shape ids — shared with the native helpers (InputRecorder.SystemCursors). */
export const SHAPES = ['arrow', 'ibeam', 'pointer', 'crosshair', 'ns-resize', 'ew-resize', 'nwse-resize', 'nesw-resize', 'move', 'not-allowed', 'wait', 'progress', 'help', 'up-arrow'] as const;
export type ShapeName = (typeof SHAPES)[number];

/** Path data in a 32×32 box + hotspot. Original drawings. */
const SHAPE_SVG: Record<ShapeName, { d: string; hot: [number, number]; stroke?: boolean }> = {
  arrow: { d: 'M7 3 L7 25 L12.6 19.6 L16.4 28.2 L20 26.6 L16.3 18.2 L23.6 18.2 Z', hot: [7, 3] },
  pointer: { d: 'M12 4.5c0-1.4 2.4-1.4 2.4 0V14l1-.2V12c0-1.3 2.3-1.3 2.3 0v2l.9-.1v-1.2c0-1.3 2.3-1.3 2.3 0v1.6l.8-.1c0-1.2 2.2-1.2 2.2.1v6.4c0 4-2.6 7.3-6.6 7.3h-1.6c-2.4 0-4-1-5.2-3l-3.6-6.2c-.7-1.2 1-2.5 2.1-1.4l2.5 2.6z', hot: [13, 4] },
  ibeam: { d: 'M11 5h10M16 5v22M11 27h10M13 16h6', hot: [16, 16], stroke: true },
  crosshair: { d: 'M16 4v9M16 19v9M4 16h9M19 16h9', hot: [16, 16], stroke: true },
  'ns-resize': { d: 'M16 3 L22 10 L18 10 L18 22 L22 22 L16 29 L10 22 L14 22 L14 10 L10 10 Z', hot: [16, 16] },
  'ew-resize': { d: 'M3 16 L10 10 L10 14 L22 14 L22 10 L29 16 L22 22 L22 18 L10 18 L10 22 Z', hot: [16, 16] },
  'nwse-resize': { d: 'M6 6 L15 6 L12 9 L23 20 L26 17 L26 26 L17 26 L20 23 L9 12 L6 15 Z', hot: [16, 16] },
  'nesw-resize': { d: 'M26 6 L26 15 L23 12 L12 23 L15 26 L6 26 L6 17 L9 20 L20 9 L17 6 Z', hot: [16, 16] },
  move: { d: 'M16 2 L21 7 L18 7 L18 14 L25 14 L25 11 L30 16 L25 21 L25 18 L18 18 L18 25 L21 25 L16 30 L11 25 L14 25 L14 18 L7 18 L7 21 L2 16 L7 11 L7 14 L14 14 L14 7 L11 7 Z', hot: [16, 16] },
  'not-allowed': { d: 'M16 5a11 11 0 1 0 0.01 0zM8.5 8.5L23.5 23.5', hot: [16, 16], stroke: true },
  wait: { d: 'M16 5a11 11 0 1 1 -11 11', hot: [16, 16], stroke: true },
  progress: { d: 'M5 3 L5 21 L9.5 16.6 L12.6 23.6 L15.4 22.4 L12.4 15.6 L18.4 15.6 Z M24 19a5 5 0 1 1 -5 5', hot: [5, 3] },
  help: { d: 'M5 3 L5 21 L9.5 16.6 L12.6 23.6 L15.4 22.4 L12.4 15.6 L18.4 15.6 Z M21 14c0-3 5-3 5 0 0 2-2.5 2-2.5 4M23.5 21v1', hot: [5, 3] },
  'up-arrow': { d: 'M16 3 L25 13 L19 13 L19 28 L13 28 L13 13 L7 13 Z', hot: [16, 3] },
};

export interface CursorStyle { id: string; name: string; fill: string; stroke: string; strokeWidth: number; shadow: boolean; kind: 'shape' | 'dot' | 'ring' }
const PALETTE: Array<[string, string, string]> = [
  ['white', '#ffffff', '#111111'], ['black', '#111111', '#ffffff'], ['violet', '#7c5cff', '#ffffff'], ['blue', '#2f7cf6', '#ffffff'],
  ['green', '#22c55e', '#ffffff'], ['yellow', '#facc15', '#111111'], ['orange', '#fb923c', '#ffffff'], ['red', '#ef4444', '#ffffff'],
  ['pink', '#ec4899', '#ffffff'], ['teal', '#14b8a6', '#ffffff'],
];
export const CURSOR_STYLES: CursorStyle[] = PALETTE.flatMap(([n, fill, stroke]) => [
  { id: `classic-${n}`, name: `Classic ${n}`, fill, stroke, strokeWidth: 1.6, shadow: true, kind: 'shape' as const },
  { id: `outline-${n}`, name: `Outline ${n}`, fill: 'none', stroke: fill, strokeWidth: 2.4, shadow: true, kind: 'shape' as const },
  { id: `dot-${n}`, name: `Dot ${n}`, fill, stroke, strokeWidth: 2, shadow: true, kind: 'dot' as const },
  { id: `ring-${n}`, name: `Touch ${n}`, fill: `${fill}55`, stroke: fill, strokeWidth: 2.5, shadow: false, kind: 'ring' as const },
]); // 40 styles

export function cursorSvg(style: CursorStyle, shape: ShapeName, color?: string): { svg: string; hot: [number, number] } {
  const fill = color && style.fill !== 'none' ? color : style.fill;
  const strokeC = color && style.fill === 'none' ? color : style.stroke;
  const shadow = style.shadow ? `<filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.2" flood-opacity="0.45"/></filter>` : '';
  const f = style.shadow ? ' filter="url(#s)"' : '';
  if (style.kind !== 'shape') {
    const body = style.kind === 'dot' ? `<circle cx="16" cy="16" r="7" fill="${fill}" stroke="${strokeC}" stroke-width="${style.strokeWidth}"${f}/>` : `<circle cx="16" cy="16" r="11" fill="${fill}" stroke="${strokeC}" stroke-width="${style.strokeWidth}"${f}/>`;
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 32 32"><defs>${shadow}</defs>${body}</svg>`, hot: [16, 16] };
  }
  const s = SHAPE_SVG[shape];
  const isStroke = s.stroke === true;
  const path = isStroke
    ? `<path d="${s.d}" fill="none" stroke="${style.fill === 'none' ? strokeC : style.stroke}" stroke-width="${style.strokeWidth + 2.6}" stroke-linecap="round"/><path d="${s.d}" fill="none" stroke="${style.fill === 'none' ? strokeC : fill}" stroke-width="${Math.max(1.6, style.strokeWidth)}" stroke-linecap="round"/>`
    : `<path d="${s.d}" fill="${fill}" stroke="${strokeC}" stroke-width="${style.strokeWidth}" stroke-linejoin="round"/>`;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 32 32"><defs>${shadow}</defs><g${f}>${path}</g></svg>`, hot: s.hot };
}

export const CLICK_EFFECTS: Array<{ id: string; name: string; style: number }> = [
  { id: 'ripple', name: 'Ripple', style: 0 },
  { id: 'pulse', name: 'Pulse', style: 1 },
  { id: 'double', name: 'Double ripple', style: 2 },
  { id: 'halo', name: 'Halo', style: 3 },
  { id: 'burst', name: 'Burst', style: 4 },
  { id: 'square', name: 'Square', style: 5 },
  { id: 'dot', name: 'Dot', style: 6 },
  { id: 'press', name: 'Press', style: 7 },
];

// ---------------------------------------------------------------- camera filters (CAM-08)

/** 4×4 color matrix (column-major for GL) + offset. */
export interface ColorFilter { id: string; name: string; m: number[]; o: [number, number, number] }
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function sat(s: number): number[] {
  const lr = 0.2126, lg = 0.7152, lb = 0.0722;
  const a = (1 - s);
  // column-major
  return [a * lr + s, a * lr, a * lr, 0, a * lg, a * lg + s, a * lg, 0, a * lb, a * lb, a * lb + s, 0, 0, 0, 0, 1];
}
function mul(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0) as number[];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
}
const scale = (r: number, g: number, b: number) => [r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, 0, 1];
export const CAMERA_FILTERS: ColorFilter[] = [
  { id: 'none', name: 'Original', m: I, o: [0, 0, 0] },
  { id: 'warm', name: 'Warm', m: scale(1.08, 1.0, 0.9), o: [0.02, 0.01, 0] },
  { id: 'cool', name: 'Cool', m: scale(0.92, 1.0, 1.1), o: [0, 0.01, 0.02] },
  { id: 'vivid', name: 'Vivid', m: sat(1.35), o: [0, 0, 0] },
  { id: 'muted', name: 'Muted', m: sat(0.7), o: [0.02, 0.02, 0.02] },
  { id: 'mono', name: 'Mono', m: sat(0), o: [0, 0, 0] },
  { id: 'noir', name: 'Noir', m: mul(scale(1.2, 1.2, 1.2), sat(0)), o: [-0.08, -0.08, -0.08] },
  { id: 'sepia', name: 'Sepia', m: [0.393, 0.349, 0.272, 0, 0.769, 0.686, 0.534, 0, 0.189, 0.168, 0.131, 0, 0, 0, 0, 1], o: [0, 0, 0] },
  { id: 'fade', name: 'Fade', m: scale(0.85, 0.85, 0.85), o: [0.09, 0.08, 0.1] },
  { id: 'rose', name: 'Rose', m: scale(1.06, 0.97, 1.0), o: [0.03, 0, 0.02] },
  { id: 'teal', name: 'Teal & orange', m: mul(scale(1.06, 1.0, 0.96), sat(1.15)), o: [0.01, 0, 0.03] },
  { id: 'bright', name: 'Bright', m: scale(1.12, 1.12, 1.12), o: [0.02, 0.02, 0.02] },
];

export const CAMERA_FRAMES: Array<{ id: string; name: string; color: string; width: number }> = [
  { id: 'none', name: 'None', color: '#ffffff', width: 0 },
  { id: 'thin-white', name: 'Thin white', color: '#ffffff', width: 3 },
  { id: 'thick-white', name: 'Thick white', color: '#ffffff', width: 8 },
  { id: 'accent', name: 'Accent', color: '#7c5cff', width: 5 },
  { id: 'dark', name: 'Dark', color: '#111111', width: 6 },
];

export const VIRTUAL_SCENES = WALLPAPERS.slice(0, 6).map((w) => ({ id: w.id, name: w.name, colors: w.colors }));

/**
 * Raster "virtual scene" for the camera background (CAM-09): the wallpaper's palette as a soft studio-style
 * backdrop (diagonal gradient + out-of-focus light blobs), PNG-encoded so it works like an uploaded image.
 */
export async function renderVirtualScene(colors: readonly [string, string, string], w = 1280, h = 720): Promise<Uint8Array> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, colors[0]);
  g.addColorStop(0.55, colors[1]);
  g.addColorStop(1, colors[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const blobs: Array<[number, number, number, string, number]> = [
    [0.2, 0.3, 0.45, colors[2], 0.35], [0.78, 0.25, 0.35, colors[0], 0.3], [0.65, 0.8, 0.5, colors[1], 0.4], [0.1, 0.85, 0.3, '#ffffff', 0.08],
  ];
  for (const [x, y, r, col, a] of blobs) {
    const rg = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * w);
    const [cr, cg, cb] = hexToRgb(col).map((v) => Math.round(v * 255));
    rg.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
    rg.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.75);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
