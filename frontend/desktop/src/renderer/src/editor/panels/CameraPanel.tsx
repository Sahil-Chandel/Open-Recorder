/**
 * Camera panel (task 7.8, CAM-01…10): show/hide, layout presets by orientation, Adjust Layout (custom),
 * Add Layout at playhead, size, roundness, border, frames, mirror/flip, filters, shrink on zoom,
 * background (original/remove/blur/image/color) with a pre-pass, beauty filter, AI avatar entry.
 */
import { ImagePlus, Plus, UserRound } from 'lucide-react';
import { useState } from 'react';
import { canvasAspect, orientationOf, outToSrc, presetsFor, uid } from '@rec/shared';
import { api, errMsg } from '../../lib/api';
import { CAMERA_FILTERS, CAMERA_FRAMES, renderVirtualScene, VIRTUAL_SCENES } from '../../compositor/assets';
import { Button, ColorPicker, Section, Segmented, Slider, toast, Toggle } from '../../ui';
import { runBackgroundRemoval } from '../segmentation';
import { useEditor } from '../store';
import { edit, Swatch, useP } from './common';

export function CameraPanel() {
  const cam = useP((p) => p.camera);
  const canvas = useP((p) => p.canvas);
  const source = useP((p) => p.source);
  const dir = useEditor((s) => s.dir);
  const hasCamera = Boolean(source.tracks.camera || cam.avatar || cam.facecam);
  const set = (label: string, f: (x: typeof cam) => void, key?: string) => edit(label, (p) => f(p.camera), key);
  if (!hasCamera) {
    return (
      <Section title="Camera">
        <div className="text-xs text-muted">This recording has no camera track. Turn on the camera in the recorder, or add a face-cam video you recorded separately.</div>
        <Button onClick={async () => {
          try {
            const r = await api.invoke<{ file: string } | null>('projects:importAsset', dir, 'facecam');
            if (r) set('Use face-cam video', (x) => { x.facecam = { file: r.file, offsetSec: 0 }; x.visible = true; });
          } catch (e) { toast(errMsg(e), 'error'); }
        }}><UserRound size={14} />Add a face-cam video…</Button>
      </Section>
    );
  }
  const orientation = orientationOf(canvasAspect(canvas, source.width, source.height));
  const presets = presetsFor(orientation);
  const adjust = () => window.dispatchEvent(new CustomEvent('editor:adjustLayout'));
  return (
    <>
      <Section title="Camera">
        <Toggle label="Show camera" checked={cam.visible} onChange={(v) => set('Show camera', (x) => { x.visible = v; })} />
        <div className="grid grid-cols-3 gap-1.5">
          {presets.map((l) => (
            <button key={l.id} title={l.name} onClick={() => set('Camera layout', (x) => { x.layoutId = l.id; })}
              className={`relative overflow-hidden rounded-lg border bg-panel-2 ${orientation === 'portrait' ? 'aspect-[9/16]' : 'aspect-video'} ${cam.layoutId === l.id ? 'border-accent ring-1 ring-accent' : 'border-line'}`}>
              <div className="absolute bg-[#4b4b63]" style={{ left: `${l.def.screen.x * 100}%`, top: `${l.def.screen.y * 100}%`, width: `${l.def.screen.w * 100}%`, height: `${l.def.screen.h * 100}%`, zIndex: l.def.cameraBehindScreen ? 2 : 1 }} />
              {l.def.camera && <div className="absolute bg-accent/80" style={{ left: `${l.def.camera.x * 100}%`, top: `${l.def.camera.y * 100}%`, width: `${l.def.camera.w * 100}%`, height: `${l.def.camera.h * 100}%`, borderRadius: l.def.camera.w < 0.5 ? '50%' : 2, zIndex: l.def.cameraBehindScreen ? 1 : 2 }} />}
            </button>
          ))}
        </div>
        {cam.layoutId === 'custom' && (
          <div className="flex items-center justify-between rounded-lg bg-accent/10 px-2 py-1.5 text-xs">Currently using a custom layout
            <button className="text-accent-2" onClick={() => set('Default layout', (x) => { x.layoutId = presets[0]!.id; })}>Back to default</button>
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={adjust}>Adjust layout</Button>
          <Button size="sm" onClick={() => {
            const s = useEditor.getState();
            const src = outToSrc(s.project!.clips, s.time).src;
            const id = uid('lay');
            s.edit('Add layout', (p) => { p.layouts.push({ id, start: src, end: Math.min(p.source.durationSec, src + 4), layoutId: presets.find((x) => x.id.includes('camera-full'))?.id ?? presets[0]!.id, transitionSec: 0.4 }); });
            s.select('layout', id);
          }}><Plus size={13} />Add layout</Button>
        </div>
      </Section>
      <Section title="Style">
        <Slider label="Size" value={cam.size} min={0.5} max={2} onChange={(v) => set('Camera size', (x) => { x.size = v; }, 'camsize')} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Roundness" value={cam.roundness} min={0} max={1} onChange={(v) => set('Camera roundness', (x) => { x.roundness = v; }, 'camround')} format={(v) => (v >= 0.99 ? 'Circle' : `${Math.round(v * 100)}%`)} />
        <div className="grid grid-cols-5 gap-1">
          {CAMERA_FRAMES.map((f) => (
            <button key={f.id} title={f.name} onClick={() => set('Camera frame', (x) => { x.frameId = f.id; x.border = { color: f.color, width: f.width }; })}
              className={`h-8 rounded-md border text-[10px] ${cam.frameId === f.id ? 'border-accent' : 'border-line'}`} style={{ boxShadow: f.width ? `inset 0 0 0 ${Math.min(4, f.width / 2)}px ${f.color}` : undefined }}>{f.width ? '' : 'None'}</button>
          ))}
        </div>
        <ColorPicker label="Border color" value={cam.border.color} onChange={(v) => set('Border color', (x) => { x.border.color = v; }, 'camborder')} />
        <Slider label="Border width" value={cam.border.width} min={0} max={16} step={1} onChange={(v) => set('Border width', (x) => { x.border.width = v; }, 'cambw')} format={(v) => `${v}px`} />
        <Toggle label="Mirror (left ↔ right)" checked={cam.mirror !== cam.flipH} onChange={(v) => set('Mirror', (x) => { x.mirror = v; x.flipH = false; })} />
        <Toggle label="Flip upside down" hint="For cameras mounted upside down" checked={cam.flipV} onChange={(v) => set('Flip', (x) => { x.flipV = v; })} />
        <Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent('editor:crop', { detail: 'camera' }))}>Crop camera{cam.crop ? ' (on)' : ''}</Button>
      </Section>
      <Section title="Face-cam video">
        <div className="text-[11px] text-muted">Recorded yourself with a phone or a better camera? Use that video instead of the webcam.</div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={async () => {
            try {
              const r = await api.invoke<{ file: string } | null>('projects:importAsset', dir, 'facecam');
              if (r) set('Use face-cam video', (x) => { x.facecam = { file: r.file, offsetSec: 0 }; x.visible = true; });
            } catch (e) { toast(errMsg(e), 'error'); }
          }}>{cam.facecam ? 'Replace face-cam video…' : 'Use a separate video…'}</Button>
          {cam.facecam && <Button size="sm" variant="ghost" onClick={() => set('Use webcam', (x) => { delete x.facecam; })}>Back to webcam</Button>}
        </div>
        {cam.facecam && <Slider label="Sync offset (starts later →)" value={cam.facecam.offsetSec} min={-10} max={10} step={0.02} onChange={(v) => set('Face-cam offset', (x) => { if (x.facecam) x.facecam.offsetSec = v; }, 'facecam-off')} format={(v) => `${v.toFixed(2)} s`} />}
        <Toggle label="Shrink while zoomed in" checked={cam.shrinkOnZoom} onChange={(v) => set('Shrink on zoom', (x) => { x.shrinkOnZoom = v; })} />
      </Section>
      <Section title="Filter">
        <div className="grid grid-cols-3 gap-1">
          {CAMERA_FILTERS.map((f) => (
            <button key={f.id} onClick={() => set('Camera filter', (x) => { x.filterId = f.id === 'none' ? undefined : f.id; })}
              className={`rounded-md border py-1.5 text-[11px] ${(cam.filterId ?? 'none') === f.id ? 'border-accent bg-accent/15' : 'border-line'}`}>{f.name}</button>
          ))}
        </div>
      </Section>
      <Section title="Background">
        <Segmented size="sm" value={cam.background.mode} onChange={async (v) => {
          set('Camera background', (x) => { x.background = { ...x.background, mode: v }; });
          if (v !== 'original') {
            try { await runBackgroundRemoval(); } catch (e) { toast(errMsg(e), 'error'); }
          }
        }} options={[{ value: 'original', label: 'Original' }, { value: 'remove', label: 'Remove' }, { value: 'blur', label: 'Blur' }, { value: 'image', label: 'Image' }, { value: 'color', label: 'Color' }]} />
        {cam.background.mode === 'blur' && <Slider label="Blur strength" value={cam.background.blur ?? 0.5} min={0} max={1} onChange={(v) => set('Background blur', (x) => { x.background.blur = v; }, 'cambgblur')} format={(v) => `${Math.round(v * 100)}%`} />}
        {cam.background.mode === 'color' && <ColorPicker value={cam.background.value ?? '#00b140'} onChange={(v) => set('Background color', (x) => { x.background.value = v; }, 'cambgc')} />}
        {cam.background.mode === 'image' && (
          <div className="flex flex-col gap-2">
            <Button size="sm" onClick={async () => { try { const r = await api.invoke<{ file: string } | null>('projects:importAsset', dir, 'camera-bg'); if (r) set('Background image', (x) => { x.background.value = r.file; }); } catch (e) { toast(errMsg(e), 'error'); } }}><ImagePlus size={13} />Upload image…</Button>
            <div className="text-[11px] text-muted">Virtual scenes</div>
            <div className="grid grid-cols-3 gap-1.5">
              {VIRTUAL_SCENES.map((sc) => {
                const file = `cache/scene-${sc.id}.png`;
                return (
                  <Swatch key={sc.id} title={sc.name} active={cam.background.value === file}
                    style={{ background: `linear-gradient(135deg, ${sc.colors[0]}, ${sc.colors[1]}, ${sc.colors[2]})` }}
                    onClick={async () => {
                      try {
                        await api.invoke('projects:writeCache', dir, `scene-${sc.id}.png`, await renderVirtualScene(sc.colors));
                        set('Virtual scene', (x) => { x.background.value = file; });
                      } catch (e) { toast(errMsg(e), 'error'); }
                    }}>
                    <span className="absolute bottom-0.5 left-1 text-[10px] text-white drop-shadow">{sc.name}</span>
                  </Swatch>
                );
              })}
            </div>
          </div>
        )}
      </Section>
      <Section title="Beauty">
        <Toggle label="Beauty filter" hint="Skin smoothing + brightening, real-time" checked={cam.beauty.enabled} onChange={(v) => set('Beauty', (x) => { x.beauty.enabled = v; })} />
        {cam.beauty.enabled && <Slider label="Intensity" value={cam.beauty.intensity} min={0} max={1} onChange={(v) => set('Beauty intensity', (x) => { x.beauty.intensity = v; }, 'beauty')} format={(v) => `${Math.round(v * 100)}%`} />}
      </Section>
      {cam.avatar && (
        <Section title="AI avatar">
          <div className="text-[11px] text-muted">This project uses an AI avatar made with an earlier version.</div>
          <Button size="sm" variant="ghost" onClick={() => set('Remove avatar', (x) => { delete x.avatar; })}>Back to my camera</Button>
        </Section>
      )}
    </>
  );
}
