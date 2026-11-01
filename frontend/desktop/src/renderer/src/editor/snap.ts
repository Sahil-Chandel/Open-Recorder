type Box = { x: number; y: number; w: number; h: number };

/**
 * Snap a dragged box (css px) to the canvas edges / centre and to other items' edges / centres within a
 * few pixels. Returns the snapped box and the guide lines to draw.
 */
export function snapBox(b: Box, W: number, H: number, others: readonly Box[], tol = 6): { box: Box; guides: { v: number[]; h: number[] } } {
  const out = { ...b };
  const v: number[] = [], h: number[] = [];
  const xs = [0, W / 2, W, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
  const ys = [0, H / 2, H, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];
  const snapAxis = (pos: number, size: number, targets: number[], lines: number[]): number => {
    let best: { d: number; to: number; line: number } | null = null;
    for (const t of targets) {
      for (const [edge, off] of [[pos, 0], [pos + size / 2, size / 2], [pos + size, size]] as const) {
        const dd = Math.abs(edge - t);
        if (dd <= tol && (!best || dd < best.d)) best = { d: dd, to: t - off, line: t };
      }
    }
    if (!best) return pos;
    lines.push(best.line);
    return best.to;
  };
  out.x = snapAxis(b.x, b.w, xs, v);
  out.y = snapAxis(b.y, b.h, ys, h);
  return { box: out, guides: { v, h } };
}
