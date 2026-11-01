/**
 * Crop tool (task 3.7, EDT-06; CAM-05 camera crop): ratio presets or free; drag/resize on a still frame.
 * `target` picks what is cropped: the screen recording (canvas.crop) or the camera / avatar (camera.crop).
 */
import { useEffect, useRef, useState } from 'react';
import { outToSrc } from '@rec/shared';
import { Button, Modal, Segmented } from '../ui';
import { mediaUrl } from './media';
import { useEditor } from './store';

type R = { x: number; y: number; w: number; h: number };
const RATIOS: Record<string, number | null> = { free: null, '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16 };

export type CropTarget = 'screen' | 'camera';

export function CropModal({ onClose, target = 'screen' }: { onClose: () => void; target?: CropTarget }) {
  const project = useEditor((s) => s.project)!;
  const opened = useEditor((s) => s.opened)!;
  const time = useEditor((s) => s.time);
  const current = target === 'camera' ? project.camera.crop : project.canvas.crop;
  const [r, setR] = useState<R>(current ?? { x: 0, y: 0, w: 1, h: 1 });
  const [ratio, setRatio] = useState('free');
  // the camera's size is only known once its file loads
  const [srcAspect, setSrcAspect] = useState(target === 'camera' ? 16 / 9 : project.source.width / project.source.height);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: string; x0: number; y0: number; r: R } | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const v = document.createElement('video');
    v.muted = true;
    const src = outToSrc(project.clips, time).src;
    const file = target === 'camera'
      ? project.camera.avatar?.videoFile ?? project.source.tracks.camera ?? ''
      : project.source.tracks.screen ?? project.source.segments[0]?.file ?? '';
    v.src = mediaUrl(opened.mediaBase, file);
    v.addEventListener('loadedmetadata', () => { if (v.videoWidth && v.videoHeight) setSrcAspect(v.videoWidth / v.videoHeight); });
    v.addEventListener('loadeddata', () => {
      const offset = target === 'camera' && !project.camera.avatar ? project.source.trackOffsets.camera ?? 0 : 0;
      v.currentTime = Math.max(0, Math.min(src - offset, (v.duration || Infinity) - 0.05));
    });
    v.addEventListener('seeked', () => { const c = canvas.current; c?.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height); });
    return () => { v.removeAttribute('src'); v.load(); };
  }, []);

  const applyRatio = (key: string) => {
    setRatio(key);
    const k = RATIOS[key];
    if (!k) return;
    // largest centred rect with the target aspect (in source pixels)
    let w = 1, h = (1 * srcAspect) / k;
    if (h > 1) { h = 1; w = k / srcAspect; }
    setR({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      const b = box.current?.getBoundingClientRect();
      if (!d || !b) return;
      const dx = (e.clientX - d.x0) / b.width, dy = (e.clientY - d.y0) / b.height;
      const n = { ...d.r };
      if (d.mode === 'move') { n.x = Math.min(1 - n.w, Math.max(0, d.r.x + dx)); n.y = Math.min(1 - n.h, Math.max(0, d.r.y + dy)); }
      else {
        if (d.mode.includes('e')) n.w = Math.min(1 - n.x, Math.max(0.05, d.r.w + dx));
        if (d.mode.includes('s')) n.h = Math.min(1 - n.y, Math.max(0.05, d.r.h + dy));
        if (d.mode.includes('w')) { const nx = Math.max(0, Math.min(d.r.x + d.r.w - 0.05, d.r.x + dx)); n.w = d.r.w + (d.r.x - nx); n.x = nx; }
        if (d.mode.includes('n')) { const ny = Math.max(0, Math.min(d.r.y + d.r.h - 0.05, d.r.y + dy)); n.h = d.r.h + (d.r.y - ny); n.y = ny; }
        const k = RATIOS[ratio];
        if (k) n.h = Math.min(1 - n.y, (n.w * srcAspect) / k);
      }
      setR(n);
    };
    const up = () => (drag.current = null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [ratio, srcAspect]);

  const start = (mode: string) => (e: React.PointerEvent) => { e.stopPropagation(); drag.current = { mode, x0: e.clientX, y0: e.clientY, r }; };
  // fit the frame inside the window (portrait phone sources used to overflow it)
  const W = Math.round(Math.max(240, Math.min(720, view.w - 120, (view.h - 280) * srcAspect)));
  const H = Math.round(W / srcAspect);
  const label = target === 'camera' ? 'camera' : 'recording';
  const pxW = target === 'camera' ? null : Math.round(r.w * project.source.width);
  const pxH = target === 'camera' ? null : Math.round(r.h * project.source.height);
  return (
    <Modal open onClose={onClose} title={target === 'camera' ? 'Crop camera' : 'Crop'} width={W + 48} footer={<>
      <Button onClick={() => { useEditor.getState().edit(`Remove ${label} crop`, (p) => { if (target === 'camera') delete p.camera.crop; else delete p.canvas.crop; }); onClose(); }}>Reset</Button>
      <Button variant="primary" onClick={() => {
        const crop = r.w > 0.999 && r.h > 0.999 ? undefined : r;
        useEditor.getState().edit(target === 'camera' ? 'Crop camera' : 'Crop', (p) => {
          if (target === 'camera') { if (crop) p.camera.crop = crop; else delete p.camera.crop; }
          else if (crop) p.canvas.crop = crop; else delete p.canvas.crop;
        });
        onClose();
      }}>Apply</Button>
    </>}>
      <Segmented value={ratio} onChange={applyRatio} options={Object.keys(RATIOS).map((k) => ({ value: k, label: k === 'free' ? 'Free' : k }))} className="mb-3" />
      <div ref={box} className="relative select-none overflow-hidden rounded-lg bg-black" style={{ width: W, height: H }}>
        <canvas ref={canvas} width={W} height={H} className="absolute inset-0" />
        <div className="absolute inset-0 bg-black/55" style={{ clipPath: `polygon(0 0,100% 0,100% 100%,0 100%,0 0,${r.x * 100}% ${r.y * 100}%,${r.x * 100}% ${(r.y + r.h) * 100}%,${(r.x + r.w) * 100}% ${(r.y + r.h) * 100}%,${(r.x + r.w) * 100}% ${r.y * 100}%,${r.x * 100}% ${r.y * 100}%)` }} />
        <div className="absolute cursor-move border-2 border-white" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} onPointerDown={start('move')}>
          {['nw', 'ne', 'sw', 'se'].map((h) => (
            <div key={h} onPointerDown={start(h)} className="absolute h-3 w-3 bg-white" style={{ cursor: `${h}-resize`, left: h.includes('w') ? -6 : undefined, right: h.includes('e') ? -6 : undefined, top: h.includes('n') ? -6 : undefined, bottom: h.includes('s') ? -6 : undefined }} />
          ))}
        </div>
      </div>
      <div className="mt-2 text-xs text-muted">{pxW !== null ? `${pxW} × ${pxH} px` : `${Math.round(r.w * 100)}% × ${Math.round(r.h * 100)}% of the camera`}</div>
    </Modal>
  );
}
