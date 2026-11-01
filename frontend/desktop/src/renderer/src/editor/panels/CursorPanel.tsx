/**
 * Cursor panel (task 6.9, CUR-01…08): show, size, 40 styles, color, angle, dynamic direction, click effect
 * (8) + color, click sound (on/off, sound, volume), smart optimisation (hide when idle, smooth path),
 * end-of-video behaviour.
 */
import { useMemo } from 'react';
import { CLICK_SOUNDS, synthClick } from '../../audio/clickSounds';
import { CLICK_EFFECTS, CURSOR_STYLES, cursorSvg } from '../../compositor/assets';
import { Button, ColorPicker, Section, Segmented, Select, Slider, toast, Toggle } from '../../ui';
import { api, errMsg } from '../../lib/api';
import { useEditor } from '../store';
import { edit, useP } from './common';

function playSample(id: string, volume: number): void {
  const ctx = new AudioContext();
  const s = ctx.createBufferSource();
  const g = ctx.createGain();
  g.gain.value = volume;
  s.buffer = synthClick(ctx, id);
  s.connect(g).connect(ctx.destination);
  s.start();
  s.onended = () => void ctx.close();
}

export function CursorPanel() {
  const c = useP((p) => p.cursor);
  const hasTelemetry = useP((p) => p.source.hasTelemetry);
  const thumbs = useMemo(() => CURSOR_STYLES.map((s) => ({ id: s.id, name: s.name, url: `data:image/svg+xml;utf8,${encodeURIComponent(cursorSvg(s, 'arrow').svg)}` })), []);
  const set = (label: string, f: (x: typeof c) => void, key?: string) => edit(label, (p) => f(p.cursor), key);
  if (!hasTelemetry) return <Section title="Cursor"><div className="text-xs text-muted">This recording has no cursor data (imported video or mobile device), so cursor effects are unavailable.</div></Section>;
  return (
    <>
      <Section title="Cursor">
        <Toggle label="Show cursor" checked={c.show} onChange={(v) => set('Show cursor', (x) => { x.show = v; })} />
        <Slider label="Size" value={c.size} min={0.5} max={4} onChange={(v) => set('Cursor size', (x) => { x.size = v; }, 'csize')} format={(v) => `${v.toFixed(1)}×`} />
        <div className="grid max-h-48 grid-cols-6 gap-1 overflow-auto rounded-lg bg-panel-2 p-1.5">
          {thumbs.map((t) => (
            <button key={t.id} title={t.name} aria-label={t.name} onClick={() => set('Cursor style', (x) => { x.styleId = t.id; })}
              className={`flex h-10 items-center justify-center rounded-md ${c.styleId === t.id ? 'bg-accent/30 ring-1 ring-accent' : 'hover:bg-line'}`}>
              <img src={t.url} alt="" className="h-7 w-7" />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={async () => {
            try {
              const dir = useEditor.getState().dir;
              const r = await api.invoke<{ file: string; url: string } | null>('projects:importAsset', dir, 'watermark');
              if (!r) return;
              const img = await createImageBitmap(await (await fetch(r.url)).blob());
              edit('Import cursor', (p) => { p.cursor.custom = { file: r.file, hotspot: [0, 0], size: Math.min(64, Math.max(img.width, img.height)) }; });
            } catch (e) { toast(`Couldn't use that image as a cursor: ${errMsg(e)}`, 'error'); }
          }}>Import cursor image…</Button>
          {c.custom && <Button size="sm" variant="ghost" onClick={() => edit('Remove imported cursor', (p) => { delete p.cursor.custom; })}>Use styles</Button>}
        </div>
        {c.custom && (
          <div className="grid grid-cols-2 gap-2">
            <Slider label="Hotspot X" value={c.custom.hotspot[0]} min={0} max={c.custom.size} step={1} onChange={(v) => set('Cursor hotspot', (x) => { x.custom!.hotspot = [v, x.custom!.hotspot[1]]; }, 'hx')} format={(v) => `${v}px`} />
            <Slider label="Hotspot Y" value={c.custom.hotspot[1]} min={0} max={c.custom.size} step={1} onChange={(v) => set('Cursor hotspot', (x) => { x.custom!.hotspot = [x.custom!.hotspot[0], v]; }, 'hy')} format={(v) => `${v}px`} />
          </div>
        )}
        <Toggle label="Custom color" checked={!!c.color} onChange={(v) => set('Cursor color', (x) => { x.color = v ? '#7c5cff' : undefined; })} />
        {c.color && <ColorPicker value={c.color} onChange={(v) => set('Cursor color', (x) => { x.color = v; }, 'ccolor')} />}
        <Slider label="Angle" value={c.angle} min={-45} max={45} step={1} onChange={(v) => set('Cursor angle', (x) => { x.angle = v; }, 'cangle')} format={(v) => `${v}°`} />
        <Toggle label="Dynamic direction" hint="Tilts with movement" checked={c.dynamicDirection} onChange={(v) => set('Dynamic direction', (x) => { x.dynamicDirection = v; })} />
      </Section>
      <Section title="Click effect">
        <div className="grid grid-cols-3 gap-1">
          <button onClick={() => set('Click effect', (x) => { x.clickEffect.id = null; })} className={`rounded-lg border py-1.5 text-[11px] ${c.clickEffect.id === null ? 'border-accent bg-accent/15' : 'border-line'}`}>None</button>
          {CLICK_EFFECTS.map((e) => (
            <button key={e.id} onClick={() => set('Click effect', (x) => { x.clickEffect.id = e.id; })} className={`rounded-lg border py-1.5 text-[11px] ${c.clickEffect.id === e.id ? 'border-accent bg-accent/15' : 'border-line'}`}>{e.name}</button>
          ))}
        </div>
        <ColorPicker label="Effect color" value={c.clickEffect.color} onChange={(v) => set('Click color', (x) => { x.clickEffect.color = v; }, 'clickcolor')} />
      </Section>
      <Section title="Click sound">
        <Toggle label="Play click sound" checked={c.clickSound.enabled} onChange={(v) => set('Click sound', (x) => { x.clickSound.enabled = v; })} />
        {c.clickSound.enabled && (
          <>
            <Select value={c.clickSound.soundId} onChange={(v) => { set('Click sound', (x) => { x.clickSound.soundId = v; }); playSample(v, c.clickSound.volume); }} options={CLICK_SOUNDS.map((s) => ({ value: s.id, label: s.name }))} />
            <Slider label="Volume" value={c.clickSound.volume} min={0} max={1} onChange={(v) => set('Click volume', (x) => { x.clickSound.volume = v; }, 'clickvol')} format={(v) => `${Math.round(v * 100)}%`} onCommit={() => playSample(c.clickSound.soundId, c.clickSound.volume)} />
          </>
        )}
      </Section>
      <Section title="Smart optimisation">
        <Toggle label="Hide cursor when idle" checked={c.hideWhenIdle.enabled} onChange={(v) => set('Hide when idle', (x) => { x.hideWhenIdle.enabled = v; })} />
        {c.hideWhenIdle.enabled && (
          <>
            <Slider label="Idle time" value={c.hideWhenIdle.afterSec} min={0.5} max={5} step={0.1} onChange={(v) => set('Idle time', (x) => { x.hideWhenIdle.afterSec = v; }, 'idle')} format={(v) => `${v.toFixed(1)} s`} />
            <Segmented size="sm" value={c.hideWhenIdle.animation} onChange={(v) => set('Idle animation', (x) => { x.hideWhenIdle.animation = v; })} options={[{ value: 'fade', label: 'Fade' }, { value: 'scale', label: 'Scale' }, { value: 'none', label: 'None' }]} />
          </>
        )}
        <Toggle label="Smooth cursor path" checked={c.smoothPath.enabled} onChange={(v) => set('Smooth path', (x) => { x.smoothPath.enabled = v; })} />
        {c.smoothPath.enabled && <Slider label="Smoothing" value={c.smoothPath.level} min={0} max={100} step={1} onChange={(v) => set('Smoothing', (x) => { x.smoothPath.level = v; }, 'smooth')} format={(v) => `${v}`} />}
      </Section>
      <Section title="End of video">
        <Segmented size="sm" value={c.endBehavior.mode} onChange={(v) => set('End position', (x) => { x.endBehavior.mode = v; })} options={[{ value: 'stay', label: 'Keep in place' }, { value: 'returnToStart', label: 'Return to start' }]} />
        {c.endBehavior.mode === 'returnToStart' && <Slider label="Animation duration" value={c.endBehavior.durationSec} min={0.2} max={3} step={0.1} onChange={(v) => set('End duration', (x) => { x.endBehavior.durationSec = v; }, 'enddur')} format={(v) => `${v.toFixed(1)} s`} />}
      </Section>
    </>
  );
}
