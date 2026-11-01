/**
 * Properties of the selected timeline item: clip (EDT-05), zoom (ZOOM-05, M3D-*), layout (CAM-04),
 * annotation (ANN-*), caption block (CAP-04), music (AUD-06).
 */
import { ArrowLeft, Copy, Scissors, Trash2 } from 'lucide-react';
import { applyZoomSettingsToAll, canvasToSource, cloneData, DEFAULT_M3D, evaluateScene, sourceToCanvas, formatTime, outToSrc, presetsFor, splitZoom, tiltPresets, type Annotation, canvasAspect, orientationOf } from '@rec/shared';
import { FONT_CHOICES } from '../../fonts';
import { Button, ColorPicker, Section, Segmented, Select, Slider, TextInput, Toggle } from '../../ui';
import { useEditor } from '../store';
import { deleteSelection } from '../Timeline';
import { edit, useP } from './common';
import { copyProps, pasteProps } from '../props';

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function SelectionPanel() {
  const sel = useEditor((s) => s.selection);
  const back = (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2">
      <button aria-label="Back to module" onClick={() => useEditor.getState().select(null, null)} className="rounded p-1 hover:bg-panel-2"><ArrowLeft size={15} /></button>
      <span className="flex-1 text-[13px] font-semibold capitalize">{sel.kind}</span>
      <button aria-label="Copy properties" title="Copy properties" onClick={copyProps} className="rounded p-1 text-muted hover:bg-panel-2"><Copy size={14} /></button>
      <button title="Paste properties" onClick={pasteProps} className="rounded px-1 text-[11px] text-muted hover:bg-panel-2">Paste</button>
      <button aria-label="Delete" onClick={deleteSelection} className="rounded p-1 text-danger hover:bg-panel-2"><Trash2 size={14} /></button>
    </div>
  );
  return (
    <>
      {back}
      {sel.kind === 'clip' && <ClipProps id={sel.id!} />}
      {sel.kind === 'zoom' && <ZoomProps id={sel.id!} />}
      {sel.kind === 'layout' && <LayoutProps id={sel.id!} />}
      {sel.kind === 'annotation' && <AnnotationProps id={sel.id!} />}
      {sel.kind === 'caption' && <CaptionProps id={sel.id!} />}
      {sel.kind === 'music' && <div className="p-4 text-xs text-muted">Edit music settings in the Audio module. Drag the edges on the timeline to set the range.</div>}
    </>
  );
}

function ClipProps({ id }: { id: string }) {
  const clip = useP((p) => p.clips.find((c) => c.id === id));
  const tracks = useP((p) => p.source.tracks);
  if (!clip) return null;
  const set = (label: string, f: (c: NonNullable<typeof clip>) => void, key?: string) => edit(label, (p) => { const c = p.clips.find((x) => x.id === id); if (c) f(c); }, key);
  return (
    <>
      <Section title="Clip">
        <div className="text-xs text-muted">Source {formatTime(clip.srcStart)} → {formatTime(clip.srcEnd)}</div>
        <Slider label="Speed" value={clip.speed} min={0.25} max={8} step={0.25} onChange={(v) => set('Clip speed', (c) => { c.speed = v; }, `speed-${id}`)} format={(v) => `${v}×`} />
        <div className="flex flex-wrap gap-1">{[0.5, 1, 1.5, 2, 3, 4].map((s) => <Button key={s} size="sm" onClick={() => set('Clip speed', (c) => { c.speed = s; })}>{s}×</Button>)}</div>
        <Button size="sm" onClick={() => edit('Speed for all clips', (p) => { p.clips.forEach((c) => (c.speed = clip.speed)); })}>Apply speed to all clips</Button>
        {clip.speed > 2 && <div className="text-[11px] text-warn">Audio is muted above 2× speed.</div>}
        <Toggle label="Show cursor in this clip" checked={clip.showCursor} onChange={(v) => set('Clip cursor', (c) => { c.showCursor = v; })} />
      </Section>
      <Section title="Clip audio">
        {tracks.mic && <Slider label="Microphone" value={clip.volume.mic} min={0} max={3} onChange={(v) => set('Clip mic volume', (c) => { c.volume.mic = v; }, `cvm-${id}`)} format={pct} />}
        {tracks.system && <Slider label="System audio" value={clip.volume.system} min={0} max={3} onChange={(v) => set('Clip system volume', (c) => { c.volume.system = v; }, `cvs-${id}`)} format={pct} />}
        {tracks.device && <Slider label="Device audio" value={clip.volume.device} min={0} max={3} onChange={(v) => set('Clip device volume', (c) => { c.volume.device = v; }, `cvd-${id}`)} format={pct} />}
      </Section>
    </>
  );
}

