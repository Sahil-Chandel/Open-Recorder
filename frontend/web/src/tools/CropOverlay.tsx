/**
 * Draggable / resizable recording-area frame drawn over the live preview (WEB-01 "drag border to set area").
 * Drag inside to move, drag a handle to resize, drag across the dimmed area to draw a new frame; arrow keys move it
 * and Shift + arrows resize it. The overlay tracks the <video>'s object-fit: contain box, so coordinates are exact
 * for any source aspect ratio. While recording it is locked and only shows what is being captured.
 */
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { bubbleGeometry, cropOutputSize, dragRect, fitContain, minCropSize, rectFromPoints, type Handle, type Rect, type Size } from './geometry';
import { StreamVideo } from './widgets';

type ResizeHandle = Exclude<Handle, 'move'>;
const HANDLES: ReadonlyArray<{ h: ResizeHandle; left: string; top: string; cursor: string }> = [
  { h: 'nw', left: '0%', top: '0%', cursor: 'nwse-resize' },
  { h: 'n', left: '50%', top: '0%', cursor: 'ns-resize' },
  { h: 'ne', left: '100%', top: '0%', cursor: 'nesw-resize' },
  { h: 'e', left: '100%', top: '50%', cursor: 'ew-resize' },
  { h: 'se', left: '100%', top: '100%', cursor: 'nwse-resize' },
  { h: 's', left: '50%', top: '100%', cursor: 'ns-resize' },
  { h: 'sw', left: '0%', top: '100%', cursor: 'nesw-resize' },
  { h: 'w', left: '0%', top: '50%', cursor: 'ew-resize' },
];
const KEY_STEP = 0.01;
const DRAG_THRESHOLD_PX = 4;
const pct = (v: number) => `${v * 100}%`;

interface Drag { pointer: number; handle: Handle | 'draw'; start: Rect; x: number; y: number; cx: number; cy: number; moved: boolean }

export interface CropOverlayProps {
  /** Intrinsic size of the previewed video. */
  src: Size;
  rect: Rect;
  onChange: (r: Rect) => void;
  /** No editing (while recording). */
  locked: boolean;
  recording: boolean;
  /** Camera stream previewed as the bubble that will be composited into the recording. */
  bubble: MediaStream | null;
}

export function CropOverlay({ src, rect, onChange, locked, recording, bubble }: CropOverlayProps) {
  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const hintId = useId();

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const content = fitContain(src, box);
  const min = minCropSize(src);
  const out = cropOutputSize(rect, src);
  const b = bubbleGeometry(out);

  const point = (e: PointerEvent): { x: number; y: number } => {
    const r = area.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / Math.max(1, r.width), y: (e.clientY - r.top) / Math.max(1, r.height) };
  };
  const down = (handle: Handle | 'draw') => (e: PointerEvent<HTMLElement>) => {
    if (locked || e.button !== 0 || !area.current) return;
    e.preventDefault();
    e.stopPropagation();
    area.current.setPointerCapture(e.pointerId);
    const p = point(e);
    drag.current = { pointer: e.pointerId, handle, start: rect, x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, moved: false };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < DRAG_THRESHOLD_PX) return; // a click is not a drag
      d.moved = true;
    }
    const p = point(e);
    onChange(d.handle === 'draw' ? rectFromPoints(d.x, d.y, p.x, p.y, min) : dragRect(d.start, d.handle, p.x - d.x, p.y - d.y, min));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => { if (drag.current?.pointer === e.pointerId) drag.current = null; };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (locked) return;
    const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    onChange(dragRect(rect, e.shiftKey ? 'se' : 'move', dx * KEY_STEP, dy * KEY_STEP, min));
  };

  const shade = 'pointer-events-none absolute bg-black/55';
  return (
    <div ref={root} className="absolute inset-0 select-none">
      <div ref={area} className={`absolute ${locked ? '' : 'cursor-crosshair'}`}
        style={{ left: content.left, top: content.top, width: content.width, height: content.height, touchAction: 'none' }}
        onPointerDown={down('draw')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
        <div className={shade} style={{ left: 0, top: 0, width: '100%', height: pct(rect.y) }} />
        <div className={shade} style={{ left: 0, top: pct(rect.y + rect.h), width: '100%', bottom: 0 }} />
        <div className={shade} style={{ left: 0, top: pct(rect.y), width: pct(rect.x), height: pct(rect.h) }} />
        <div className={shade} style={{ left: pct(rect.x + rect.w), top: pct(rect.y), right: 0, height: pct(rect.h) }} />

        <div role="group" tabIndex={locked ? -1 : 0} aria-roledescription="recording area" aria-label={`Recording area, ${out.w} by ${out.h} pixels`}
          aria-describedby={locked ? undefined : hintId} onKeyDown={key} onPointerDown={down('move')}
          className={`absolute border-2 outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${recording ? 'border-danger' : 'border-accent'} ${locked ? '' : 'cursor-move'}`}
          style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}>
          {bubble && (
            <div className="pointer-events-none absolute overflow-hidden rounded-full bg-black/40"
              style={{ left: pct((b.cx - b.r) / out.w), top: pct((b.cy - b.r) / out.h), width: pct((2 * b.r) / out.w), height: pct((2 * b.r) / out.h) }}>
              <StreamVideo stream={bubble} className="h-full w-full object-cover" />
            </div>
          )}
          {!locked && (
            <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">{out.w} × {out.h}</span>
          )}
          {!locked && HANDLES.map((h) => (
            <span key={h.h} aria-hidden onPointerDown={down(h.h)}
              className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
              style={{ left: h.left, top: h.top, cursor: h.cursor, touchAction: 'none' }}>
              <span className="h-2.5 w-2.5 rounded-sm bg-white shadow ring-2 ring-accent" />
            </span>
          ))}
        </div>
      </div>
      <span id={hintId} className="sr-only">Use the arrow keys to move the area and Shift with the arrow keys to resize it.</span>
    </div>
  );
}
