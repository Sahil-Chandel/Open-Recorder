/**
 * Player (task 3.4): master clock = performance.now() anchored at play; every frame → evaluateScene(t) →
 * compositor. Media elements follow the clock (seek on drift). Preview resolution capped at 1080p.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { evaluateScene, outToSrc, outputSize, type Project, type SceneState } from '@rec/shared';
import { PreviewAudio } from '../audio/engine';
import { Compositor } from '../compositor/Compositor';
import { drawOverlay } from '../compositor/overlay';
import { cameraMaskProvider } from './cameraMask';
import { cameraOffsetSec, cameraSourceRel, createPreviewMedia, mediaUrl, syncElement, type PreviewMedia } from './media';
import { attachCachedMask } from './segmentation';
import { ensureFonts } from '../fonts';
import { useEditor } from './store';

export interface PlayerGeometry {
  comp: Compositor;
  scene: SceneState;
  /** css px of the canvas element inside the player container */
  box: { left: number; top: number; width: number; height: number };
}

const imageCache = new Map<string, Promise<ImageBitmap | null>>();
export function loadImage(url: string): Promise<ImageBitmap | null> {
  if (!imageCache.has(url)) {
    imageCache.set(url, fetch(url).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? createImageBitmap(b) : null)).catch(() => null));
  }
  return imageCache.get(url)!;
}