function ZoomProps({ id }: { id: string }) {
  const z = useP((p) => p.zooms.find((x) => x.id === id));
  if (!z) return null;
  const set = (label: string, f: (x: NonNullable<typeof z>) => void, key?: string) => edit(label, (p) => { const it = p.zooms.find((x) => x.id === id); if (it) f(it); }, key);
  const m = z.m3d ?? DEFAULT_M3D(z.source !== 'manual');
  const setM = (label: string, f: (x: typeof m) => void, key?: string) => set(label, (it) => { it.m3d ??= DEFAULT_M3D(it.source !== 'manual'); f(it.m3d); }, key);
  return (
    <>
      <Section title="Zoom">
        <Toggle label="Enabled" checked={z.enabled} onChange={(v) => set('Toggle zoom', (x) => { x.enabled = v; })} />
        <Segmented value={z.mode} onChange={(v) => set('Zoom mode', (x) => { x.mode = v; if (v === '3d') x.m3d ??= DEFAULT_M3D(x.source !== 'manual'); })} options={[{ value: '2d', label: '2D Zoom' }, { value: '3d', label: '3D Motion' }]} />
        <Slider label="Zoom level" value={z.level} min={1} max={4} step={0.05} onChange={(v) => set('Zoom level', (x) => { x.level = v; }, `zl-${id}`)} format={(v) => `${v.toFixed(2)}×`} />
        <Segmented size="sm" value={z.focus.type} onChange={(v) => set('Zoom focus', (x) => { x.focus = v === 'follow' ? { type: 'follow' } : { type: 'fixed', x: 0.5, y: 0.5 }; })} options={[{ value: 'follow', label: 'Follow cursor' }, { value: 'fixed', label: 'Fixed point' }]} />
        {z.focus.type === 'fixed' && <Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent('editor:pickFocus', { detail: id }))}>Pick focus on preview…</Button>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => edit('Apply zoom to all', (p) => { p.zooms = applyZoomSettingsToAll(p.zooms, id); })}>Apply to all zooms</Button>
          <Button size="sm" onClick={() => { const s = useEditor.getState(); const src = outToSrc(s.project!.clips, s.time).src; edit('Split zoom', (p) => { p.zooms = splitZoom(p.zooms, id, src); }); }}><Scissors size={13} />Split at playhead</Button>
        </div>
      </Section>
      {z.mode === '3d' && (
        <Section title="3D motion">
          <Segmented size="sm" value={m.auto ? 'auto' : 'manual'} onChange={(v) => setM('3D mode', (x) => { x.auto = v === 'auto'; })} options={[{ value: 'auto', label: 'Auto (follow mouse)' }, { value: 'manual', label: 'Manual' }]} />
          {m.auto ? (
            <Segmented size="sm" value={m.intensity} onChange={(v) => setM('3D intensity', (x) => { x.intensity = v; })} options={[{ value: 'subtle', label: 'Subtle' }, { value: 'default', label: 'Default' }, { value: 'strong', label: 'Strong' }]} />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1">
                {tiltPresets().map((t, i) => (
                  <button key={i} onClick={() => setM('Tilt preset', (x) => { x.tilt = t; })} className="flex h-12 items-center justify-center rounded-md border border-line hover:border-accent" style={{ perspective: 200 }}>
                    <div className="h-6 w-10 rounded-sm bg-accent/70" style={{ transform: `rotateX(${t.x}deg) rotateY(${t.y}deg) rotateZ(${t.z}deg)` }} />
                  </button>
                ))}
              </div>
              <Slider label="Rotate X" value={m.tilt.x} min={-45} max={45} step={1} onChange={(v) => setM('Tilt X', (x) => { x.tilt.x = v; }, `tx-${id}`)} format={(v) => `${v}°`} />
              <Slider label="Rotate Y" value={m.tilt.y} min={-45} max={45} step={1} onChange={(v) => setM('Tilt Y', (x) => { x.tilt.y = v; }, `ty-${id}`)} format={(v) => `${v}°`} />
              <Slider label="Rotate Z" value={m.tilt.z} min={-45} max={45} step={1} onChange={(v) => setM('Tilt Z', (x) => { x.tilt.z = v; }, `tz-${id}`)} format={(v) => `${v}°`} />
              <Slider label="Field of view" value={m.tilt.fov} min={20} max={90} step={1} onChange={(v) => setM('FOV', (x) => { x.tilt.fov = v; }, `fov-${id}`)} format={(v) => `${v}°`} />
              <Slider label="Position X" value={m.position.x} min={-1} max={1} onChange={(v) => setM('Position X', (x) => { x.position.x = v; }, `px-${id}`)} format={pct} />
              <Slider label="Position Y" value={m.position.y} min={-1} max={1} onChange={(v) => setM('Position Y', (x) => { x.position.y = v; }, `py-${id}`)} format={pct} />
              <Select label="Recipe" value={m.recipe} onChange={(v) => setM('3D recipe', (x) => { x.recipe = v; if (v === 'showcase') x.tilt = tiltPresets()[0]!; })} options={[{ value: 'none', label: 'None' }, { value: 'entrance', label: 'Entrance animation' }, { value: 'showcase', label: 'Perspective showcase' }]} />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent('editor:pickFocusArea', { detail: id }))}>{m.focusArea ? 'Redraw focus area' : 'Draw focus area'}</Button>
                {m.focusArea && <Button size="sm" variant="ghost" onClick={() => setM('Clear focus area', (x) => { delete x.focusArea; })}>Clear</Button>}
              </div>
            </>
          )}
        </Section>
      )}
    </>
  );
}

