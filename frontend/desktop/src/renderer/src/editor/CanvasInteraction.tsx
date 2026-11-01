/**
 * On-canvas editing (task 8.5, CAM-03, ZOOM-05, WM-02, KEY-03): select / drag / corner-resize / rotate
 * annotations (with snapping to the canvas centre / edges and other items — hold Alt to place freely),
 * double-click text to edit it in place, pick a fixed zoom focus, Adjust Layout for camera + screen,
 * drag watermark and key overlay.
 * Content-space items are converted through the inverse stage transform so they stick to the UI.
 */
import { useEffect, useRef, useState } from 'react';
import { canvasToSource, layoutAt, type Annotation, type LayoutDef } from '@rec/shared';
import { Button } from '../ui';
import type { PlayerGeometry } from './Player';
import { snapBox } from './snap';
import { useEditor } from './store';

type Box = { x: number; y: number; w: number; h: number };
type Drag =
  | { kind: 'ann'; id: string; mode: string; sx: number; sy: number; rect: Box; rot: number; space: 'canvas' | 'content' }
  | { kind: 'wm' | 'keys'; sx: number; sy: number; x: number; y: number }
  | { kind: 'layout'; which: 'screen' | 'camera'; mode: string; sx: number; sy: number; rect: Box }
  | null;

