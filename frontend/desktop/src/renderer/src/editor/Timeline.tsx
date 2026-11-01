/**
 * Timeline (tasks 3.8, 5.5, 7.4, 8.5, 9.5, 10.4/10.8): ruler, playhead, hover preview, virtualised tracks.
 * Items stored in SOURCE time are drawn through srcRangeToOut (a cut can split them); edits convert back
 * with outToSrc, so cutting / speeding up never desyncs anything (§5.3).
 * Audit TLA: per-clip waveforms + audio rows from the cached peak pyramid (B1), separate Blur / Spotlight
 * mask tracks (B2/A3), a loop range on the ruler (A6: Alt+drag, right-click menu, draggable edges) and the
 * hover thumbnail over the whole track area (A24). Waveforms are canvases of the visible window only and
 * redraw only when their inputs change — never per playback frame.
 */
import { Gauge, Plus, Repeat, Scissors, Trash2, Volume2, VolumeX, X, ZoomIn, ZoomOut } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  clipOutLen,
  clipOutStart,
  formatTime,
  makeZoom,
  outToSrc,
  speedUpSourceRange,
  splitAt,
  srcRangeToOut,
  trimClip,
  uid,
  type Annotation,
  type Project,
} from '@rec/shared';
import type { TrackAnalysis } from '../audio/analysis';
import { useAnalysisProgress, useTrackAnalysis } from '../audio/analysisStore';
import { duckFor, musicEnd, trackFile, trackGain, TRACK_KEYS, type TrackKey } from '../audio/mixModel';
import { cx, IconButton, Tooltip } from '../ui';
import { mediaUrl } from './media';
import { freeLane, makeAnnotation } from './panels/AnnotationPanel';
import { useEditor, type ModuleId, type SelKind } from './store';
import { drawClipWaveform, drawMusicWaveform } from './waveform';

const TRACK_H = 30;
const AUDIO_H = 30;
const HEADER_W = 92;
const AUDIO_TITLE: Record<TrackKey, string> = { mic: 'Mic', system: 'System', device: 'Device' };
const AUDIO_COLOR: Record<TrackKey, string> = { mic: 'rgba(34,197,94,0.85)', system: 'rgba(56,189,248,0.85)', device: 'rgba(244,114,182,0.85)' };

interface Seg {
  id: string;
  kind: SelKind;
  start: number; // output s
  end: number;
  label: string;
  color: string;
  srcStart?: number;
  srcEnd?: number;
  dim?: boolean;
  lane?: number;
}

type DragState =
  | { kind: 'move' | 'start' | 'end'; seg: Seg; x0: number; t0: number }
  | { kind: 'playhead' }
  | { kind: 'loop-new'; anchor: number }
  | { kind: 'loop-start' }
  | { kind: 'loop-end' }
  | null;

interface TrackDef {
  key: string;
  title: string;
  segs: Seg[];
  lanes: number;
  height: number;
  addable?: boolean;
  audio?: TrackKey;
}