export function Player({ children }: { children?: (g: PlayerGeometry) => ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compRef = useRef<Compositor | null>(null);
  const mediaRef = useRef<PreviewMedia | null>(null);
  const audioRef = useRef<PreviewAudio | null>(null);
  const overlayRef = useRef<OffscreenCanvas | null>(null);
  const imgs = useRef<{ watermark: ImageBitmap | null; bg: ImageBitmap | null; camBg: ImageBitmap | null }>({ watermark: null, bg: null, camBg: null });
  const bgVideo = useRef<HTMLVideoElement | null>(null);
  const clock = useRef<{ t0: number; wall0: number } | null>(null);
  const dirtyRef = useRef(true);
  // low-end preview mode (task 14.5): 540p cap; 'auto' drops to 540p on weak GPUs / low memory
  const previewCap = useRef(1080);
  useEffect(() => {
    void window.api.invoke<{ general: { previewQuality: string } }>('settings:get').then((s) => {
      const lowMem = ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
      previewCap.current = s.general.previewQuality === 'low' || (s.general.previewQuality === 'auto' && lowMem) ? 540 : 1080;
    });
  }, []);
  const [geom, setGeom] = useState<PlayerGeometry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opened = useEditor((s) => s.opened);
  const project = useEditor((s) => s.project);
  const derived = useEditor((s) => s.derived);
  const playing = useEditor((s) => s.playing);

  // compositor + media lifecycle
  useEffect(() => {
    if (!opened || !canvasRef.current) return;
    try {
      compRef.current = new Compositor(canvasRef.current);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const p = useEditor.getState().project!;
    mediaRef.current = createPreviewMedia(p, opened.mediaBase);
    audioRef.current = new PreviewAudio(p, opened.mediaBase, p.audio.mic.denoise);
    for (const c of opened.cursorBitmaps) void compRef.current.loadCustomCursor(c.id, c.url, c.hotspot);
    void compRef.current.prepareCursors(p.cursor.styleId, p.cursor.color).then(() => (dirtyRef.current = true));
    void ensureFonts().then(() => (dirtyRef.current = true)); // redraw text once bundled fonts are ready
    const onFrame = () => (dirtyRef.current = true);
    mediaRef.current.screen.addEventListener('seeked', onFrame);
    mediaRef.current.screen.addEventListener('loadeddata', onFrame);
    mediaRef.current.camera?.addEventListener('loadeddata', onFrame);
    return () => {
      mediaRef.current?.dispose();
      audioRef.current?.dispose();
      compRef.current?.dispose();
      mediaRef.current = null;
      audioRef.current = null;
      compRef.current = null;
    };
  }, [opened]);

  // keep audio graph + images in sync with the project
  useEffect(() => {
    if (!project || !opened) return;
    audioRef.current?.rebuild(project, project.audio.mic.denoise);
    dirtyRef.current = true;
    const base = opened.mediaBase;
    // a missing imported cursor file (e.g. from a preset made in another project) falls back to the style cursors
    void compRef.current?.setImportedCursor(project.cursor.custom ? mediaUrl(base, project.cursor.custom.file) : null, project.cursor.custom?.hotspot)
      .then(() => (dirtyRef.current = true))
      .catch(() => void compRef.current?.setImportedCursor(null));
    if (project.watermark?.file) void loadImage(mediaUrl(base, project.watermark.file)).then((b) => { imgs.current.watermark = b; dirtyRef.current = true; });
    else imgs.current.watermark = null;
    // video background: (re)create the looping element when the file changes
    const bgv = project.canvas.background.type === 'video' ? mediaUrl(base, project.canvas.background.value) : null;
    if (bgVideo.current && bgVideo.current.dataset.src !== bgv) { bgVideo.current.removeAttribute('src'); bgVideo.current.load(); bgVideo.current = null; }
    if (bgv && !bgVideo.current) {
      const v = document.createElement('video');
      Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
      v.dataset.src = bgv;
      v.src = bgv;
      v.addEventListener('loadeddata', () => (dirtyRef.current = true));
      bgVideo.current = v;
    }
    if (project.canvas.background.type === 'image') void loadImage(project.canvas.background.value.startsWith('rec-media:') ? project.canvas.background.value : mediaUrl(base, project.canvas.background.value)).then((b) => { imgs.current.bg = b; dirtyRef.current = true; });
    if (project.camera.background.mode === 'image' && project.camera.background.value) void loadImage(mediaUrl(base, project.camera.background.value)).then((b) => { imgs.current.camBg = b; dirtyRef.current = true; });
    void compRef.current?.prepareCursors(project.cursor.styleId, project.cursor.color).then(() => (dirtyRef.current = true));
  }, [project, opened]);

  useEffect(() => {
    dirtyRef.current = true;
  }, [derived]);

  // applying / removing an AI avatar swaps the camera-slot media and its background mask
  const camRel = project ? cameraSourceRel(project) : null;
  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !opened) return;
    media.setCamera(camRel ? mediaUrl(opened.mediaBase, camRel) : null);
    media.camera?.addEventListener('loadeddata', () => (dirtyRef.current = true));
    void attachCachedMask();
    dirtyRef.current = true;
  }, [camRel, opened]);

  // play/pause anchors the clock
  useEffect(() => {
    if (playing) {
      const s = useEditor.getState();
      const start = s.time >= (s.derived?.duration ?? 0) - 0.05 ? 0 : s.time;
      clock.current = { t0: start, wall0: performance.now() };
    } else {
      clock.current = null;
      audioRef.current?.pauseAll();
      mediaRef.current?.screen.pause();
      mediaRef.current?.camera?.pause();
    }
  }, [playing]);

  // render loop
  useEffect(() => {
    let raf = 0;
    let lastT = -1;
    let lastSize = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const comp = compRef.current;
      const media = mediaRef.current;
      const st = useEditor.getState();
      const p = st.project;
      const d = st.derived;
      const container = containerRef.current;
      if (!comp || !media || !p || !d || !container) return;
      // size: fit canvas aspect into the container
      const cw = container.clientWidth, ch = container.clientHeight;
      const aspect = d.canvasAspect;
      let w = cw, h = cw / aspect;
      if (h > ch) { h = ch; w = ch * aspect; }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cap = outputSize(aspect, previewCap.current);
      const pxW = Math.min(Math.round(w * dpr), cap.width), pxH = Math.min(Math.round(h * dpr), cap.height);
      const sizeKey = `${pxW}x${pxH}|${Math.round(w)}x${Math.round(h)}`;
      if (sizeKey !== lastSize) {
        lastSize = sizeKey;
        comp.resize(pxW, pxH);
        overlayRef.current = new OffscreenCanvas(pxW, pxH);
        const c = canvasRef.current!;
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
        dirtyRef.current = true;
      }
      // clock
      let t = st.time;
      if (st.playing && clock.current) {
        t = clock.current.t0 + (performance.now() - clock.current.wall0) / 1000;
        const loopR = st.loop;
        if (loopR && t >= loopR.end) {
          clock.current = { t0: loopR.start, wall0: performance.now() };
          t = loopR.start;
        }
        if (t >= d.duration) {
          t = d.duration;
          st.setPlaying(false);
        }
        st.setTime(t);
      }
      // media sync
      const { src, clip } = outToSrc(p.clips, t);
      syncElement(media.screen, src, st.playing, clip.speed);
      const camOff = cameraOffsetSec(p);
      const bgv = bgVideo.current;
      if (bgv && Number.isFinite(bgv.duration) && bgv.duration > 0) {
        syncElement(bgv, t % bgv.duration, st.playing, 1);
        if (st.playing) dirtyRef.current = true;
      }
      if (media.camera) syncElement(media.camera, src - camOff, st.playing, clip.speed);
      audioRef.current?.tick(t, st.playing, st.telemetry);
      if (!st.playing && t === lastT && !dirtyRef.current) return;
      lastT = t;
      dirtyRef.current = st.playing;
      const scene = evaluateScene(p, d, t, comp.width, comp.height, 60);
      const overlay = overlayRef.current!;
      const octx = overlay.getContext('2d')!;
      const drew = drawOverlay(octx, p, scene, comp, { watermark: imgs.current.watermark });
      const camEl = media.camera;
      const camReady = camEl && camEl.readyState >= 2;
      comp.render(p, scene, {
        screen: media.screen.readyState >= 2 ? media.screen : null,
        camera: camReady ? camEl : null,
        ...(camReady ? { cameraSize: { w: camEl!.videoWidth, h: camEl!.videoHeight } } : {}),
        cameraMask: camReady && p.camera.background.mode !== 'original' ? cameraMaskProvider.maskFor(camEl!, src - camOff) : null,
        bgImage: bgVideo.current ? (bgVideo.current.readyState >= 2 ? bgVideo.current : null) : imgs.current.bg,
        cameraBgImage: imgs.current.camBg,
        overlay: drew ? overlay : null,
      }, { quality: 'preview', fps: 60 });
      const cr = canvasRef.current!.getBoundingClientRect();
      const pr = container.getBoundingClientRect();
      setGeom((g) => {
        const box = { left: cr.left - pr.left, top: cr.top - pr.top, width: cr.width, height: cr.height };
        if (g && g.scene.tOut === scene.tOut && g.box.width === box.width && g.box.left === box.left && !st.playing && g.scene === scene) return g;
        return { comp, scene, box };
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={containerRef} className="relative flex h-full w-full items-center justify-center overflow-hidden">
      {error ? (
        <div className="max-w-sm text-center text-sm text-danger">Preview unavailable: {error}</div>
      ) : (
        <canvas ref={canvasRef} className="rounded-md shadow-2xl" aria-label="Video preview" />
      )}
      {geom && children?.(geom)}
    </div>
  );
}
