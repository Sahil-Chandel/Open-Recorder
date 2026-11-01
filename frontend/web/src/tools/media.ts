/**
 * Browser capture plumbing for the online recorders:
 *  - acquireSources(): screen / camera / microphone with human-readable errors. Required devices fail loudly; optional
 *    ones (the mic while recording the screen, the camera bubble) degrade to visible warnings — never silently.
 *  - createCompositor(): crops the primary video and draws the camera bubble into a new MediaStreamTrack.
 *    Chromium uses insertable streams (MediaStreamTrackProcessor → OffscreenCanvas → MediaStreamTrackGenerator), which
 *    is driven by frame arrival and therefore keeps recording while the tab is in the background (requestAnimationFrame
 *    stops there, which used to freeze composited recordings). Other browsers fall back to a canvas driven by a worker
 *    timer.
 *  - MIME, bitrate and download helpers.
 */
import { bubbleGeometry, clamp, cropOutputSize, cropSource, fitContain, type Rect, type Size } from './geometry';

export type Device = 'screen' | 'camera' | 'microphone';

/** A capture that could not start. `cancelled` = the user closed the browser's share picker (not an error). */
export class CaptureError extends Error {
  readonly cancelled: boolean;
  constructor(message: string, cancelled = false) {
    super(message);
    this.name = 'CaptureError';
    this.cancelled = cancelled;
  }
}

const LABEL: Record<Device, string> = { screen: 'Screen sharing', camera: 'Camera', microphone: 'Microphone' };
const nameOf = (e: unknown): string => String((e as { name?: unknown } | null)?.name ?? '');
const messageOf = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? '');
/** Chromium reports OS-level blocks as NotAllowedError "Permission denied by system". */
const blockedBySystem = (e: unknown): boolean => /system/i.test(messageOf(e));

/** Maps getUserMedia / getDisplayMedia failures to a sentence a user can act on. */
export function describeMediaError(e: unknown, device: Device): string {
  const label = LABEL[device];
  switch (nameOf(e)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      if (device === 'screen') {
        return blockedBySystem(e)
          ? 'Your system blocked screen recording for this browser. On macOS allow it in System Settings → Privacy & Security → Screen Recording, then restart the browser.'
          : 'Screen sharing was cancelled.';
      }
      return blockedBySystem(e)
        ? `${label} access is blocked by your system’s privacy settings. Allow this browser to use the ${device}, then try again.`
        : `${label} access is blocked for this site. Allow it from the camera/microphone icon in the address bar, then try again.`;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return `No ${device} was found. Connect one and try again.`;
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return `Your ${device} couldn’t be started — another app may be using it, or the system blocked it.`;
    case 'SecurityError':
      return `${label} isn’t allowed on this page. Open the recorder over https in a normal browser tab.`;
    case 'InvalidStateError':
      return 'Screen sharing has to be started by a click. Please try again.';
    case 'NotSupportedError':
      return `${label} isn’t supported in this browser.`;
    default: {
      const m = messageOf(e);
      return `${label} couldn’t start${m ? `: ${m}` : '.'}`;
    }
  }
}

export interface Sources {
  display: MediaStream | null;
  camera: MediaStreamTrack | null;
  mic: MediaStreamTrack | null;
  /** Problems with optional devices; recording can go ahead without them. */
  warnings: string[];
  /** Stops every captured track. */
  stop(): void;
}

const CAMERA: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
const MIC: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
/** Chromium-only hints (ignored elsewhere): offer "share system audio" and hide this tab, which would film itself. */
const DISPLAY = { video: { frameRate: { ideal: 30, max: 30 } }, audio: true, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' } as DisplayMediaStreamOptions;

async function permissionState(name: 'camera' | 'microphone'): Promise<PermissionState | 'unknown'> {
  try {
    return (await navigator.permissions.query({ name: name as PermissionName })).state;
  } catch {
    return 'unknown';
  }
}

interface UserTracks { camera: MediaStreamTrack | null; mic: MediaStreamTrack | null; cameraError: unknown; micError: unknown }

/**
 * Camera and/or mic in ONE prompt. If the combined request fails, salvage whichever device still works (no camera
 * plugged in must not cost the user their voice) — but never re-prompt for a device the user just refused.
 */
async function getUserTracks(wantCam: boolean, wantMic: boolean): Promise<UserTracks> {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) {
    const e = new DOMException('getUserMedia is unavailable', window.isSecureContext ? 'NotSupportedError' : 'SecurityError');
    return { camera: null, mic: null, cameraError: e, micError: e };
  }
  try {
    const s = await md.getUserMedia({ video: wantCam ? CAMERA : false, audio: wantMic ? MIC : false });
    return { camera: s.getVideoTracks()[0] ?? null, mic: s.getAudioTracks()[0] ?? null, cameraError: null, micError: null };
  } catch (e) {
    if (!(wantCam && wantMic)) return { camera: null, mic: null, cameraError: e, micError: e };
    const refused = nameOf(e) === 'NotAllowedError' && !blockedBySystem(e);
    const one = async (kind: 'camera' | 'microphone'): Promise<{ track: MediaStreamTrack | null; error: unknown }> => {
      const state = await permissionState(kind);
      if (state === 'denied' || (refused && state !== 'granted')) return { track: null, error: e };
      try {
        const s = await md.getUserMedia(kind === 'camera' ? { video: CAMERA } : { audio: MIC });
        return { track: (kind === 'camera' ? s.getVideoTracks() : s.getAudioTracks())[0] ?? null, error: null };
      } catch (e2) {
        return { track: null, error: e2 };
      }
    };
    const mic = await one('microphone'); // sequential: never two permission prompts at once
    const cam = await one('camera');
    return { camera: cam.track, mic: mic.track, cameraError: cam.error, micError: mic.error };
  }
}