export function Timeline() {
  const project = useEditor((s) => s.project)!;
  const derived = useEditor((s) => s.derived);
  const time = useEditor((s) => s.time);
  const zoom = useEditor((s) => s.timelineZoom);
  const sel = useEditor((s) => s.selection);
  const opened = useEditor((s) => s.opened);
  const loop = useEditor((s) => s.loop);
  const module = useEditor((s) => s.module);
  const { edit, select, setTime, setTimelineZoom, setLoop } = useEditor.getState();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollX, setScrollX] = useState(0);
  const [viewW, setViewW] = useState(800);
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; t: number } | null>(null);
  const drag = useRef<DragState>(null);
  const hoverRaf = useRef(0);
  const hoverNext = useRef<{ t: number; x: number } | null>(null);
  const [, force] = useState(0);
  const duration = derived?.duration ?? 0;
  const width = Math.max(viewW, duration * zoom + 200);
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  // audio analyses (decoded once per file, cached in the bundle): the file that actually plays; the raw mic
  // stands in while a denoised / enhanced version is still being analysed
  const micFile = trackFile(project, 'mic', project.audio.mic.denoise);
  const micPlayed = useTrackAnalysis(micFile);
  const micRaw = useTrackAnalysis(project.source.tracks.mic, { load: false });
  const sysA = useTrackAnalysis(project.source.tracks.system);
  const devA = useTrackAnalysis(project.source.tracks.device);
  const musicA = useTrackAnalysis(project.music?.file);
  const analyses: Record<TrackKey, TrackAnalysis | null> = { mic: micPlayed ?? micRaw, system: sysA, device: devA };
  const audioFiles: Record<TrackKey, string | undefined> = { mic: micFile, system: project.source.tracks.system, device: project.source.tracks.device };
  const primary = TRACK_KEYS.find((k) => project.source.tracks[k]);
  const duck = duckFor(project, micPlayed);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth - HEADER_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // fit long recordings on first open
  useEffect(() => {
    if (duration > 0 && viewW > 0) setTimelineZoom(Math.max(4, Math.min(120, (viewW - 40) / duration)));
  }, [opened]);

  // keep playhead visible while playing
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const x = time * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + viewW - 40) el.scrollLeft = Math.max(0, x - 80);
  }, [Math.floor((time * zoom) / Math.max(1, viewW - 120))]);

  // a cut that shortens the video also shortens (or drops) the loop
  useEffect(() => {
    if (loop && duration > 0 && loop.end > duration + 1e-3) setLoop(loop.start < duration - 0.1 ? { start: loop.start, end: duration } : null);
  }, [duration]);

  const tracks = useMemo(() => buildTracks(project, duration, module), [project, duration, module]);

  const tFromX = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.min(duration, Math.max(0, (clientX - r.left - HEADER_W + el.scrollLeft) / zoom));
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = tFromX(e.clientX);
    if (d.kind === 'playhead') {
      setTime(t);
      return;
    }
    if (d.kind === 'loop-new') {
      if (Math.abs(t - d.anchor) >= 0.05) setLoop({ start: Math.min(d.anchor, t), end: Math.max(d.anchor, t) });
      return;
    }
    if (d.kind === 'loop-start' || d.kind === 'loop-end') {
      const l = useEditor.getState().loop;
      if (!l) return;
      if (d.kind === 'loop-start') setLoop({ start: Math.min(t, l.end - 0.1), end: l.end });
      else setLoop({ start: l.start, end: Math.max(t, l.start + 0.1) });
      return;
    }
    const dt = t - d.t0;
    const seg = d.seg;
    if (seg.kind === 'clip') {
      const clip = project.clips.find((c) => c.id === seg.id)!;
      if (d.kind === 'move') return;
      const idx = project.clips.findIndex((c) => c.id === seg.id);
      const start = clipOutStart(project.clips, idx);
      if (d.kind === 'start') {
        const newSrc = seg.srcStart! + dt * clip.speed;
        edit('Trim clip', (p) => { p.clips = trimClip(p.clips, seg.id, 'start', newSrc, p.source.durationSec); }, `trim-${seg.id}`);
      } else {
        const newSrc = clip.srcStart + (t - start) * clip.speed;
        edit('Trim clip', (p) => { p.clips = trimClip(p.clips, seg.id, 'end', newSrc, p.source.durationSec); }, `trim-${seg.id}`);
      }
      return;
    }
    if (seg.kind === 'music') {
      edit('Move music', (p) => {
        if (!p.music) return;
        const len = seg.end - seg.start;
        if (d.kind === 'move') {
          p.music.rangeStart = Math.max(0, Math.min(Math.max(0, duration - len), seg.start + dt));
          p.music.rangeEnd = p.music.rangeStart + len;
        } else if (d.kind === 'start') p.music.rangeStart = Math.min(Math.min(p.music.rangeEnd, duration) - 0.2, Math.max(0, seg.start + dt));
        else p.music.rangeEnd = Math.max(p.music.rangeStart + 0.2, Math.min(duration, seg.end + dt));
      }, `music`);
      return;
    }
    // source-time segment: convert edges through the clip map
    const srcAt = (tOut: number) => outToSrc(project.clips, Math.max(0, Math.min(duration, tOut))).src;
    const len = (seg.srcEnd ?? 0) - (seg.srcStart ?? 0);
    let ns = seg.srcStart!, ne = seg.srcEnd!;
    if (d.kind === 'move') { ns = srcAt(seg.start + dt); ne = ns + len; }
    else if (d.kind === 'start') ns = Math.min(ne - 0.2, srcAt(seg.start + dt));
    else ne = Math.max(ns + 0.2, srcAt(seg.end + dt));
    const apply = (p: Project) => {
      const list: Array<{ id: string; start: number; end: number }> =
        seg.kind === 'zoom' ? p.zooms : seg.kind === 'layout' ? p.layouts : seg.kind === 'annotation' ? p.annotations : p.captions?.blocks ?? [];
      const it = list.find((x) => x.id === seg.id);
      if (it) { it.start = Math.max(0, ns); it.end = Math.min(p.source.durationSec, ne); }
    };
    edit(`Edit ${seg.kind}`, (p) => apply(p as Project), `seg-${seg.id}`);
  };

  // one window listener pair for the component's lifetime; it always calls the latest handler
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  useEffect(() => {
    const mv = (e: PointerEvent) => onMoveRef.current(e);
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      force((n) => n + 1);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      cancelAnimationFrame(hoverRaf.current);
    };
  }, []);

  // context menu: close on outside click / Escape / scroll
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      if (e.type === 'mousedown' && (e.target as HTMLElement).closest?.('[data-timeline-menu]')) return;
      setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const startDrag = (e: React.PointerEvent, kind: 'move' | 'start' | 'end', seg: Seg) => {
    e.stopPropagation();
    select(seg.kind, seg.id);
    drag.current = { kind, seg, x0: e.clientX, t0: tFromX(e.clientX) };
    setHover(null);
  };

  const addAt = (trackKind: string, tOut: number) => {
    const src = outToSrc(project.clips, tOut).src;
    if (trackKind === 'zoom') {
      const z = makeZoom(src, Math.min(project.source.durationSec, src + 3), 2, { type: 'follow' }, 'manual', useEditor.getState().project!.zooms[0]?.mode ?? '2d');
      edit('Add zoom', (p) => { p.zooms.push(z); });
      select('zoom', z.id);
    } else if (trackKind === 'layout') {
      const id = uid('lay');
      edit('Add layout', (p) => { p.layouts.push({ id, start: src, end: Math.min(p.source.durationSec, src + 4), layoutId: 'camera-full', transitionSec: 0.4 }); });
      select('layout', id);
    } else if (trackKind === 'blur' || trackKind === 'spotlight') {
      const p0 = useEditor.getState().project!;
      const end = Math.min(p0.source.durationSec, src + 3);
      const a = makeAnnotation(trackKind, src, end, freeLane(p0.annotations, src, end));
      edit(`Add ${trackKind}`, (p) => { p.annotations.push(a); });
      select('annotation', a.id);
    }
  };

  // hover preview over ruler AND tracks (A24), rAF-throttled so pointer moves don't re-render per event
  const scheduleHover = (h: { t: number; x: number } | null) => {
    hoverNext.current = h;
    if (hoverRaf.current) return;
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = 0;
      setHover(hoverNext.current);
    });
  };
  const onHoverMove = (e: React.PointerEvent) => {
    const el = scroller.current;
    if (!el || drag.current) return scheduleHover(null);
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x < HEADER_W || x > el.clientWidth || e.clientY - r.top > el.clientHeight) return scheduleHover(null);
    scheduleHover({ t: tFromX(e.clientX), x: e.clientX });
  };

  // ruler ticks
  const step = niceStep(80 / zoom);
  const ticks: number[] = [];
  const t0 = Math.floor(scrollX / zoom / step) * step;
  for (let t = t0; t <= Math.min(duration + step, (scrollX + viewW) / zoom + step); t += step) ticks.push(t);
  const visible = (s: Seg) => s.end * zoom >= scrollX - 50 && s.start * zoom <= scrollX + viewW + 50;

  const selected = sel.id;
  const splitClip = () => edit('Split clip', (p) => { p.clips = splitAt(p.clips, useEditor.getState().time); });

  const selectionRange = (): { start: number; end: number } | null => {
    if (!sel.id) return null;
    let a = Infinity, b = -Infinity;
    for (const tr of tracks) for (const s of tr.segs) if (s.id === sel.id) { a = Math.min(a, s.start); b = Math.max(b, s.end); }
    return b - a >= 0.1 ? { start: a, end: b } : null;
  };
  const toggleLoop = () => {
    if (loop) return setLoop(null);
    const r = selectionRange();
    if (r) return setLoop(r);
    const start = Math.max(0, Math.min(time, duration - 5));
    setLoop({ start, end: Math.min(duration, start + 5) });
  };

  const view = { scrollX, zoom, width: viewW, dpr };
  const contentH = tracks.reduce((s, tr) => s + tr.height, 0);

  return (
    <div className="flex h-full flex-col border-t border-line bg-panel">
      <div className="flex h-9 items-center gap-1 border-b border-line px-2">
        <IconButton label="Split at playhead (C)" onClick={splitClip}><Scissors size={15} /></IconButton>
        <IconButton label="Delete selection" disabled={!selected} onClick={() => deleteSelection()}><Trash2 size={15} /></IconButton>
        <IconButton label="Add zoom at playhead (Z)" onClick={() => addAt('zoom', time)}><Plus size={15} /></IconButton>
        <IconButton label={loop ? 'Clear loop' : 'Loop selection / next 5 s (Alt+drag on the ruler)'} active={!!loop} onClick={toggleLoop}><Repeat size={15} /></IconButton>
        {loop && (
          <span className="flex items-center gap-1 rounded-md bg-accent/15 py-0.5 pl-2 pr-1 font-mono text-[11px] tabular-nums text-accent-2">
            {formatTime(loop.start)}–{formatTime(loop.end)}
            <button aria-label="Clear loop" className="rounded p-0.5 hover:bg-accent/25" onClick={() => setLoop(null)}><X size={11} /></button>
          </span>
        )}
        <div className="mx-2 font-mono text-xs tabular-nums text-muted">{formatTime(time)} / {formatTime(duration)}</div>
        <div className="flex-1" />
        <IconButton label="Zoom out timeline" onClick={() => setTimelineZoom(zoom / 1.4)}><ZoomOut size={15} /></IconButton>
        <input aria-label="Timeline zoom" type="range" min={Math.log(2)} max={Math.log(800)} step={0.01} value={Math.log(zoom)} onChange={(e) => setTimelineZoom(Math.exp(parseFloat(e.target.value)))} className="w-28" />
        <IconButton label="Zoom in timeline" onClick={() => setTimelineZoom(zoom * 1.4)}><ZoomIn size={15} /></IconButton>
      </div>
      <div
        ref={scroller}
        className="relative flex-1 overflow-auto"
        onScroll={(e) => { setScrollX((e.target as HTMLDivElement).scrollLeft); if (menu) setMenu(null); }}
        onPointerMove={onHoverMove}
        onPointerLeave={() => scheduleHover(null)}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const tAt = tFromX(e.clientX);
            const nz = Math.min(800, Math.max(2, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
            setTimelineZoom(nz);
            requestAnimationFrame(() => {
              const el = scroller.current!;
              el.scrollLeft = tAt * nz - (e.clientX - el.getBoundingClientRect().left - HEADER_W);
            });
          }
        }}
      >
        <div style={{ width: width + HEADER_W }} className="relative">
          {/* ruler: click/drag = scrub, Alt+drag = loop range, right-click = loop menu */}
          <div className="sticky top-0 z-20 flex h-6 bg-panel">
            <div className="sticky left-0 z-30 shrink-0 border-r border-line bg-panel" style={{ width: HEADER_W }} />
            <div
              className="relative flex-1 cursor-pointer select-none"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const t = tFromX(e.clientX);
                if (e.altKey) {
                  drag.current = { kind: 'loop-new', anchor: t };
                  return;
                }
                setTime(t);
                drag.current = { kind: 'playhead' };
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, t: tFromX(e.clientX) });
              }}
            >
              {ticks.map((t) => (
                <div key={t} className="pointer-events-none absolute top-0 h-full border-l border-line text-[10px] text-muted" style={{ left: t * zoom }}>
                  <span className="ml-1">{formatTime(t, step < 1)}</span>
                </div>
              ))}
              {loop && (
                <div className="pointer-events-none absolute inset-y-0 border-x-2 border-accent bg-accent/25" style={{ left: loop.start * zoom, width: Math.max(2, (loop.end - loop.start) * zoom) }}>
                  <div title="Drag to change the loop start" className="pointer-events-auto absolute -left-1.5 inset-y-0 w-2.5 cursor-ew-resize"
                    onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); drag.current = { kind: 'loop-start' }; }} />
                  <div title="Drag to change the loop end" className="pointer-events-auto absolute -right-1.5 inset-y-0 w-2.5 cursor-ew-resize"
                    onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); drag.current = { kind: 'loop-end' }; }} />
                </div>
              )}
            </div>
          </div>
          {tracks.map((tr) => (
            <div key={tr.key} className="flex border-b border-line/60" style={{ height: tr.height }}>
              <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-line bg-panel px-2 text-[11px] text-muted" style={{ width: HEADER_W }}>
                <span className="flex-1 truncate">{tr.title}</span>
                {tr.audio && <AudioMute track={tr.audio} />}
              </div>
              <div className="relative flex-1" onDoubleClick={(e) => tr.addable && addAt(tr.key, tFromX(e.clientX))}
                onPointerDown={(e) => { if (e.target === e.currentTarget && e.button === 0) { select(null, null); setTime(tFromX(e.clientX)); drag.current = { kind: 'playhead' }; } }}>
                {tr.addable && !tr.segs.length && <div className="pointer-events-none absolute inset-0 flex items-center pl-2 text-[10px] text-muted/40" style={{ left: scrollX }}>double-click to add</div>}
                {tr.segs.filter(visible).map((s) => (
                  <div key={`${s.id}-${s.start}`}
                    className={cx('group absolute flex overflow-hidden rounded-md px-2 text-[11px] text-white shadow-sm', s.kind === 'clip' || s.kind === 'music' ? 'items-start pt-0.5' : 'items-center', selected === s.id ? 'ring-2 ring-white' : '', s.dim && 'opacity-40')}
                    style={{ left: s.start * zoom, width: Math.max(4, (s.end - s.start) * zoom), top: 2 + (s.lane ?? 0) * TRACK_H, height: TRACK_H - 4, background: s.color }}
                    onPointerDown={(e) => startDrag(e, 'move', s)}
                    title={s.label}>
                    <span className="pointer-events-none truncate leading-[13px]">{s.label}</span>
                    <div className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/40" onPointerDown={(e) => startDrag(e, 'start', s)} />
                    <div className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/40" onPointerDown={(e) => startDrag(e, 'end', s)} />
                  </div>
                ))}
                {tr.key === 'clips' && primary && analyses[primary] && (
                  <WaveCanvas left={scrollX} width={viewW} height={TRACK_H} deps={[analyses[primary], project.clips, project.audio[primary].mute, zoom, scrollX, viewW, dpr]}
                    paint={(ctx) => drawClipWaveform(ctx, analyses[primary]!, project.clips, project.source.trackOffsets[primary] ?? 0, view, {
                      mode: 'bottom', color: 'rgba(255,255,255,0.42)', mutedColor: 'rgba(255,255,255,0.14)', top: 15 * dpr, height: 12 * dpr,
                      gainOf: (c) => trackGain(project, primary) * c.volume[primary],
                    })} />
                )}
                {tr.audio && (analyses[tr.audio] ? (
                  <WaveCanvas left={scrollX} width={viewW} height={AUDIO_H} deps={[analyses[tr.audio], project.clips, project.audio[tr.audio].mute, project.audio[tr.audio].volume, zoom, scrollX, viewW, dpr]}
                    paint={(ctx) => drawClipWaveform(ctx, analyses[tr.audio!]!, project.clips, project.source.trackOffsets[tr.audio!] ?? 0, view, {
                      mode: 'center', color: AUDIO_COLOR[tr.audio!], mutedColor: 'rgba(152,152,168,0.35)', top: 3 * dpr, height: (AUDIO_H - 6) * dpr,
                      gainOf: (c) => trackGain(project, tr.audio!) * c.volume[tr.audio!], separators: 'rgba(152,152,168,0.35)',
                    })} />
                ) : <WaveStatus file={audioFiles[tr.audio]} left={scrollX} />)}
                {tr.key === 'music' && project.music && (
                  <WaveCanvas left={scrollX} width={viewW} height={TRACK_H} deps={[musicA, project.music, project.clips, duck, zoom, scrollX, viewW, dpr]}
                    paint={(ctx) => drawMusicWaveform(ctx, musicA, project, duck, view, {
                      mode: 'bottom', color: 'rgba(255,255,255,0.32)', mutedColor: 'rgba(255,255,255,0.14)', top: 15 * dpr, height: 12 * dpr, envelope: 'rgba(255,255,255,0.85)',
                    })} />
                )}
                {tr.key === 'clips' && (derived?.speedUps ?? []).map((su) => {
                  const r = srcRangeToOut(project.clips, su.start, su.end)[0];
                  if (!r) return null;
                  const already = project.clips.some((c) => c.speed > 1 && c.srcStart <= su.start + 0.05 && c.srcEnd >= su.end - 0.05);
                  if (already) return null;
                  return (
                    <Tooltip key={su.id} text={`Typing detected: speed up ${su.speed}×`}>
                      <button className="absolute z-10 flex h-5 items-center gap-1 rounded-full bg-warn px-2 text-[10px] font-semibold text-black shadow" style={{ left: r[0] * zoom + 4, top: -2 }}
                        onClick={() => edit(`Speed up typing ${su.speed}×`, (p) => { p.clips = speedUpSourceRange(p.clips, su.start, su.end, su.speed); })}>
                        <Gauge size={11} /> {su.speed}× ({Math.round(su.end - su.start)} s typing)
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          ))}
          {/* loop band over the tracks */}
          {loop && <div className="pointer-events-none absolute top-6 z-[5] border-x border-accent/50 bg-accent/[0.07]" style={{ left: HEADER_W + loop.start * zoom, width: Math.max(1, (loop.end - loop.start) * zoom), height: contentH }} />}
          {/* hover line */}
          {hover && <div className="pointer-events-none absolute top-0 z-[25] w-px bg-white/35" style={{ left: HEADER_W + hover.t * zoom, height: contentH + 24 }} />}
          {/* playhead */}
          <div className="pointer-events-none absolute top-0 z-30 h-full" style={{ left: HEADER_W + time * zoom }}>
            <div className="pointer-events-auto -ml-1.5 h-3 w-3 cursor-ew-resize rounded-sm bg-accent" onPointerDown={() => (drag.current = { kind: 'playhead' })} />
            <div className="ml-[-0.5px] h-full w-px bg-accent" />
          </div>
        </div>
      </div>
      {opened && <HoverPreview hover={hover} project={project} mediaBase={opened.mediaBase} />}
      {menu && (
        <div data-timeline-menu className="fixed z-[120] w-56 rounded-xl border border-line bg-panel-2 p-1 text-[13px] shadow-2xl" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 232), top: Math.max(8, menu.y - 176) }}>
          <div className="px-3 pb-1 pt-0.5 font-mono text-[11px] text-muted">{formatTime(menu.t)}</div>
          {([
            ['Loop from here', duration - menu.t >= 0.1, () => setLoop({ start: menu.t, end: loop && loop.end > menu.t + 0.1 ? loop.end : Math.min(duration, menu.t + 5) })],
            ['Loop to here', menu.t >= 0.1, () => setLoop({ start: loop && loop.start < menu.t - 0.1 ? loop.start : Math.max(0, menu.t - 5), end: menu.t })],
            ['Loop selected item', !!selectionRange(), () => { const r = selectionRange(); if (r) setLoop(r); }],
            ['Clear loop', !!loop, () => setLoop(null)],
          ] as Array<[string, boolean, () => void]>).map(([label, enabled, run]) => (
            <button key={label} role="menuitem" disabled={!enabled} onClick={() => { run(); setMenu(null); }}
              className="flex w-full items-center rounded-lg px-3 py-1.5 text-left hover:bg-accent/20 disabled:pointer-events-none disabled:opacity-40">{label}</button>
          ))}
          <div className="px-3 pb-0.5 pt-1 text-[11px] text-muted">Tip: Alt+drag on the ruler draws a loop</div>
        </div>
      )}
    </div>
  );
}

