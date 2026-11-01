/**
 * Preview media sources: <video>/<audio> elements kept in sync with the output clock (task 3.3/3.4).
 * Elements seek only when drift exceeds a threshold, and follow per-clip speed via playbackRate.
 * Export uses frame-accurate WebCodecs decoding instead (export/exporter.ts).
 */
import { outToSrc, type Project } from '@rec/shared';

export interface PreviewMedia {
  screen: HTMLVideoElement;
  camera: HTMLVideoElement | null;
  /** swap the camera source (webcam ↔ AI avatar) without rebuilding the player */
  setCamera(url: string | null): void;
  dispose(): void;
}

/** File shown in the camera slot: the AI avatar when applied (even for recordings without a webcam). */
export const cameraSourceRel = (p: Project): string | null => p.camera.avatar?.videoFile ?? p.camera.facecam?.file ?? p.source.tracks.camera ?? null;

/** Seconds the camera-slot media starts after source t=0; an avatar is lip-synced to the microphone. */
export const cameraOffsetSec = (p: Project): number =>
  p.camera.avatar ? p.source.trackOffsets.mic ?? 0 : p.camera.facecam ? p.camera.facecam.offsetSec : p.source.trackOffsets.camera ?? 0;

function makeVideo(url: string): HTMLVideoElement {
  const v = document.createElement('video');
  v.src = url;
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.crossOrigin = 'anonymous';
  return v;
}

export function mediaUrl(base: string, rel: string): string {
  return `${base}${encodeURIComponent(`/${rel}`)}`;
}

export function createPreviewMedia(project: Project, mediaBase: string): PreviewMedia {
  const screenRel = project.source.tracks.screen ?? project.source.segments[0]?.file ?? '';
  const screen = makeVideo(mediaUrl(mediaBase, screenRel));
  const camRel = cameraSourceRel(project);
  const release = (v: HTMLVideoElement) => {
    v.pause();
    v.removeAttribute('src');
    v.load();
  };
  const media: PreviewMedia = {
    screen,
    camera: camRel ? makeVideo(mediaUrl(mediaBase, camRel)) : null,
    setCamera(url) {
      if ((media.camera?.src ?? null) === url) return;
      if (media.camera) release(media.camera);
      media.camera = url ? makeVideo(url) : null;
    },
    dispose() {
      release(screen);
      if (media.camera) release(media.camera);
    },
  };
  return media;
}

/** Bring an element to `target` (seconds in its own timeline). Returns true when a seek was issued. */
export function syncElement(el: HTMLMediaElement, target: number, playing: boolean, rate: number, tolerance = 0.15): boolean {
  if (!Number.isFinite(target)) return false;
  const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
  const t = Math.min(Math.max(0, target), Math.max(0, dur - 0.01));
  const r = Math.min(16, Math.max(0.0625, rate));
  if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
  let seeked = false;
  if (!playing) {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - t) > 1 / 120) {
      el.currentTime = t;
      seeked = true;
    }
  } else {
    if (Math.abs(el.currentTime - t) > tolerance) {
      el.currentTime = t;
      seeked = true;
    }
    if (el.paused && target < dur) void el.play().catch(() => undefined);
  }
  return seeked;
}

export function sourceTimeFor(project: Project, tOut: number): { src: number; speed: number } {
  const { src, clip } = outToSrc(project.clips, tOut);
  return { src, speed: clip.speed };
}