/** Screen first (it needs the click's user activation), then camera/mic. */
export async function acquireSources(want: { screen: boolean; camera: boolean; mic: boolean }, required: { camera: boolean; mic: boolean }): Promise<Sources> {
  const tracks: MediaStreamTrack[] = [];
  const stop = () => { for (const t of tracks) t.stop(); };
  let display: MediaStream | null = null;
  if (want.screen) {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new CaptureError('This browser can’t record the screen. Try Chrome, Edge, Firefox, Safari or Opera on a computer.');
    try {
      display = await navigator.mediaDevices.getDisplayMedia(DISPLAY);
    } catch (e) {
      throw new CaptureError(describeMediaError(e, 'screen'), nameOf(e) === 'NotAllowedError' && !blockedBySystem(e));
    }
    tracks.push(...display.getTracks());
  }
  const warnings: string[] = [];
  let camera: MediaStreamTrack | null = null;
  let mic: MediaStreamTrack | null = null;
  if (want.camera || want.mic) {
    const got = await getUserTracks(want.camera, want.mic);
    camera = want.camera ? got.camera : null;
    mic = want.mic ? got.mic : null;
    for (const t of [got.camera, got.mic]) if (t) tracks.push(t);
    if (want.camera && !camera) {
      const m = describeMediaError(got.cameraError, 'camera');
      if (required.camera) { stop(); throw new CaptureError(m); }
      warnings.push(`Recording without the camera. ${m}`);
    }
    if (want.mic && !mic) {
      const m = describeMediaError(got.micError, 'microphone');
      if (required.mic) { stop(); throw new CaptureError(m); }
      warnings.push(`Your voice won’t be recorded. ${m}`);
    }
  }
  return { display, camera, mic, warnings, stop };
}

export function trackSize(t: MediaStreamTrack): Size {
  const s = t.getSettings();
  return { w: s.width ?? 1280, h: s.height ?? 720 };
}

/** Best MediaRecorder container/codec this browser supports for the given track mix. */
export function pickMime(video: boolean, audio: boolean): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = video
    ? audio
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export const extensionFor = (mime: string): string => (mime.includes('mp4') ? (mime.startsWith('audio') ? 'm4a' : 'mp4') : mime.includes('ogg') ? 'ogg' : 'webm');

/** ~0.12 bits per pixel per frame keeps screen text legible (the browser default ~2.5 Mbps blurs 1080p text). */
export const videoBitrate = (s: Size, fps = 30): number => Math.round(clamp(s.w * s.h * fps * 0.12, 2_500_000, 16_000_000));

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000); // the download must start before the URL goes away
}