function deleteSelection(): void {
  const { selection, edit, select } = useEditor.getState();
  const id = selection.id;
  if (!id) return;
  if (selection.kind === 'clip') edit('Delete clip', (p) => { if (p.clips.length > 1) p.clips = p.clips.filter((c) => c.id !== id); });
  else if (selection.kind === 'zoom') edit('Delete zoom', (p) => { p.zooms = p.zooms.filter((z) => z.id !== id); });
  else if (selection.kind === 'layout') edit('Delete layout', (p) => { p.layouts = p.layouts.filter((z) => z.id !== id); });
  else if (selection.kind === 'annotation') edit('Delete annotation', (p) => { p.annotations = p.annotations.filter((z) => z.id !== id); });
  else if (selection.kind === 'caption') edit('Delete caption', (p) => { if (p.captions) p.captions.blocks = p.captions.blocks.filter((z) => z.id !== id); });
  else if (selection.kind === 'music') edit('Remove music', (p) => { delete p.music; });
  select(null, null);
}
export { deleteSelection };

/** Mute toggle in an audio row header. */
function AudioMute({ track }: { track: TrackKey }) {
  const muted = useEditor((s) => s.project?.audio[track].mute ?? false);
  const name = AUDIO_TITLE[track];
  return (
    <button aria-label={muted ? `Unmute ${name}` : `Mute ${name}`} aria-pressed={muted} title={muted ? `Unmute ${name}` : `Mute ${name}`}
      className={cx('rounded p-0.5 hover:bg-panel-2', muted ? 'text-danger' : 'text-muted hover:text-text')}
      onClick={() => useEditor.getState().edit(muted ? `Unmute ${name}` : `Mute ${name}`, (p) => { p.audio[track].mute = !muted; })}>
      {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
    </button>
  );
}

/** "Analysing audio… 42 %" placeholder while a track's peaks are computed for the first time. */
function WaveStatus({ file, left }: { file: string | undefined; left: number }) {
  const progress = useAnalysisProgress(file);
  if (progress === null) return null;
  return <div className="pointer-events-none absolute inset-y-0 flex items-center pl-2 text-[10px] text-muted" style={{ left }}>Analysing audio… {Math.round(progress * 100)}%</div>;
}

/** Visible-window canvas; repaints only when `deps` change (never per playback frame). */
const WaveCanvas = memo(
  function WaveCanvas({ left, width, height, paint }: { left: number; width: number; height: number; deps: readonly unknown[]; paint: (ctx: CanvasRenderingContext2D) => void }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useLayoutEffect(() => {
      const c = ref.current;
      if (!c) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.max(1, Math.round(width * dpr)), H = Math.max(1, Math.round(height * dpr));
      if (c.width !== W) c.width = W;
      if (c.height !== H) c.height = H;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      paint(ctx);
    });
    return <canvas ref={ref} aria-hidden className="pointer-events-none absolute top-0" style={{ left, width, height }} />;
  },
  (a, b) => a.left === b.left && a.width === b.width && a.height === b.height && a.deps.length === b.deps.length && a.deps.every((d, i) => d === b.deps[i]),
);

/** Display lanes per track: the lanes its items actually use, packed densely (data lanes are shared by all annotations). */
function laneMap(items: readonly Annotation[]): Map<number, number> {
  return new Map([...new Set(items.map((a) => a.lane))].sort((a, b) => a - b).map((l, i) => [l, i]));
}

function srcSegs(project: Project, items: ReadonlyArray<{ id: string; start: number; end: number; lane?: number }>, kind: SelKind, color: string, label: (it: never) => string, dimOf?: (it: never) => boolean, lanes?: Map<number, number>): Seg[] {
  const out: Seg[] = [];
  for (const it of items) {
    const rs = srcRangeToOut(project.clips, it.start, it.end);
    const lane = lanes ? lanes.get(it.lane ?? 0) ?? 0 : it.lane ?? 0;
    rs.forEach(([a, b], i) => out.push({ id: it.id, kind, start: a, end: b, label: i === 0 ? label(it as never) : '', color, srcStart: it.start, srcEnd: it.end, dim: dimOf?.(it as never) ?? false, lane }));
  }
  return out;
}

function buildTracks(project: Project, duration: number, module: ModuleId): TrackDef[] {
  const tracks: TrackDef[] = [];
  const segH = (lanes: number) => lanes * TRACK_H + 4;
  let t = 0;
  tracks.push({
    key: 'clips', title: 'Clips', lanes: 1, height: segH(1),
    segs: project.clips.map((c) => {
      const s: Seg = { id: c.id, kind: 'clip', start: t, end: t + clipOutLen(c), label: `${c.speed !== 1 ? `${c.speed}× · ` : ''}${formatTime(c.srcEnd - c.srcStart, false)}`, color: '#4b4b63', srcStart: c.srcStart, srcEnd: c.srcEnd };
      t += clipOutLen(c);
      return s;
    }),
  });
  tracks.push({ key: 'zoom', title: 'Zoom', lanes: 1, height: segH(1), addable: true, segs: srcSegs(project, project.zooms, 'zoom', '#3b82f6', (z: { level: number; mode: string }) => `${z.mode === '3d' ? '3D ' : ''}${z.level.toFixed(1)}×`, (z: { enabled: boolean }) => !z.enabled) });
  if (project.source.tracks.camera || project.camera.avatar) tracks.push({ key: 'layout', title: 'Layouts', lanes: 1, height: segH(1), addable: true, segs: srcSegs(project, project.layouts, 'layout', '#14b8a6', (l: { layoutId: string }) => l.layoutId) });
  // annotations: blur and spotlight masks get their own tracks (B2/A3)
  const other = project.annotations.filter((a) => a.type !== 'blur' && a.type !== 'spotlight');
  const blurs = project.annotations.filter((a) => a.type === 'blur');
  const spots = project.annotations.filter((a) => a.type === 'spotlight');
  const otherLanes = laneMap(other);
  tracks.push({ key: 'annotation', title: 'Annotations', lanes: Math.max(1, otherLanes.size), height: segH(Math.max(1, otherLanes.size)), segs: srcSegs(project, other, 'annotation', '#f97316', (a: { type: string; text?: string; shape?: string }) => (a.type === 'text' ? `T ${a.text ?? ''}` : a.shape ?? a.type), undefined, otherLanes) });
  const showMasks = module === 'annotation';
  for (const [key, title, items, color] of [['blur', 'Blur', blurs, '#0ea5e9'], ['spotlight', 'Spotlight', spots, '#ec4899']] as const) {
    if (!items.length && !showMasks) continue;
    const lanes = laneMap(items);
    tracks.push({ key, title, lanes: Math.max(1, lanes.size), height: segH(Math.max(1, lanes.size)), addable: true,
      segs: srcSegs(project, items, 'annotation', color, (a: { type: string; pixelate?: boolean }) => (a.type === 'blur' ? (a.pixelate ? 'Pixelate' : 'Blur') : 'Spotlight'), undefined, lanes) });
  }
  if (project.captions) tracks.push({ key: 'captions', title: 'Captions', lanes: 1, height: segH(1), segs: srcSegs(project, project.captions.blocks, 'caption', '#ca8a04', (b: { text: string }) => b.text, () => !project.captions!.enabled) });
  // audio rows (waveform through the clip map)
  for (const k of TRACK_KEYS) if (project.source.tracks[k]) tracks.push({ key: `audio-${k}`, title: AUDIO_TITLE[k], lanes: 1, height: AUDIO_H, segs: [], audio: k });
  if (project.music) {
    const end = Math.max(project.music.rangeStart + 0.05, Math.min(musicEnd(project), duration || musicEnd(project)));
    tracks.push({ key: 'music', title: 'Music', lanes: 1, height: segH(1), segs: [{ id: 'music', kind: 'music', start: project.music.rangeStart, end, label: `♪ ${project.music.name || 'Music'}`, color: '#a855f7' }] });
  }
  return tracks;
}

function niceStep(raw: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s >= raw) ?? 1200;
}

