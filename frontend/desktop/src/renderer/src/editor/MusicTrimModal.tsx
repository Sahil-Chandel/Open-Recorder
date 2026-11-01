/**
 * Music trim editor (AUD-06): canvas waveform from the shared cached peaks (no second decode), draggable /
 * keyboard-adjustable start & end handles, play/stop preview with a live playhead, Apply.
 * Decode failures show a message instead of an unhandled rejection (audit B misc).
 */
import { Pause, Play } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatTime } from '@rec/shared';
import { peakSpan } from '../audio/analysis';
import { useAnalysisProgress, useAnalysisStatus, useTrackAnalysis } from '../audio/analysisStore';
import { stopLibraryPreview } from '../audio/libraryPreview';
import { Button, Modal } from '../ui';
import { mediaUrl } from './media';
import { useEditor } from './store';
import { waveScale } from './waveform';

const MIN_LEN = 0.5;

export function MusicTrimModal({ onClose }: { onClose: () => void }) {
  const music = useEditor((s) => s.project!.music!);
  const base = useEditor((s) => s.opened!.mediaBase);
  const analysis = useTrackAnalysis(music.file);
  const status = useAnalysisStatus(music.file);
  const progress = useAnalysisProgress(music.file);
  const [metaDur, setMetaDur] = useState<number | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const dur = Math.max(MIN_LEN * 2, analysis?.duration ?? metaDur ?? music.trimEnd);
  const [a, setA] = useState(music.trimStart);
  const [b, setB] = useState(music.trimEnd);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const drag = useRef<'a' | 'b' | null>(null);
  const range = useRef({ a, b, dur });
  range.current = { a, b, dur };
  const failed = mediaError || status === 'error' || status === 'missing';

  // preview element (also the duration source while peaks load)
  useEffect(() => {
    stopLibraryPreview();
    if (useEditor.getState().playing) useEditor.getState().setPlaying(false);
    const el = new Audio(mediaUrl(base, music.file));
    el.preload = 'auto';
    el.onloadedmetadata = () => { if (Number.isFinite(el.duration)) setMetaDur(el.duration); };
    el.onerror = () => setMediaError(true);
    audio.current = el;
    return () => {
      el.pause();
      el.removeAttribute('src');
      el.load();
      audio.current = null;
    };
  }, [base, music.file]);

  // playhead + stop at the selection end (rAF only while playing, DOM style → no re-render per frame)
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audio.current;
      if (!el) return;
      const r = range.current;
      if (el.currentTime >= r.b || el.ended || el.paused) {
        el.pause();
        setPlaying(false);
        return;
      }
      if (head.current) head.current.style.left = `${(el.currentTime / r.dur) * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // waveform (once per analysis / size)
  useLayoutEffect(() => {
    const c = canvas.current, bx = box.current;
    if (!c || !bx || !analysis) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(bx.clientWidth * dpr)), H = Math.max(1, Math.round(bx.clientHeight * dpr));
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#a18bff';
    const scale = waveScale(analysis);
    const span = new Float32Array(2);
    const mid = H / 2;
    const secPerPx = dur / W;
    for (let x = 0; x < W; x++) {
      if (!peakSpan(analysis, x * secPerPx, (x + 1) * secPerPx, span)) continue;
      const hi = Math.min(1, span[1]! * scale), lo = Math.max(-1, span[0]! * scale);
      ctx.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
    }
  }, [analysis, dur]);

  useEffect(() => {
    const mv = (e: PointerEvent) => {
      const r = box.current?.getBoundingClientRect();
      if (!r || !drag.current) return;
      const { a: ca, b: cb, dur: d } = range.current;
      const t = Math.min(d, Math.max(0, ((e.clientX - r.left) / r.width) * d));
      if (drag.current === 'a') setA(Math.min(t, cb - MIN_LEN));
      else setB(Math.max(t, ca + MIN_LEN));
    };
    const up = () => (drag.current = null);
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  const togglePreview = () => {
    const el = audio.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }
    stopLibraryPreview();
    el.currentTime = a;
    void el.play().then(() => setPlaying(true)).catch(() => setMediaError(true));
  };

  const nudge = (h: 'a' | 'b', e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const stepS = (e.shiftKey ? 1 : 0.1) * d;
    if (h === 'a') setA((v) => Math.max(0, Math.min(b - MIN_LEN, v + stepS)));
    else setB((v) => Math.min(dur, Math.max(a + MIN_LEN, v + stepS)));
  };

  const apply = () => {
    const end = Math.min(b, dur);
    const start = Math.min(a, end - MIN_LEN);
    useEditor.getState().edit('Trim music', (p) => {
      if (!p.music) return;
      p.music.trimStart = Math.max(0, start);
      p.music.trimEnd = end;
    });
    onClose();
  };

  return (
    <Modal open onClose={onClose} title="Trim music" width={680} footer={<>
      <Button onClick={togglePreview} disabled={failed}>{playing ? <><Pause size={13} />Stop</> : <><Play size={13} />Preview</>}</Button>
      <Button variant="primary" onClick={apply} disabled={failed}>Apply</Button>
    </>}>
      <div ref={box} className="relative h-28 select-none overflow-hidden rounded-lg bg-panel-2">
        <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
        {!analysis && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">
            {failed ? 'Could not read this audio file.' : `Loading waveform…${progress !== null ? ` ${Math.round(progress * 100)}%` : ''}`}
          </div>
        )}
        <div className="pointer-events-none absolute inset-y-0 bg-black/50" style={{ left: 0, width: `${(a / dur) * 100}%` }} />
        <div className="pointer-events-none absolute inset-y-0 bg-black/50" style={{ left: `${(b / dur) * 100}%`, right: 0 }} />
        <div ref={head} className={playing ? 'pointer-events-none absolute inset-y-0 w-px bg-white' : 'hidden'} style={{ left: `${(a / dur) * 100}%` }} />
        {(['a', 'b'] as const).map((h) => (
          <div key={h} role="slider" tabIndex={0} aria-label={h === 'a' ? 'Trim start' : 'Trim end'} aria-valuemin={0} aria-valuemax={Math.round(dur * 10) / 10} aria-valuenow={Math.round((h === 'a' ? a : b) * 10) / 10}
            aria-valuetext={formatTime(h === 'a' ? a : b)}
            onPointerDown={(e) => { e.preventDefault(); drag.current = h; }} onKeyDown={(e) => nudge(h, e)}
            className="absolute inset-y-0 w-2 -translate-x-1 cursor-ew-resize bg-accent outline-none focus-visible:ring-2 focus-visible:ring-white" style={{ left: `${((h === 'a' ? a : b) / dur) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex justify-between font-mono text-xs text-muted"><span>{formatTime(a)}</span><span>{formatTime(b - a)} selected</span><span>{formatTime(b)}</span></div>
      <div className="mt-1 text-[11px] text-muted">Drag the handles or focus one and use ← / → (Shift = 1 s).</div>
    </Modal>
  );
}
