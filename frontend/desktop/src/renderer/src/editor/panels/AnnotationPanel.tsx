/**
 * Annotation module (tasks 8.1–8.5, ANN-01…08): add text (basic + artistic), shapes, highlight,
 * blur / spotlight / magnifier / callout masks at the playhead; auto lane assignment; list of items.
 */
import { ArrowUpRight, Circle, Droplets, Focus, Highlighter, Minus, Search, Square, Type, ZoomIn } from 'lucide-react';
import { outToSrc, uid, type Annotation } from '@rec/shared';
import { Section } from '../../ui';
import { useEditor } from '../store';
import { useP } from './common';

/** Pick the lowest lane with no overlap in [start, end) (auto lane assignment, task 8.1). */
export function freeLane(items: readonly Annotation[], start: number, end: number): number {
  for (let lane = 0; lane < 32; lane++) if (!items.some((a) => a.lane === lane && a.start < end && a.end > start)) return lane;
  return 0;
}

type Kind = 'text' | 'text-outline' | 'text-pill' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'highlight' | 'blur' | 'spotlight' | 'magnifier' | 'callout';

export function makeAnnotation(kind: Kind, start: number, end: number, lane: number): Annotation {
  const base = { id: uid('ann'), start, end, lane, rotation: 0, anim: { in: 'fade' as const, out: 'fade' as const, durSec: 0.3 } };
  const textStyle = { preset: 'basic' as const, font: 'Inter', size: 64, color: '#ffffff', bold: true, italic: false, underline: false, align: 'center' as const };
  const shapeStyle = { color: '#ef4444', fill: null, opacity: 1, strokeWidth: 6, cornerRadius: 12, head: 'triangle' as const, curved: false };
  switch (kind) {
    case 'text': return { ...base, type: 'text', space: 'canvas', rect: { x: 0.3, y: 0.1, w: 0.4, h: 0.12 }, text: 'Your text', style: { ...textStyle, preset: 'shadow' } };
    case 'text-outline': return { ...base, type: 'text', space: 'canvas', rect: { x: 0.3, y: 0.1, w: 0.4, h: 0.12 }, text: 'Big title', style: { ...textStyle, preset: 'outline', size: 90, color: '#ffd23f', color2: '#000000' } };
    case 'text-pill': return { ...base, type: 'text', space: 'canvas', rect: { x: 0.3, y: 0.8, w: 0.4, h: 0.08 }, text: 'Click here', style: { ...textStyle, preset: 'pill', size: 44, bg: '#7c5cff' } };
    case 'arrow': return { ...base, type: 'shape', shape: 'arrow', space: 'content', rect: { x: 0.35, y: 0.35, w: 0.15, h: 0.15 }, style: shapeStyle };
    case 'line': return { ...base, type: 'shape', shape: 'line', space: 'content', rect: { x: 0.35, y: 0.5, w: 0.2, h: 0 }, style: { ...shapeStyle, head: 'none' } };
    case 'rect': return { ...base, type: 'shape', shape: 'rect', space: 'content', rect: { x: 0.35, y: 0.35, w: 0.25, h: 0.18 }, style: shapeStyle };
    case 'ellipse': return { ...base, type: 'shape', shape: 'ellipse', space: 'content', rect: { x: 0.35, y: 0.35, w: 0.22, h: 0.18 }, style: shapeStyle };
    case 'highlight': return { ...base, type: 'shape', shape: 'highlight', space: 'content', rect: { x: 0.3, y: 0.4, w: 0.3, h: 0.06 }, style: { ...shapeStyle, color: '#fde047', fill: '#fde047', opacity: 0.55, strokeWidth: 0, cornerRadius: 4 } };
    case 'blur': return { ...base, type: 'blur', space: 'content', rect: { x: 0.35, y: 0.35, w: 0.25, h: 0.15 }, intensity: 0.6, softness: 0, pixelate: false };
    case 'spotlight': return { ...base, type: 'spotlight', space: 'content', rect: { x: 0.35, y: 0.3, w: 0.3, h: 0.25 }, opacity: 0.65, feather: 0.3, softness: 0.1 };
    case 'magnifier': return { ...base, type: 'magnifier', space: 'content', rect: { x: 0.4, y: 0.4, w: 0.15, h: 0.15 * 16 / 9 }, scale: 2, border: '#ffffff' };
    case 'callout': return { ...base, type: 'callout', space: 'content', rect: { x: 0.35, y: 0.35, w: 0.25, h: 0.15 }, scale: 1.4, popout: true, marquee: false, color: '#ffffff', roundness: 0.15, maskOpacity: 0.5 };
  }
}