export function recordingName(ext: string, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `recording-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

// ---------------------------------------------------------------------------------------------------- compositor

export interface Compositor {
  track: MediaStreamTrack;
  size: Size;
  /** 'frames' keeps running in background tabs; 'canvas' (no insertable streams) may be slowed there by the browser. */
  kind: 'frames' | 'canvas';
  stop(): void;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type ProcessorCtor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<VideoFrame> };
type GeneratorCtor = new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
const insertable = globalThis as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor };

/** Draws one output frame: the crop of `main` (letter-boxed if the source aspect changed) + the round camera bubble. */
function paint(ctx: Ctx2D, out: Size, crop: Rect, main: CanvasImageSource, mainSize: Size, cam: CanvasImageSource | null, camSize: Size | null): void {
  const c = cropSource(crop, mainSize);
  const fit = fitContain({ w: c.sw, h: c.sh }, out);
  if (fit.width < out.w - 0.5 || fit.height < out.h - 0.5) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.w, out.h);
  }
  ctx.drawImage(main, c.sx, c.sy, c.sw, c.sh, fit.left, fit.top, fit.width, fit.height);
  if (cam && camSize && camSize.w > 0 && camSize.h > 0) {
    const b = bubbleGeometry(out);
    const s = Math.max((2 * b.r) / camSize.w, (2 * b.r) / camSize.h); // cover the circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(cam, b.cx - (camSize.w * s) / 2, b.cy - (camSize.h * s) / 2, camSize.w * s, camSize.h * s);
    ctx.restore();
  }
}

/** Crop `primary` to `crop` (normalised, sized from `src`) and overlay `overlay` as a camera bubble. */
export function createCompositor(primary: MediaStreamTrack, overlay: MediaStreamTrack | null, crop: Rect, src: Size, fps = 30): Compositor {
  const out = cropOutputSize(crop, src);
  const { MediaStreamTrackProcessor: P, MediaStreamTrackGenerator: G } = insertable;
  if (P && G && typeof VideoFrame !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    try {
      return frameCompositor(P, G, primary, overlay, crop, out, fps);
    } catch { /* fall through to the canvas path */ }
  }
  return canvasCompositor(primary, overlay, crop, out, fps);
}

function frameCompositor(Processor: ProcessorCtor, Generator: GeneratorCtor, primary: MediaStreamTrack, overlay: MediaStreamTrack | null, crop: Rect, out: Size, fps: number): Compositor {
  const canvas = new OffscreenCanvas(out.w, out.h);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('OffscreenCanvas 2D is unavailable');
  const generator = new Generator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  const readers: Array<ReadableStreamDefaultReader<VideoFrame>> = [];
  const interval = 1000 / fps;
  let main: VideoFrame | null = null; // latest frame of each source; at most one held per source
  let cam: VideoFrame | null = null;
  let stopped = false;
  let writing = false;
  let pending = false;
  let lastEmit = 0;
  let lastTs = 0;

  const render = (): void => {
    if (stopped || !main) return;
    if (writing) { pending = true; return; } // back-pressure: render the newest frame once the write lands
    paint(ctx, out, crop, main, { w: main.displayWidth, h: main.displayHeight }, cam, cam ? { w: cam.displayWidth, h: cam.displayHeight } : null);
    const now = performance.now();
    lastEmit = now;
    lastTs = Math.max(lastTs + 1, Math.round(now * 1000)); // strictly increasing µs timestamps
    const frame = new VideoFrame(canvas, { timestamp: lastTs });
    writing = true;
    writer.write(frame).catch(() => undefined).finally(() => {
      frame.close();
      writing = false;
      if (pending) { pending = false; render(); }
    });
  };

  const pump = async (track: MediaStreamTrack, onFrame: (f: VideoFrame) => void, onEnd: () => void): Promise<void> => {
    const reader = new Processor({ track, maxBufferSize: 2 }).readable.getReader();
    readers.push(reader);
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (stopped) { r.value.close(); break; }
        onFrame(r.value);
      }
    } catch { /* track ended or reader cancelled */ }
    onEnd();
  };

  void pump(primary, (f) => { main?.close(); main = f; render(); }, () => undefined);
  // The camera keeps the bubble alive on a static screen (screen capture only delivers frames on change).
  if (overlay) void pump(overlay, (f) => { cam?.close(); cam = f; if (performance.now() - lastEmit > interval * 1.5) render(); }, () => { cam?.close(); cam = null; });

  return {
    track: generator,
    size: out,
    kind: 'frames',
    stop() {
      if (stopped) return;
      stopped = true;
      for (const r of readers) void r.cancel().catch(() => undefined);
      main?.close();
      cam?.close();
      main = null;
      cam = null;
      void writer.close().catch(() => undefined);
      generator.stop();
    },
  };
}

/** Timer that keeps ticking in background tabs (dedicated-worker timers aren't throttled like the page's own). */
function startTicker(fps: number, onTick: () => void): () => void {
  const ms = Math.max(1, Math.round(1000 / fps));
  let fallback = 0;
  const useInterval = () => { if (!fallback) fallback = window.setInterval(onTick, ms); };
  let worker: Worker | null = null;
  let url = '';
  try {
    url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = () => onTick();
    worker.onerror = () => { worker?.terminate(); worker = null; useInterval(); };
  } catch {
    useInterval();
  }
  return () => {
    worker?.terminate();
    if (url) URL.revokeObjectURL(url);
    if (fallback) window.clearInterval(fallback);
  };
}

function canvasCompositor(primary: MediaStreamTrack, overlay: MediaStreamTrack | null, crop: Rect, out: Size, fps: number): Compositor {
  const video = (t: MediaStreamTrack): HTMLVideoElement => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = new MediaStream([t]);
    void v.play().catch(() => undefined);
    return v;
  };
  const vMain = video(primary);
  const vCam = overlay ? video(overlay) : null;
  const canvas = document.createElement('canvas');
  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext('2d', { alpha: false });
  const track = canvas.captureStream(fps).getVideoTracks()[0];
  if (!ctx || !track) throw new Error('Canvas recording isn’t supported in this browser');
  const tick = () => {
    if (vMain.readyState < 2 || !vMain.videoWidth) return;
    const cam = vCam && overlay?.readyState === 'live' && vCam.readyState >= 2 && vCam.videoWidth > 0 ? vCam : null;
    paint(ctx, out, crop, vMain, { w: vMain.videoWidth, h: vMain.videoHeight }, cam, cam ? { w: cam.videoWidth, h: cam.videoHeight } : null);
  };
  const stopTicker = startTicker(fps, tick);
  return {
    track,
    size: out,
    kind: 'canvas',
    stop() {
      stopTicker();
      track.stop();
      vMain.srcObject = null;
      if (vCam) vCam.srcObject = null;
    },
  };
}
