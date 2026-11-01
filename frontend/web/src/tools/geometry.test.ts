import { describe, expect, it } from 'vitest';
import {
  CROP_PRESETS, FULL_FRAME, bubbleGeometry, cropOutputSize, cropSource, dragRect, even, fitContain, isFullFrame,
  minCropSize, normalizeRect, rectFromPoints, sameRect, zoomViewport, type Rect, type Zoom,
} from './geometry';

const MIN = { w: 0.1, h: 0.1 };
const close = (a: Rect, b: Rect) => expect(sameRect(a, b, 1e-9)).toBe(true);

describe('dragRect', () => {
  const start: Rect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };

  it('moves without resizing and stays inside the frame', () => {
    close(dragRect(start, 'move', 0.1, -0.05, MIN), { x: 0.3, y: 0.15, w: 0.4, h: 0.4 });
    close(dragRect(start, 'move', 5, 5, MIN), { x: 0.6, y: 0.6, w: 0.4, h: 0.4 });
    close(dragRect(start, 'move', -5, -5, MIN), { x: 0, y: 0, w: 0.4, h: 0.4 });
  });

  it('resizes from each corner keeping the opposite corner fixed', () => {
    close(dragRect(start, 'se', 0.1, 0.2, MIN), { x: 0.2, y: 0.2, w: 0.5, h: 0.6 });
    close(dragRect(start, 'nw', -0.1, -0.1, MIN), { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    close(dragRect(start, 'ne', 0.1, 0.1, MIN), { x: 0.2, y: 0.3, w: 0.5, h: 0.3 });
    close(dragRect(start, 'sw', 0.1, 0.1, MIN), { x: 0.3, y: 0.2, w: 0.3, h: 0.5 });
  });

  it('edge handles change one dimension only', () => {
    close(dragRect(start, 'e', 0.1, 0.3, MIN), { x: 0.2, y: 0.2, w: 0.5, h: 0.4 });
    close(dragRect(start, 'n', 0.3, -0.1, MIN), { x: 0.2, y: 0.1, w: 0.4, h: 0.5 });
  });

  it('never shrinks below the minimum or crosses the opposite edge', () => {
    const r = dragRect(start, 'e', -1, 0, MIN);
    expect(r.w).toBeCloseTo(MIN.w);
    expect(r.x).toBeCloseTo(0.2);
    const t = dragRect(start, 'n', 0, 1, MIN);
    expect(t.h).toBeCloseTo(MIN.h);
    expect(t.y + t.h).toBeCloseTo(0.6);
  });

  it('never grows outside the frame', () => {
    const r = dragRect(start, 'se', 3, 3, MIN);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
    const l = dragRect(start, 'nw', -3, -3, MIN);
    close(l, { x: 0, y: 0, w: 0.6, h: 0.6 });
  });

  it('repairs an invalid start rect before applying the drag', () => {
    const r = dragRect({ x: 0.95, y: -0.2, w: 0.01, h: 2 }, 'move', 0, 0, MIN);
    expect(r.w).toBeCloseTo(0.1);
    expect(r.h).toBe(1);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y).toBe(0);
  });
});

describe('rectFromPoints / normalizeRect', () => {
  it('spans two points in any order', () => {
    close(rectFromPoints(0.8, 0.9, 0.2, 0.3, MIN), { x: 0.2, y: 0.3, w: 0.6, h: 0.6 });
  });

  it('grows a tiny selection to the minimum size away from the anchor', () => {
    const r = rectFromPoints(0.5, 0.5, 0.49, 0.52, MIN);
    close(r, { x: 0.4, y: 0.5, w: 0.1, h: 0.1 });
  });

  it('keeps a minimum-size selection at the frame edge inside the frame', () => {
    const r = rectFromPoints(0.99, 0.99, 1.2, 1.3, MIN);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
    expect(r.w).toBeCloseTo(0.1);
  });

  it('normalizeRect clamps position and size', () => {
    close(normalizeRect({ x: -1, y: 0.95, w: 2, h: 0.01 }, MIN), { x: 0, y: 0.9, w: 1, h: 0.1 });
  });
});

describe('minCropSize', () => {
  it('uses 64 px on small sources and 5 % on large ones', () => {
    expect(minCropSize({ w: 640, h: 480 })).toEqual({ w: 0.1, h: 64 / 480 });
    expect(minCropSize({ w: 3840, h: 2160 })).toEqual({ w: 0.05, h: 0.05 });
    expect(minCropSize({ w: 10, h: 0 })).toEqual({ w: 1, h: 1 });
  });
});

