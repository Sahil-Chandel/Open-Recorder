/**
 * Background-removal pre-pass (task 7.6, §6.10): MediaPipe selfie segmentation (~256 px) over the camera
 * track at 15 fps → temporal EMA (α 0.6) to kill flicker → grayscale mask video (H.264) in cache/.
 * Preview & export then composite in real time from the cached mask. Runs once, with progress.
 */
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny';
import type { Project } from '@rec/shared';
import { api } from '../lib/api';
import { cameraMaskProvider } from './cameraMask';
import { mediaUrl } from './media';
import { useEditor } from './store';
import { useTasks } from './tasks';

let running: Promise<void> | null = null;

/**
 * Cache name of the background mask for the project's current camera source. Keyed by source so an AI
 * avatar never reuses the webcam's mask (or vice versa); the webcam keeps its original name.
 */
export function maskCacheName(p: Pick<Project, 'camera'>): string {
  const avatar = p.camera.avatar?.videoFile ?? p.camera.facecam?.file;
  if (!avatar) return 'camera.mask.mp4';
  return `mask-${avatar.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_')}.mp4`;
}
export const maskFileFor = (p: Pick<Project, 'camera'>): string => `cache/${maskCacheName(p)}`;

/** Point the mask provider at an existing cached mask (called on project open). */
export async function attachCachedMask(): Promise<boolean> {
  const s = useEditor.getState();
  if (!s.opened) return false;
  const name = maskCacheName(s.project!);
  const bytes = await api.invoke<Uint8Array | null>('projects:readCache', s.dir, name);
  cameraMaskProvider.setSource(bytes ? mediaUrl(s.opened.mediaBase, `cache/${name}`) : null);
  return Boolean(bytes);
}

export function runBackgroundRemoval(): Promise<void> {
  running ??= doRun().finally(() => (running = null));
  return running;
}

async function doRun(): Promise<void> {
  if (await attachCachedMask()) return;
  const s = useEditor.getState();
  const p = s.project!;
  const camRel = p.camera.avatar?.videoFile ?? p.camera.facecam?.file ?? p.source.tracks.camera;
  if (!camRel) throw new Error('No camera track');
  const id = `seg-${Date.now()}`;
  const tasks = useTasks.getState();
  tasks.upsert({ id, title: 'Camera background removal', kind: 'segmentation', progress: 0, status: 'running', detail: 'Loading model…' });
  try {
    const model = await api.invoke<{ url: string }>('models:ensure', 'selfie');
    const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(new URL('./mediapipe', window.location.href).href.replace(/#.*$/, ''));
    const seg = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: model.url, delegate: 'GPU' },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.src = mediaUrl(s.opened!.mediaBase, camRel);
    await new Promise<void>((res, rej) => { video.onloadeddata = () => res(); video.onerror = () => rej(new Error('Cannot read camera video')); });
    if (!Number.isFinite(video.duration)) { video.currentTime = 1e9; await new Promise((r) => (video.onseeked = r)); }
    const duration = video.duration;
    const aspect = video.videoWidth / video.videoHeight;
    const mh = 256, mw = Math.max(2, Math.round((mh * aspect) / 2) * 2);
    const canvas = new OffscreenCanvas(mw, mh);
    const ctx = canvas.getContext('2d')!;
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const fps = 15;
    const source = new CanvasSource(canvas, { codec: 'avc', bitrate: 600_000, keyFrameInterval: 1 } as never);
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    const img = ctx.createImageData(mw, mh);
    let ema: Float32Array | null = null;
    const frames = Math.ceil(duration * fps);
    tasks.upsert({ id, detail: '' });
    for (let i = 0; i < frames; i++) {
      const t = i / fps;
      video.currentTime = t;
      await new Promise((r) => (video.onseeked = r));
      const res = seg.segmentForVideo(video, Math.round(t * 1000));
      const mask = res.confidenceMasks?.[0];
      if (mask) {
        const data = mask.getAsFloat32Array();
        const w = mask.width, h = mask.height;
        if (!ema || ema.length !== mw * mh) ema = new Float32Array(mw * mh);
        for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
          const v = data[Math.floor((y / mh) * h) * w + Math.floor((x / mw) * w)] ?? 0;
          const k = y * mw + x;
          ema[k] = i === 0 ? v : 0.6 * v + 0.4 * ema[k]!;
          const g = Math.round(ema[k]! * 255);
          img.data[k * 4] = g; img.data[k * 4 + 1] = g; img.data[k * 4 + 2] = g; img.data[k * 4 + 3] = 255;
        }
        mask.close();
      }
      ctx.putImageData(img, 0, 0);
      await source.add(t, 1 / fps);
      if (i % 5 === 0) tasks.upsert({ id, progress: i / frames });
    }
    source.close();
    await output.finalize();
    seg.close();
    await api.invoke('projects:writeCache', s.dir, maskCacheName(p), new Uint8Array(target.buffer!));
    await attachCachedMask();
    tasks.upsert({ id, progress: 1, status: 'done' });
  } catch (e) {
    tasks.upsert({ id, status: 'error', detail: (e as Error).message, retry: () => void runBackgroundRemoval() });
    throw e;
  }
}