/**
 * Hover preview thumbnail (EDT-03 / A24) from a dedicated, throttled <video>. Stays mounted (hidden) between
 * hovers so moving from the ruler into the tracks, or back in, never reloads the video.
 */
function HoverPreview({ hover, project, mediaBase }: { hover: { t: number; x: number } | null; project: Project; mediaBase: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const screenFile = project.source.tracks.screen ?? project.source.segments[0]?.file ?? '';
  useEffect(() => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = mediaUrl(mediaBase, screenFile);
    const draw = () => {
      const c = canvas.current;
      if (c && v.readyState >= 2) c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    };
    v.addEventListener('seeked', draw);
    video.current = v;
    return () => {
      v.removeEventListener('seeked', draw);
      v.removeAttribute('src');
      v.load();
      video.current = null;
    };
  }, [mediaBase, screenFile]);
  const t = hover?.t ?? null;
  useEffect(() => {
    if (t === null) return;
    const id = setTimeout(() => {
      const v = video.current;
      if (v) v.currentTime = outToSrc(project.clips, t).src;
    }, 40);
    return () => clearTimeout(id);
  }, [t]);
  const aspect = project.source.width / project.source.height;
  return (
    <div className={cx('pointer-events-none fixed z-50 -translate-x-1/2 rounded-lg border border-line bg-black p-1 shadow-xl', !hover && 'hidden')} style={{ left: hover?.x ?? 0, bottom: 230 }}>
      <canvas ref={canvas} width={160} height={Math.round(160 / aspect)} className="block rounded" />
      <div className="mt-0.5 text-center font-mono text-[10px] text-white">{formatTime(hover?.t ?? 0)}</div>
    </div>
  );
}
