/**
 * Teleprompter (task 2.10, TEL-01…05): frameless, always on top, excluded from capture. Script editor,
 * auto-scroll speed, font size, color, background opacity, reading guide line, Reset; Space = pause.
 * Starts/stops with the recording (main sends teleprompter:control).
 *
 * Edits are applied locally at once and persisted with a short debounce: round-tripping every keystroke
 * through the settings store moved the caret and could drop characters.
 */
import { GripHorizontal, Pause, Play, RotateCcw, Settings2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useSettings } from '../lib/useSettings';
import { Button, ColorPicker, Slider } from '../ui';

type TpLocal = { script: string; speed: number; fontSize: number; color: string; bgOpacity: number };
const DEFAULTS: Omit<TpLocal, 'script'> = { speed: 1, fontSize: 36, color: '#ffffff', bgOpacity: 0.75 };

export default function Teleprompter() {
  const [s, patch] = useSettings();
  const [editing, setEditing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const [tp, setTp] = useState<TpLocal | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pos = useRef(0);
  const pending = useRef<Partial<TpLocal>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // adopt the stored settings once; afterwards this window is the source of truth for its own edits
  useEffect(() => {
    if (s && !tp) {
      const t = s.teleprompter;
      setTp({ script: t.script, speed: t.speed, fontSize: t.fontSize, color: t.color, bgOpacity: t.bgOpacity });
      if (!t.script) setEditing(true);
    }
  }, [s]);

  const flush = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const p = pending.current;
    pending.current = {};
    if (Object.keys(p).length) void patch({ teleprompter: p }).catch(() => undefined);
  };
  const update = (p: Partial<TpLocal>) => {
    setTp((cur) => (cur ? { ...cur, ...p } : cur));
    pending.current = { ...pending.current, ...p };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 400);
  };
  useEffect(() => {
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, []);

  useEffect(() => api.on('teleprompter:control', (c: string) => {
    if (c === 'start') { setEditing(false); setPlaying(true); }
    if (c === 'pause' || c === 'stop') setPlaying(false);
  }), []);

  useEffect(() => {
    if (!playing || !tp) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const el = scroller.current;
      if (el) {
        pos.current += dt * 30 * tp.speed * (tp.fontSize / 36);
        el.scrollTop = pos.current;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) setPlaying(false);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, tp?.speed, tp?.fontSize]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !editing) { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  // transparent frameless windows can't be edge-resized on Windows: bottom-right grip instead (TEL-04)
  const resizeFrom = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.screenX, y0 = e.screenY, w0 = window.innerWidth, h0 = window.innerHeight;
    let raf = 0;
    const move = (ev: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void api.invoke('win:setSize', Math.max(280, w0 + ev.screenX - x0), Math.max(140, h0 + ev.screenY - y0)));
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  if (!s || !tp) return null;
  const rewind = () => { pos.current = 0; if (scroller.current) scroller.current.scrollTop = 0; setPlaying(false); };

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 text-white" style={{ background: `rgba(10,10,14,${tp.bgOpacity})` }}>
      <div className="drag flex h-8 items-center gap-1 px-2 text-white/70">
        <GripHorizontal size={14} />
        <span className="flex-1 text-[11px]">Teleprompter · hidden from recordings</span>
        <button aria-label={playing ? 'Pause' : 'Play'} className="no-drag rounded p-1 hover:bg-white/10" onClick={() => { setEditing(false); setPlaying(!playing); }}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
        <button aria-label="Back to the start" title="Back to the start" className="no-drag rounded p-1 hover:bg-white/10" onClick={rewind}><RotateCcw size={14} /></button>
        <button aria-label="Settings" className="no-drag rounded p-1 hover:bg-white/10" onClick={() => setShowCfg(!showCfg)}><Settings2 size={14} /></button>
        <button aria-label="Edit script" className="no-drag rounded px-1.5 text-[11px] hover:bg-white/10" onClick={() => { if (editing) flush(); setEditing(!editing); setPlaying(false); }}>{editing ? 'Done' : 'Edit'}</button>
        <button aria-label="Close" className="no-drag rounded p-1 hover:bg-white/10" onClick={() => { flush(); void api.invoke('win:close'); }}><X size={14} /></button>
      </div>
      {showCfg && (
        <div className="no-drag grid grid-cols-2 gap-3 border-y border-white/10 bg-black/40 p-3">
          <Slider label="Scroll speed" value={tp.speed} min={0.1} max={5} step={0.1} onChange={(v) => update({ speed: v })} format={(v) => `${v.toFixed(1)}×`} />
          <Slider label="Font size" value={tp.fontSize} min={14} max={96} step={1} onChange={(v) => update({ fontSize: v })} format={(v) => `${v}`} />
          <Slider label="Background opacity" value={tp.bgOpacity} min={0} max={1} onChange={(v) => update({ bgOpacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <ColorPicker label="Text color" value={tp.color} onChange={(v) => update({ color: v })} />
          <Button size="sm" className="col-span-2" onClick={() => update({ ...DEFAULTS })}>Reset settings</Button>
        </div>
      )}
      {editing ? (
        <textarea autoFocus className="no-drag flex-1 resize-none bg-transparent p-4 outline-none" style={{ fontSize: Math.min(tp.fontSize, 22), color: tp.color }}
          placeholder="Type or paste your script…" value={tp.script} onChange={(e) => update({ script: e.target.value })} onBlur={flush} />
      ) : (
        <div className="relative flex-1 overflow-hidden">
          {/* reading guide line (TEL-03) */}
          <div className="pointer-events-none absolute inset-x-0 top-[35%] z-10 h-[1.6em] -translate-y-1/2 border-y border-accent/70 bg-accent/10" style={{ fontSize: tp.fontSize }} />
          <div ref={scroller} className="no-drag h-full overflow-hidden px-6 leading-snug" style={{ fontSize: tp.fontSize, color: tp.color }}>
            <div style={{ height: '35%' }} />
            <div className="whitespace-pre-wrap font-semibold">{tp.script || 'Your script will scroll here.'}</div>
            <div style={{ height: '70%' }} />
          </div>
        </div>
      )}
      <div role="separator" aria-label="Resize teleprompter" title="Drag to resize" onPointerDown={resizeFrom}
        className="no-drag absolute bottom-0 right-0 z-20 h-4 w-4 cursor-nwse-resize"
        style={{ background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.35) 50%)' }} />
    </div>
  );
}
