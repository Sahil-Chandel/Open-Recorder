/**
 * Area selector overlay (task 2.2): drag a rectangle, live W×H, aspect locks, resize handles,
 * Enter = confirm, Esc = cancel, remembers the last area.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { cx } from '../ui';

type R = { x: number; y: number; w: number; h: number };
const LOCKS: Array<{ id: string; label: string; ratio: number | null }> = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
];

export default function AreaSelector({ query }: { query: URLSearchParams }) {
  const displayId = query.get('displayId') ?? '';
  const ox = Number(query.get('ox') ?? 0);
  const oy = Number(query.get('oy') ?? 0);
  const lastRaw = query.get('last');
  const [rect, setRect] = useState<R | null>(() => {
    if (!lastRaw) return null;
    try {
      const l = JSON.parse(lastRaw) as { x: number; y: number; width: number; height: number };
      return { x: l.x - ox, y: l.y - oy, w: l.width, h: l.height };
    } catch {
      return null;
    }
  });
  const [lock, setLock] = useState('free');
  const drag = useRef<{ kind: 'new' | 'move' | string; sx: number; sy: number; r: R } | null>(null);
  const ratio = LOCKS.find((l) => l.id === lock)?.ratio ?? null;

  const done = (r: R | null) => {
    void api.invoke('area:done', r && r.w >= 16 && r.h >= 16 ? { x: Math.round(r.x + ox), y: Math.round(r.y + oy), width: Math.round(r.w), height: Math.round(r.h), displayId } : null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && rect) done(rect);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const norm = (r: R): R => {
    let { x, y, w, h } = r;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    if (ratio) h = w / ratio;
    return { x, y, w, h };
  };

  const onDown = (e: React.PointerEvent, kind: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const r = kind === 'new' ? { x: e.clientX, y: e.clientY, w: 0, h: 0 } : rect!;
    drag.current = { kind, sx: e.clientX, sy: e.clientY, r };
    if (kind === 'new') setRect(r);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    let r = { ...d.r };
    if (d.kind === 'new') r = { x: d.r.x, y: d.r.y, w: dx, h: ratio ? dx / ratio * Math.sign(dy || 1) : dy };
    else if (d.kind === 'move') r = { ...r, x: d.r.x + dx, y: d.r.y + dy };
    else {
      if (d.kind.includes('e')) r.w = d.r.w + dx;
      if (d.kind.includes('s')) r.h = d.r.h + dy;
      if (d.kind.includes('w')) { r.x = d.r.x + dx; r.w = d.r.w - dx; }
      if (d.kind.includes('n')) { r.y = d.r.y + dy; r.h = d.r.h - dy; }
    }
    setRect(d.kind === 'new' ? r : norm(r));
  };
  const onUp = () => {
    if (rect) setRect(norm(rect));
    drag.current = null;
  };

  const r = rect ? norm(rect) : null;
  return (
    <div className="fixed inset-0 cursor-crosshair select-none" onPointerDown={(e) => onDown(e, 'new')} onPointerMove={onMove} onPointerUp={onUp}>
      {/* dim outside the selection */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <mask id="m">
            <rect width="100%" height="100%" fill="white" />
            {r && <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="black" />}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.45)" mask="url(#m)" />
      </svg>
      {!r && <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-black/70 px-4 py-2 text-sm text-white">Drag to select an area · Esc to cancel</div>}
      {r && (
        <div className="absolute border-2 border-accent" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} onPointerDown={(e) => onDown(e, 'move')}>
          <div className="absolute -top-8 left-0 rounded-md bg-accent px-2 py-0.5 text-xs font-medium tabular-nums text-white">{Math.round(r.w)} × {Math.round(r.h)}</div>
          {['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'].map((h) => (
            <div key={h} onPointerDown={(e) => onDown(e, h)}
              className="absolute h-3 w-3 rounded-full border-2 border-accent bg-white"
              style={{
                left: h.includes('w') ? -6 : h.includes('e') ? r.w - 6 : r.w / 2 - 6,
                top: h.includes('n') ? -6 : h.includes('s') ? r.h - 6 : r.h / 2 - 6,
                cursor: `${h}-resize`,
              }} />
          ))}
          <div className="absolute -bottom-12 left-1/2 flex -translate-x-1/2 gap-1 rounded-xl bg-black/80 p-1" onPointerDown={(e) => e.stopPropagation()}>
            {LOCKS.map((l) => (
              <button key={l.id} onClick={() => setLock(l.id)} className={cx('rounded-lg px-2 py-1 text-xs text-white', lock === l.id ? 'bg-accent' : 'hover:bg-white/10')}>{l.label}</button>
            ))}
            <button onClick={() => done(null)} className="rounded-lg px-2 py-1 text-xs text-white hover:bg-white/10">Cancel</button>
            <button onClick={() => done(r)} className="rounded-lg bg-white px-3 py-1 text-xs font-semibold text-black">Record ↵</button>
          </div>
        </div>
      )}
    </div>
  );
}