function LayoutProps({ id }: { id: string }) {
  const l = useP((p) => p.layouts.find((x) => x.id === id));
  const orientation = useP((p) => orientationOf(canvasAspect(p.canvas, p.source.width, p.source.height)));
  const customLayout = useP((p) => (p.camera.customLayout?.orientation === orientation ? p.camera.customLayout : undefined));
  if (!l) return null;
  const set = (label: string, f: (x: NonNullable<typeof l>) => void, key?: string) => edit(label, (p) => { const it = p.layouts.find((x) => x.id === id); if (it) f(it); }, key);
  return (
    <Section title="Layout segment">
      <Select label="Layout" value={l.layoutId} onChange={(v) => set('Segment layout', (x) => {
        x.layoutId = v;
        if (v === 'custom' && customLayout) x.custom = cloneData(customLayout);
        else delete x.custom;
      })} options={[...presetsFor(orientation).map((p) => ({ value: p.id, label: p.name })), ...(customLayout ? [{ value: 'custom', label: 'Custom (from Adjust Layout)' }] : [])]} />
      <Slider label="Transition" value={l.transitionSec} min={0} max={1.5} step={0.05} onChange={(v) => set('Transition', (x) => { x.transitionSec = v; }, `lt-${id}`)} format={(v) => `${v.toFixed(2)} s`} />
    </Section>
  );
}