export function CanvasInteraction({ geom }: { geom: PlayerGeometry }) {
  const project = useEditor((s) => s.project)!;
  const sel = useEditor((s) => s.selection);
  const module = useEditor((s) => s.module);
  const [pickFocus, setPickFocus] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<LayoutDef | null>(null);
  const drag = useRef<Drag>(null);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const [editingText, setEditingText] = useState<string | null>(null);
  const [focusArea, setFocusArea] = useState<{ id: string; a?: { x: number; y: number }; b?: { x: number; y: number } } | null>(null);
  // rotation is measured against the overlay itself: e.target is wrong once the pointer leaves the canvas
  const rootRef = useRef<HTMLDivElement>(null);
  const { comp, scene, box } = geom;
  const k = box.width / comp.width; // canvas px → css px
  const W = comp.width, H = comp.height;
  const mvp = comp.stageMVP(scene);

  useEffect(() => {
    const onPick = (e: Event) => setPickFocus((e as CustomEvent<string>).detail);
    const onPickArea = (e: Event) => setFocusArea({ id: (e as CustomEvent<string>).detail });
    const onAdjust = () => {
      const orientation = W >= H ? 'landscape' : 'portrait';
      const l = layoutAt([], project.camera, scene.src, orientation);
      setAdjust({ orientation, screen: { ...l.screen }, camera: l.camera ? { ...l.camera } : { x: 0.7, y: 0.65, w: 0.25, h: 0.25 }, cameraBehindScreen: l.cameraBehind, ...(l.cameraRoundness !== undefined ? { cameraRoundness: l.cameraRoundness } : {}) });
    };
    window.addEventListener('editor:pickFocus', onPick);
    window.addEventListener('editor:pickFocusArea', onPickArea);
    window.addEventListener('editor:adjustLayout', onAdjust);
    return () => { window.removeEventListener('editor:pickFocusArea', onPickArea); window.removeEventListener('editor:pickFocus', onPick); window.removeEventListener('editor:adjustLayout', onAdjust); };
  });

  const annBox = (a: Annotation): Box => {
    const r = comp.annotationRectPx(a, mvp);
    return { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
  };
  const toLocal = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // css px → annotation rect units
  const cssToRect = (b: Box, space: 'canvas' | 'content'): Box => {
    if (space === 'canvas') return { x: b.x / k / W, y: b.y / k / H, w: b.w / k / W, h: b.h / k / H };
    const p0 = canvasToSource(scene.stage, scene.viewport, scene.cam, { x: b.x / k, y: b.y / k });
    const p1 = canvasToSource(scene.stage, scene.viewport, scene.cam, { x: (b.x + b.w) / k, y: (b.y + b.h) / k });
    return { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      const s = useEditor.getState();
      if (d.kind === 'ann') {
        let b = { ...d.rect };
        if (d.mode === 'move') {
          b.x += dx; b.y += dy;
          if (!e.altKey) {
            const snapped = snapBox(b, box.width, box.height, scene.annotations.filter((i) => i.a.id !== d.id).map((i) => annBox(i.a)));
            b = snapped.box;
            setGuides(snapped.guides);
          } else setGuides({ v: [], h: [] });
        }
        else if (d.mode === 'rotate') {
          const cx = d.rect.x + d.rect.w / 2, cy = d.rect.y + d.rect.h / 2;
          const root = rootRef.current;
          const p = root ? toLocal(e, root) : { x: 0, y: 0 };
          const ang = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
          s.edit('Rotate', (pr) => { const a = pr.annotations.find((x) => x.id === d.id); if (a) a.rotation = Math.round(ang); }, `rot-${d.id}`);
          return;
        } else {
          const aspect = d.rect.w / Math.max(1, d.rect.h);
          if (d.mode.includes('e')) b.w = Math.max(10, d.rect.w + dx);
          if (d.mode.includes('w')) { b.w = Math.max(10, d.rect.w - dx); b.x = d.rect.x + d.rect.w - b.w; }
          if (d.mode.includes('s')) b.h = Math.max(4, d.rect.h + dy);
          if (d.mode.includes('n')) { b.h = Math.max(4, d.rect.h - dy); b.y = d.rect.y + d.rect.h - b.h; }
          if (d.mode.length === 2 && !e.altKey) { // corners resize proportionally
            b.h = b.w / aspect;
            if (d.mode.includes('n')) b.y = d.rect.y + d.rect.h - b.h;
          }
        }
        const r = cssToRect(b, d.space);
        s.edit('Transform', (pr) => { const a = pr.annotations.find((x) => x.id === d.id); if (a) a.rect = r; }, `xf-${d.id}`);
      } else if (d.kind === 'wm' || d.kind === 'keys') {
        const nx = Math.min(1, Math.max(0, d.x + dx / box.width)), ny = Math.min(1, Math.max(0, d.y + dy / box.height));
        if (d.kind === 'wm') s.edit('Move watermark', (pr) => { if (pr.watermark) { pr.watermark.x = nx; pr.watermark.y = ny; } }, 'wm-move');
        else s.edit('Move keys', (pr) => { pr.keys.position = { x: nx, y: ny }; }, 'keys-move');
      } else if (d.kind === 'layout' && adjust) {
        const r = { ...d.rect };
        const ddx = dx / box.width, ddy = dy / box.height;
        if (d.mode === 'move') { r.x += ddx; r.y += ddy; }
        else { r.w = Math.max(0.05, d.rect.w + ddx); r.h = Math.max(0.05, d.rect.h + ddy); }
        // snapping guides to edges / centre
        for (const key of ['x', 'y'] as const) {
          const size = key === 'x' ? r.w : r.h;
          for (const t of [0, 0.5 - size / 2, 1 - size]) if (Math.abs(r[key] - t) < 0.015) r[key] = t;
        }
        setAdjust({ ...adjust, [d.which]: r });
      }
    };
    const up = () => { drag.current = null; setGuides({ v: [], h: [] }); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  });

  const selectedAnn = sel.kind === 'annotation' ? scene.annotations.find((i) => i.a.id === sel.id)?.a : undefined;

  return (
    <div ref={rootRef} data-overlay className="absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height, cursor: pickFocus || focusArea ? 'crosshair' : undefined }}
      onDoubleClick={(e) => {
        const p = toLocal(e, e.currentTarget);
        const hit = [...scene.annotations].reverse().find((i) => { const b = annBox(i.a); return i.a.type === 'text' && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; });
        if (hit) { useEditor.getState().select('annotation', hit.a.id); setEditingText(hit.a.id); }
      }}
      onPointerMove={(e) => { if (focusArea?.a) setFocusArea({ ...focusArea, b: toLocal(e, e.currentTarget) }); }}
      onPointerUp={(e) => {
        if (!focusArea?.a) return;
        const b = toLocal(e, e.currentTarget);
        const a = focusArea.a;
        const p0 = canvasToSource(scene.stage, scene.viewport, scene.cam, { x: Math.min(a.x, b.x) / k, y: Math.min(a.y, b.y) / k });
        const p1 = canvasToSource(scene.stage, scene.viewport, scene.cam, { x: Math.max(a.x, b.x) / k, y: Math.max(a.y, b.y) / k });
        const cl = (v: number) => Math.min(1, Math.max(0, v));
        const rect = { x: cl(p0.x), y: cl(p0.y), w: Math.max(0.02, cl(p1.x) - cl(p0.x)), h: Math.max(0.02, cl(p1.y) - cl(p0.y)) };
        const id = focusArea.id;
        if (Math.abs(b.x - a.x) > 6 && Math.abs(b.y - a.y) > 6) useEditor.getState().edit('3D focus area', (pr) => { const z = pr.zooms.find((x) => x.id === id); if (z?.m3d) z.m3d.focusArea = rect; });
        setFocusArea(null);
      }}
      onPointerDown={(e) => {
        if (editingText) return;
        const p = toLocal(e, e.currentTarget);
        if (focusArea) { setFocusArea({ ...focusArea, a: p, b: p }); return; }
        if (pickFocus) {
          const src = canvasToSource(scene.stage, scene.viewport, scene.cam, { x: p.x / k, y: p.y / k });
          const id = pickFocus;
          useEditor.getState().edit('Zoom focus', (pr) => { const z = pr.zooms.find((x) => x.id === id); if (z) z.focus = { type: 'fixed', x: Math.min(1, Math.max(0, src.x)), y: Math.min(1, Math.max(0, src.y)) }; });
          setPickFocus(null);
          return;
        }
        if (adjust) return;
        // hit-test annotations (top-most lane first)
        const hit = [...scene.annotations].reverse().find((i) => { const b = annBox(i.a); return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y - 4 && p.y <= b.y + Math.max(b.h, 8); });
        if (hit) {
          useEditor.getState().select('annotation', hit.a.id);
          drag.current = { kind: 'ann', id: hit.a.id, mode: 'move', sx: e.clientX, sy: e.clientY, rect: annBox(hit.a), rot: hit.a.rotation, space: hit.a.space };
        } else if (module === 'watermark' && project.watermark) {
          drag.current = { kind: 'wm', sx: e.clientX, sy: e.clientY, x: project.watermark.x, y: project.watermark.y };
        } else if (module === 'keys') {
          const pos = typeof project.keys.position === 'object' ? project.keys.position : { x: 0.5, y: 0.86 };
          drag.current = { kind: 'keys', sx: e.clientX, sy: e.clientY, x: pos.x, y: pos.y };
        } else if (sel.kind === 'annotation') useEditor.getState().select(null, null);
      }}>
      {pickFocus && <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-lg bg-black/80 px-3 py-1 text-xs text-white">Click the point to zoom into</div>}
      {focusArea && <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-lg bg-black/80 px-3 py-1 text-xs text-white">Drag over the area the 3D view should focus on</div>}
      {focusArea?.a && focusArea.b && (
        <div className="pointer-events-none absolute border-2 border-dashed border-accent bg-accent/10"
          style={{ left: Math.min(focusArea.a.x, focusArea.b.x), top: Math.min(focusArea.a.y, focusArea.b.y), width: Math.abs(focusArea.b.x - focusArea.a.x), height: Math.abs(focusArea.b.y - focusArea.a.y) }} />
      )}
      {guides.v.map((x) => <div key={`v${x}`} className="pointer-events-none absolute top-0 h-full w-px bg-accent/80" style={{ left: x }} />)}
      {guides.h.map((y) => <div key={`h${y}`} className="pointer-events-none absolute left-0 h-px w-full bg-accent/80" style={{ top: y }} />)}
      {editingText && (() => {
        const a = scene.annotations.find((i) => i.a.id === editingText)?.a;
        if (!a || a.type !== 'text') return null;
        const b = annBox(a);
        const id = a.id;
        return (
          <textarea autoFocus defaultValue={a.text} aria-label="Edit text"
            className="absolute resize-none rounded border border-accent bg-black/60 p-1 text-center text-white outline-none"
            style={{ left: b.x, top: b.y, width: Math.max(b.w, 120), height: Math.max(b.h, 32), fontSize: Math.max(12, Math.min(b.h * 0.6, 48)), fontFamily: a.style.font }}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => { const v = e.target.value; useEditor.getState().edit('Edit text', (pr) => { const it = pr.annotations.find((x) => x.id === id); if (it && it.type === 'text') it.text = v; }, `txt-${id}`); }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); setEditingText(null); } }}
            onBlur={() => setEditingText(null)} />
        );
      })()}
      {selectedAnn && !adjust && (() => {
        const b = annBox(selectedAnn);
        const start = (mode: string) => (e: React.PointerEvent) => { e.stopPropagation(); drag.current = { kind: 'ann', id: selectedAnn.id, mode, sx: e.clientX, sy: e.clientY, rect: b, rot: selectedAnn.rotation, space: selectedAnn.space }; };
        return (
          <div className="absolute border border-dashed border-white/90" style={{ left: b.x, top: b.y, width: b.w, height: Math.max(b.h, 2), transform: `rotate(${selectedAnn.rotation}deg)` }} onPointerDown={start('move')}>
            {['nw', 'ne', 'sw', 'se', 'e', 'w', 'n', 's'].map((h) => (
              <div key={h} onPointerDown={start(h)} className="absolute h-2.5 w-2.5 rounded-sm border border-accent bg-white"
                style={{ left: h.includes('w') ? -5 : h.includes('e') ? b.w - 5 : b.w / 2 - 5, top: h.includes('n') ? -5 : h.includes('s') ? Math.max(b.h, 2) - 5 : Math.max(b.h, 2) / 2 - 5, cursor: `${h}-resize` }} />
            ))}
            <div onPointerDown={start('rotate')} className="absolute left-1/2 -top-6 h-3 w-3 -translate-x-1/2 cursor-grab rounded-full border border-accent bg-white" title="Rotate" />
          </div>
        );
      })()}
      {adjust && (
        <>
          {(['screen', 'camera'] as const).map((which) => {
            const r = adjust[which];
            if (!r) return null;
            return (
              <div key={which} className={`absolute border-2 ${which === 'camera' ? 'border-accent bg-accent/15' : 'border-white/80 bg-white/5'}`}
                style={{ left: r.x * box.width, top: r.y * box.height, width: r.w * box.width, height: r.h * box.height }}
                onPointerDown={(e) => { e.stopPropagation(); drag.current = { kind: 'layout', which, mode: 'move', sx: e.clientX, sy: e.clientY, rect: r }; }}>
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white">{which}</span>
                <div className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-se-resize rounded-sm bg-white"
                  onPointerDown={(e) => { e.stopPropagation(); drag.current = { kind: 'layout', which, mode: 'resize', sx: e.clientX, sy: e.clientY, rect: r }; }} />
              </div>
            );
          })}
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2 rounded-xl bg-black/80 p-2">
            <Button size="sm" onClick={() => setAdjust({ ...adjust, cameraBehindScreen: !adjust.cameraBehindScreen })}>{adjust.cameraBehindScreen ? 'Camera behind' : 'Camera in front'}</Button>
            <Button size="sm" onClick={() => setAdjust(null)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={() => { useEditor.getState().edit('Custom layout', (p) => { p.camera.layoutId = 'custom'; p.camera.customLayout = adjust; }); setAdjust(null); }}>Apply</Button>
          </div>
        </>
      )}
    </div>
  );
}