const BUTTONS: Array<{ kind: Kind; label: string; icon: React.ReactNode; group: 'Text' | 'Shapes' | 'Masks' }> = [
  { kind: 'text', label: 'Text', icon: <Type size={16} />, group: 'Text' },
  { kind: 'text-outline', label: 'Title', icon: <Type size={16} strokeWidth={3} />, group: 'Text' },
  { kind: 'text-pill', label: 'Label', icon: <Type size={14} />, group: 'Text' },
  { kind: 'arrow', label: 'Arrow', icon: <ArrowUpRight size={16} />, group: 'Shapes' },
  { kind: 'line', label: 'Line', icon: <Minus size={16} />, group: 'Shapes' },
  { kind: 'rect', label: 'Rectangle', icon: <Square size={16} />, group: 'Shapes' },
  { kind: 'ellipse', label: 'Ellipse', icon: <Circle size={16} />, group: 'Shapes' },
  { kind: 'highlight', label: 'Highlight', icon: <Highlighter size={16} />, group: 'Shapes' },
  { kind: 'blur', label: 'Blur', icon: <Droplets size={16} />, group: 'Masks' },
  { kind: 'spotlight', label: 'Spotlight', icon: <Focus size={16} />, group: 'Masks' },
  { kind: 'magnifier', label: 'Magnifier', icon: <Search size={16} />, group: 'Masks' },
  { kind: 'callout', label: 'Callout', icon: <ZoomIn size={16} />, group: 'Masks' },
];

export function addAnnotation(kind: Kind): void {
  const s = useEditor.getState();
  const p = s.project!;
  const src = outToSrc(p.clips, s.time).src;
  const end = Math.min(p.source.durationSec, src + 3);
  const a = makeAnnotation(kind, src, end, freeLane(p.annotations, src, end));
  s.edit(`Add ${kind}`, (d) => { d.annotations.push(a); });
  s.select('annotation', a.id);
}

export function AnnotationPanel() {
  const anns = useP((p) => p.annotations);
  return (
    <>
      {(['Text', 'Shapes', 'Masks'] as const).map((g) => (
        <Section key={g} title={g}>
          <div className="grid grid-cols-3 gap-1.5">
            {BUTTONS.filter((b) => b.group === g).map((b) => (
              <button key={b.kind} onClick={() => addAnnotation(b.kind)} className="flex flex-col items-center gap-1 rounded-lg border border-line py-2 text-[11px] hover:border-accent hover:bg-accent/10">
                {b.icon}{b.label}
              </button>
            ))}
          </div>
        </Section>
      ))}
      <Section title={`On timeline (${anns.length})`}>
        {anns.length === 0 && <div className="text-xs text-muted">Added items appear here and on the timeline. Masks stick to the screen content while zooming.</div>}
        {anns.map((a) => (
          <button key={a.id} onClick={() => useEditor.getState().select('annotation', a.id)} className="truncate rounded-md px-2 py-1 text-left text-xs hover:bg-panel-2">
            {a.type === 'text' ? `“${a.text}”` : a.type === 'shape' ? a.shape : a.type} · lane {a.lane + 1}
          </button>
        ))}
      </Section>
    </>
  );
}