function AnnotationProps({ id }: { id: string }) {
  const a = useP((p) => p.annotations.find((x) => x.id === id));
  if (!a) return null;
  const set = (label: string, f: (x: Annotation) => void, key?: string) => edit(label, (p) => { const it = p.annotations.find((x) => x.id === id); if (it) f(it as Annotation); }, key);
  return (
    <>
      <Section title={a.type === 'shape' ? a.shape : a.type}>
        {a.type === 'text' && (
          <>
            <textarea className="h-20 rounded-lg border border-line bg-panel-2 p-2 text-[13px] outline-none focus:border-accent" value={a.text} onChange={(e) => set('Edit text', (x) => { if (x.type === 'text') x.text = e.target.value; }, `txt-${id}`)} />
            <Select label="Style" value={a.style.preset} onChange={(v) => set('Text style', (x) => { if (x.type === 'text') x.style.preset = v; })} options={[{ value: 'basic', label: 'Basic' }, { value: 'shadow', label: 'Shadow' }, { value: 'outline', label: 'Outline' }, { value: 'gradient', label: 'Gradient' }, { value: 'pill', label: 'Pill label' }]} />
            <Select label="Font" value={a.style.font} onChange={(v) => set('Font', (x) => { if (x.type === 'text') x.style.font = v; })} options={FONT_CHOICES.map((f) => ({ value: f, label: f }))} />
            <Slider label="Size" value={a.style.size} min={12} max={240} step={1} onChange={(v) => set('Text size', (x) => { if (x.type === 'text') x.style.size = v; }, `ts-${id}`)} format={(v) => `${v}`} />
            <ColorPicker label="Color" value={a.style.color} onChange={(v) => set('Text color', (x) => { if (x.type === 'text') x.style.color = v; }, `tc-${id}`)} />
            {(a.style.preset === 'outline' || a.style.preset === 'gradient') && <ColorPicker label={a.style.preset === 'outline' ? 'Outline' : 'Gradient end'} value={a.style.color2 ?? '#000000'} onChange={(v) => set('Text color 2', (x) => { if (x.type === 'text') x.style.color2 = v; }, `tc2-${id}`)} />}
            {a.style.preset === 'pill' && <ColorPicker label="Label background" value={a.style.bg ?? '#7c5cff'} onChange={(v) => set('Label bg', (x) => { if (x.type === 'text') x.style.bg = v; }, `tbg-${id}`)} />}
            <div className="flex gap-2">
              <Toggle label="Bold" checked={a.style.bold} onChange={(v) => set('Bold', (x) => { if (x.type === 'text') x.style.bold = v; })} />
              <Toggle label="Italic" checked={a.style.italic} onChange={(v) => set('Italic', (x) => { if (x.type === 'text') x.style.italic = v; })} />
            </div>
            <Toggle label="Underline" checked={a.style.underline} onChange={(v) => set('Underline', (x) => { if (x.type === 'text') x.style.underline = v; })} />
            <Segmented size="sm" value={a.style.align} onChange={(v) => set('Align', (x) => { if (x.type === 'text') x.style.align = v; })} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} />
          </>
        )}
        {a.type === 'shape' && (
          <>
            <ColorPicker label="Color" value={a.style.color} onChange={(v) => set('Shape color', (x) => { if (x.type === 'shape') { x.style.color = v; if (x.shape === 'highlight') x.style.fill = v; } }, `sc-${id}`)} />
            <Slider label="Opacity" value={a.style.opacity} min={0.05} max={1} onChange={(v) => set('Opacity', (x) => { if (x.type === 'shape') x.style.opacity = v; }, `so-${id}`)} format={pct} />
            {a.shape !== 'highlight' && <Slider label="Stroke width" value={a.style.strokeWidth} min={1} max={30} step={1} onChange={(v) => set('Stroke', (x) => { if (x.type === 'shape') x.style.strokeWidth = v; }, `sw-${id}`)} format={(v) => `${v}`} />}
            {(a.shape === 'rect' || a.shape === 'highlight') && <Slider label="Corner radius" value={a.style.cornerRadius} min={0} max={80} step={1} onChange={(v) => set('Corner radius', (x) => { if (x.type === 'shape') x.style.cornerRadius = v; }, `cr-${id}`)} format={(v) => `${v}`} />}
            {(a.shape === 'rect' || a.shape === 'ellipse') && <Toggle label="Fill" checked={!!a.style.fill} onChange={(v) => set('Fill', (x) => { if (x.type === 'shape') x.style.fill = v ? `${x.style.color}55` : null; })} />}
            {a.shape === 'arrow' && (
              <>
                <Select label="Arrow head" value={a.style.head} onChange={(v) => set('Arrow head', (x) => { if (x.type === 'shape') x.style.head = v; })} options={[{ value: 'triangle', label: 'Triangle' }, { value: 'open', label: 'Open' }, { value: 'dot', label: 'Dot' }, { value: 'none', label: 'None' }]} />
                <Toggle label="Curved" checked={a.style.curved} onChange={(v) => set('Curved', (x) => { if (x.type === 'shape') x.style.curved = v; })} />
              </>
            )}
          </>
        )}
        {a.type === 'blur' && (
          <>
            <Slider label="Intensity" value={a.intensity} min={0} max={1} onChange={(v) => set('Blur intensity', (x) => { if (x.type === 'blur') x.intensity = v; }, `bi-${id}`)} format={pct} />
            <Segmented size="sm" value={a.softness > 0.5 ? 'ellipse' : 'rect'} onChange={(v) => set('Blur shape', (x) => { if (x.type === 'blur') x.softness = v === 'ellipse' ? 1 : 0; })} options={[{ value: 'rect', label: 'Rectangle' }, { value: 'ellipse', label: 'Ellipse' }]} />
            <Toggle label="Mosaic (pixelate)" checked={a.pixelate} onChange={(v) => set('Mosaic', (x) => { if (x.type === 'blur') x.pixelate = v; })} />
          </>
        )}
        {a.type === 'spotlight' && (
          <>
            <Segmented size="sm" value={a.softness > 0.5 ? 'ellipse' : 'rect'} onChange={(v) => set('Spotlight shape', (x) => { if (x.type === 'spotlight') x.softness = v === 'ellipse' ? 1 : 0; })} options={[{ value: 'rect', label: 'Rectangle' }, { value: 'ellipse', label: 'Ellipse' }]} />
            <Slider label="Mask opacity" value={a.opacity} min={0} max={1} onChange={(v) => set('Spotlight opacity', (x) => { if (x.type === 'spotlight') x.opacity = v; }, `spo-${id}`)} format={pct} />
            <Slider label="Feathering" value={a.feather} min={0} max={1} onChange={(v) => set('Feather', (x) => { if (x.type === 'spotlight') x.feather = v; }, `spf-${id}`)} format={pct} />
          </>
        )}
        {a.type === 'magnifier' && (
          <>
            <Slider label="Magnification" value={a.scale} min={1.2} max={5} step={0.1} onChange={(v) => set('Magnification', (x) => { if (x.type === 'magnifier') x.scale = v; }, `mg-${id}`)} format={(v) => `${v.toFixed(1)}×`} />
            <ColorPicker label="Border" value={a.border} onChange={(v) => set('Magnifier border', (x) => { if (x.type === 'magnifier') x.border = v; }, `mgb-${id}`)} />
          </>
        )}
        {a.type === 'callout' && (
          <>
            <Slider label="Zoom" value={a.scale} min={1} max={3} step={0.05} onChange={(v) => set('Callout zoom', (x) => { if (x.type === 'callout') x.scale = v; }, `cs-${id}`)} format={(v) => `${v.toFixed(2)}×`} />
            <Toggle label="Pop-out effect" checked={a.popout} onChange={(v) => set('Pop-out', (x) => { if (x.type === 'callout') x.popout = v; })} />
            <Toggle label="Marquee border" checked={a.marquee} onChange={(v) => set('Marquee', (x) => { if (x.type === 'callout') x.marquee = v; })} />
            <ColorPicker label="Border color" value={a.color} onChange={(v) => set('Callout color', (x) => { if (x.type === 'callout') x.color = v; }, `cc-${id}`)} />
            <Slider label="Roundness" value={a.roundness} min={0} max={1} onChange={(v) => set('Callout roundness', (x) => { if (x.type === 'callout') x.roundness = v; }, `cr2-${id}`)} format={pct} />
            <Slider label="Mask opacity" value={a.maskOpacity} min={0} max={1} onChange={(v) => set('Callout mask', (x) => { if (x.type === 'callout') x.maskOpacity = v; }, `cm-${id}`)} format={pct} />
          </>
        )}
      </Section>
      <Section title="Placement & animation">
        <Segmented size="sm" value={a.space} onChange={(v) => { if (v === a.space) return; const rect = convertAnchorRect(a.rect, v); set('Anchor', (x) => { x.space = v; x.rect = rect; }); }} options={[{ value: 'content', label: 'Stick to screen' }, { value: 'canvas', label: 'Fixed on canvas' }]} />
        <Slider label="Rotation" value={a.rotation} min={-180} max={180} step={1} onChange={(v) => set('Rotate', (x) => { x.rotation = v; }, `rot-${id}`)} format={(v) => `${v}°`} />
        <Select label="Animation in" value={a.anim.in} onChange={(v) => set('Animation in', (x) => { x.anim.in = v; })} options={['none', 'fade', 'scale', 'slide'].map((v) => ({ value: v as 'none', label: v }))} />
        <Select label="Animation out" value={a.anim.out} onChange={(v) => set('Animation out', (x) => { x.anim.out = v; })} options={['none', 'fade', 'scale', 'slide'].map((v) => ({ value: v as 'none', label: v }))} />
        <Slider label="Animation duration" value={a.anim.durSec} min={0.1} max={1} step={0.05} onChange={(v) => set('Anim duration', (x) => { x.anim.durSec = v; }, `ad-${id}`)} format={(v) => `${v.toFixed(2)} s`} />
        <Button size="sm" onClick={() => edit('Duplicate', (p) => { const it = p.annotations.find((x) => x.id === id); if (it) p.annotations.push({ ...cloneData(it), id: `${it.id}-c${Date.now().toString(36)}`, lane: it.lane + 1, rect: { ...it.rect, x: it.rect.x + 0.02, y: it.rect.y + 0.02 } }); })}>Duplicate</Button>
      </Section>
    </>
  );
}