describe('presets and pixel sizes', () => {
  it('includes the four quick presets with Full first', () => {
    expect(CROP_PRESETS.map((p) => p.label)).toEqual(['Full', 'Center 80%', 'Left half', 'Right half']);
    expect(isFullFrame(CROP_PRESETS[0]!.rect)).toBe(true);
    expect(isFullFrame({ x: 0, y: 0, w: 0.5, h: 1 })).toBe(false);
  });

  it('maps a crop to source pixels inside the frame', () => {
    expect(cropSource({ x: 0.5, y: 0, w: 0.5, h: 1 }, { w: 1920, h: 1080 })).toEqual({ sx: 960, sy: 0, sw: 960, sh: 1080 });
    const s = cropSource({ x: 0.9999, y: 0.9999, w: 0.5, h: 0.5 }, { w: 100, h: 100 });
    expect(s.sx + s.sw).toBeLessThanOrEqual(100);
    expect(s.sw).toBeGreaterThanOrEqual(1);
  });

  it('produces even output sizes and caps the long edge', () => {
    expect(cropOutputSize(FULL_FRAME, { w: 1001, h: 777 })).toEqual({ w: 1000, h: 776 });
    expect(cropOutputSize(FULL_FRAME, { w: 5120, h: 2880 })).toEqual({ w: 3840, h: 2160 });
    expect(even(1)).toBe(2);
  });
});

describe('fitContain', () => {
  it('letterboxes a wide video in a tall box and pillarboxes a tall one', () => {
    expect(fitContain({ w: 1920, h: 1080 }, { w: 960, h: 960 })).toEqual({ left: 0, top: 210, width: 960, height: 540 });
    expect(fitContain({ w: 1080, h: 1920 }, { w: 1600, h: 900 })).toEqual({ left: 546.875, top: 0, width: 506.25, height: 900 });
  });

  it('returns an empty box for unknown sizes', () => {
    expect(fitContain({ w: 0, h: 0 }, { w: 100, h: 100 })).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

describe('bubbleGeometry', () => {
  it('matches the original 1080p bubble and stays inside portrait frames', () => {
    expect(bubbleGeometry({ w: 1920, h: 1080 })).toEqual({ cx: 1920 - 151 - 30, cy: 1080 - 151 - 30, r: 151 });
    const p = bubbleGeometry({ w: 608, h: 1080 });
    expect(p.cx - p.r).toBeGreaterThan(0);
    expect(2 * p.r).toBeLessThan(608 * 0.5);
  });
});

describe('zoomViewport', () => {
  const src = { w: 1920, h: 1080 };
  const zooms: Zoom[] = [{ id: 1, start: 2, end: 5, x: 0.25, y: 0.25, level: 2 }];

  it('shows the full frame outside zooms', () => {
    expect(zoomViewport(0, zooms, src)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
    expect(zoomViewport(5, zooms, src)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
  });

  it('holds the full magnification in the middle of a zoom, centred on the focus', () => {
    expect(zoomViewport(3.5, zooms, src)).toEqual({ sx: 0, sy: 0, sw: 960, sh: 540 });
    const centred = zoomViewport(3.5, [{ ...zooms[0]!, x: 0.5, y: 0.5 }], src);
    expect(centred).toEqual({ sx: 480, sy: 270, sw: 960, sh: 540 });
  });

  it('eases in monotonically and clamps the window inside the frame', () => {
    let prev = Infinity;
    for (let t = 2; t <= 2.4; t += 0.05) {
      const v = zoomViewport(t, zooms, src);
      expect(v.sw).toBeLessThanOrEqual(prev);
      expect(v.sx).toBeGreaterThanOrEqual(0);
      expect(v.sx + v.sw).toBeLessThanOrEqual(1920 + 1e-9);
      prev = v.sw;
    }
  });

  it('handles zooms shorter than the ramp without NaN', () => {
    const v = zoomViewport(1.05, [{ id: 2, start: 1, end: 1.1, x: 0.9, y: 0.9, level: 3 }], src);
    expect(Number.isFinite(v.sw)).toBe(true);
    expect(v.sw).toBeLessThan(1920);
  });

  it('stays linear in the number of zooms (no blow-up on many entries)', () => {
    const many: Zoom[] = Array.from({ length: 5000 }, (_, i) => ({ id: i, start: i, end: i + 0.5, x: 0.5, y: 0.5, level: 2 }));
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) zoomViewport(i * 2.37, many, src);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