function CaptionProps({ id }: { id: string }) {
  const b = useP((p) => p.captions?.blocks.find((x) => x.id === id));
  if (!b) return null;
  return (
    <Section title="Caption">
      <TextInput value={b.text} onChange={(e) => edit('Edit caption', (p) => { const it = p.captions?.blocks.find((x) => x.id === id); if (it) { it.text = e.target.value; delete it.words; } }, `cap-${id}`)} />
      <div className="text-xs text-muted">{formatTime(b.start)} → {formatTime(b.end)}</div>
    </Section>
  );
}

/**
 * Annotation rects are canvas-normalised ('canvas') or source-normalised ('content'). Converting at the
 * current frame keeps the item visually in place when its anchor changes.
 */
function convertAnchorRect(r: { x: number; y: number; w: number; h: number }, to: 'canvas' | 'content'): { x: number; y: number; w: number; h: number } {
  const s = useEditor.getState();
  const p = s.project, d = s.derived;
  if (!p || !d) return r;
  const W = 1000, H = Math.max(1, Math.round(W / canvasAspect(p.canvas, p.source.width, p.source.height)));
  const sc = evaluateScene(p, d, s.time, W, H, 60);
  if (to === 'canvas') {
    const a = sourceToCanvas(sc.stage, sc.viewport, sc.cam, { x: r.x, y: r.y });
    const b = sourceToCanvas(sc.stage, sc.viewport, sc.cam, { x: r.x + r.w, y: r.y + r.h });
    return { x: a.x / W, y: a.y / H, w: (b.x - a.x) / W, h: (b.y - a.y) / H };
  }
  const a = canvasToSource(sc.stage, sc.viewport, sc.cam, { x: r.x * W, y: r.y * H });
  const b = canvasToSource(sc.stage, sc.viewport, sc.cam, { x: (r.x + r.w) * W, y: (r.y + r.h) * H });
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}
