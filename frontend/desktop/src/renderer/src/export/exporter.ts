/**
 * Export engine (plan §6.14, tasks 4.2–4.4): frame-accurate sequential decode (mediabunny + WebCodecs) →
 * the SAME compositor as preview on an OffscreenCanvas → hardware H.264 (CanvasSource) + AAC/Opus mix
 * (OfflineAudioContext) → MP4 streamed to disk through IPC. GIF = intermediate MP4 → ffmpeg palette (main).
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  CanvasSource,
  canEncodeAudio,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  VideoSampleSink,
  type StreamTargetChunk,
  type VideoSample,
} from 'mediabunny';
import {
  avcCodecFor,
  bitrateFor,
  buildDerived,
  canvasAspect,
  evaluateScene,
  exportDimensions,
  gifSettings,
  outToSrc,
  type ExportSettings,
  type Project,
  type Telemetry,
} from '@rec/shared';
import type { OpenedProject } from '../../../shared/ipc';
import { mixChunks } from '../audio/engine';
import { Compositor } from '../compositor/Compositor';
import { SHAPES } from '../compositor/assets';
import { drawOverlay } from '../compositor/overlay';
import { api } from '../lib/api';
import { cameraOffsetSec, cameraSourceRel, mediaUrl } from '../editor/media';
import { loadImage } from '../editor/Player';
import { maskFileFor } from '../editor/segmentation';
import { ensureFonts } from '../fonts';


export interface ExportJob {
  promise: Promise<{ path: string; bytes: number }>;
  cancel: () => void;
}

export interface ExportOptions {
  project: Project;
  opened: OpenedProject;
  telemetry: Telemetry;
  settings: ExportSettings;
  onProgress: (p: number, stage: string) => void;
}

async function openTrack(url: string): Promise<{ sink: VideoSampleSink; first: number; input: Input } | null> {
  try {
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const first = await track.getFirstTimestamp();
    return { sink: new VideoSampleSink(track), first, input };
  } catch {
    return null;
  }
}

export function startExport(opts: ExportOptions): ExportJob {
  let cancelled = false;
  let output: Output | null = null;
  let jobId: number | null = null;
  const cancel = () => {
    cancelled = true;
    void output?.cancel();
    if (jobId !== null) void api.invoke('export:abort', jobId);
  };
  // released on success, failure and cancel alike (a cancelled export used to leak a WebGL context + decoders)
  const disposers: Array<() => void> = [];
  const promise = (async () => {
    const { project, opened, telemetry, settings } = opts;
    const isGif = settings.format === 'gif';
    const fps = isGif ? gifSettings(settings.fps).fps : settings.fps;
    const aspect = canvasAspect(project.canvas, project.source.width, project.source.height);
    const srcShort = Math.min(project.source.width * (project.canvas.crop?.w ?? 1), project.source.height * (project.canvas.crop?.h ?? 1));
    const { width, height } = exportDimensions(settings.resolution, aspect, Math.round(srcShort), settings.format);
    const derived = buildDerived(project, telemetry, api.platform() === 'darwin');
    const duration = derived.duration;
    const frameCount = Math.max(1, Math.round(duration * fps));
    const ext = isGif ? 'gif' : 'mp4';
    const path = `${settings.dir.replace(/[\\/]+$/, '')}${api.platform() === 'win32' ? '\\' : '/'}${settings.name.replace(/[<>:"/\\|?*]/g, '_')}.${ext}`;

    opts.onProgress(0, 'Preparing');
    const canvas = new OffscreenCanvas(width, height);
    const comp = new Compositor(canvas);
    disposers.push(() => comp.dispose());
    comp.resize(width, height);
    await comp.prepareCursors(project.cursor.styleId, project.cursor.color, SHAPES);
    await ensureFonts(); // canvas text silently uses a fallback font until the face has loaded
    for (const c of opened.cursorBitmaps) await comp.loadCustomCursor(c.id, c.url, c.hotspot);
    const overlay = new OffscreenCanvas(width, height);
    const octx = overlay.getContext('2d')!;
    const base = opened.mediaBase;
    const watermark = project.watermark?.file ? await loadImage(mediaUrl(base, project.watermark.file)) : null;
    // a missing imported cursor must not fail the export — the style cursor is used instead
    if (project.cursor.custom) await comp.setImportedCursor(mediaUrl(base, project.cursor.custom.file), project.cursor.custom.hotspot).catch(() => comp.setImportedCursor(null));
    const bgImage = project.canvas.background.type === 'image' ? await loadImage(mediaUrl(base, project.canvas.background.value)) : null;
    const camBg = project.camera.background.mode === 'image' && project.camera.background.value ? await loadImage(mediaUrl(base, project.camera.background.value)) : null;

    const bgTrack = project.canvas.background.type === 'video' ? await openTrack(mediaUrl(base, project.canvas.background.value)) : null;
    if (bgTrack) disposers.push(() => bgTrack.input.dispose?.());
    const bgDur = bgTrack ? await bgTrack.input.computeDuration().catch(() => 0) : 0;
    const screen = await openTrack(mediaUrl(base, project.source.tracks.screen ?? project.source.segments[0]?.file ?? ''));
    if (!screen) throw new Error('Cannot decode the screen recording');
    disposers.push(() => screen.input.dispose?.());
    const camRel = cameraSourceRel(project);
    const camera = camRel && project.camera.visible ? await openTrack(mediaUrl(base, camRel)) : null;
    const mask = camera && project.camera.background.mode !== 'original' ? await openTrack(mediaUrl(base, maskFileFor(project))) : null;
    for (const tr of [camera, mask]) if (tr) disposers.push(() => tr.input.dispose?.());
    // an AI avatar is lip-synced to the microphone, so it sits on the mic's timeline, not the camera's
    const camOff = cameraOffsetSec(project);

    const srcTimes = Array.from({ length: frameCount }, (_, i) => outToSrc(project.clips, Math.min(duration, i / fps)).src);
    const screenIt = screen.sink.samplesAtTimestamps(srcTimes.map((s) => s + screen.first));
    const camIt = camera?.sink.samplesAtTimestamps(srcTimes.map((s) => Math.max(0, s - camOff) + camera.first));
    const maskIt = mask?.sink.samplesAtTimestamps(srcTimes.map((s) => Math.max(0, s - camOff) + mask.first));
    // looping background: output time modulo its length (monotonic within each loop for the sequential sink)
    const bgIt = bgTrack && bgDur > 0 ? bgTrack.sink.samplesAtTimestamps(Array.from({ length: frameCount }, (_, i) => ((i / fps) % bgDur) + bgTrack.first)) : null;
    for (const it of [screenIt, camIt, maskIt, bgIt]) if (it) disposers.push(() => void it.return?.(undefined));

    // output → main process file sink (positioned writes)
    jobId = await api.invoke<number>('export:begin', { path, format: settings.format, ...(isGif ? { gifFps: fps, gifWidth: width } : {}) });
    const id = jobId;
    let pending: Promise<unknown> = Promise.resolve();
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        const copy = chunk.data.slice();
        pending = pending.then(() => api.invoke('export:write', id, chunk.position, copy.buffer));
        return pending as Promise<void>;
      },
    });
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) });
    const video = new CanvasSource(canvas, {
      codec: 'avc',
      bitrate: bitrateFor(width, height, fps, isGif ? 'best' : settings.quality),
      keyFrameInterval: 2,
      fullCodecString: avcCodecFor(width, height, fps),
      hardwareAcceleration: 'prefer-hardware',
    } as never);
    output.addVideoTrack(video, { frameRate: fps });
    let audio: AudioBufferSource | null = null;
    const hasAudio = !isGif && (project.source.tracks.mic || project.source.tracks.system || project.source.tracks.device || project.music || project.cursor.clickSound.enabled);
    if (hasAudio) {
      const codec = (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 })) ? 'aac' : 'opus';
      audio = new AudioBufferSource({ codec, bitrate: 192000 });
      output.addAudioTrack(audio);
    }
    await output.start();

    const t0 = performance.now();
    for (let i = 0; i < frameCount; i++) {
      if (cancelled) throw new DOMException('Export cancelled', 'AbortError');
      const t = i / fps;
      const sNext = await screenIt.next();
      const cNext = camIt ? await camIt.next() : null;
      const mNext = maskIt ? await maskIt.next() : null;
      const bNext = bgIt ? await bgIt.next() : null;
      const bSample = (bNext?.value ?? null) as VideoSample | null;
      const bFrame = bSample?.toVideoFrame() ?? null;
      const sSample = (sNext.value ?? null) as VideoSample | null;
      const cSample = (cNext?.value ?? null) as VideoSample | null;
      const mSample = (mNext?.value ?? null) as VideoSample | null;
      const sFrame = sSample?.toVideoFrame() ?? null;
      const cFrame = cSample?.toVideoFrame() ?? null;
      const mFrame = mSample?.toVideoFrame() ?? null;
      const scene = evaluateScene(project, derived, t, width, height, fps);
      const drew = drawOverlay(octx, project, scene, comp, { watermark });
      comp.render(project, scene, {
        screen: sFrame,
        camera: cFrame,
        ...(cFrame ? { cameraSize: { w: cFrame.displayWidth, h: cFrame.displayHeight } } : {}),
        cameraMask: mFrame,
        bgImage: bFrame ?? bgImage,
        cameraBgImage: camBg,
        overlay: drew ? overlay : null,
      }, { quality: 'export', fps });
      sFrame?.close(); cFrame?.close(); mFrame?.close(); bFrame?.close();
      sSample?.close(); cSample?.close(); mSample?.close(); bSample?.close();
      await video.add(t, 1 / fps);
      if (i % 10 === 0) {
        const el = (performance.now() - t0) / 1000;
        opts.onProgress((i / frameCount) * (hasAudio ? 0.85 : 0.97), `Rendering ${Math.round((i / Math.max(el, 0.001)) * 10) / 10} fps`);
      }
    }
    video.close();
    if (audio) {
      opts.onProgress(0.86, 'Mixing audio');
      // chunked mixdown (~30 s windows, seam-stitched) → bounded memory for hour-long projects
      const mixOpts = { mediaBase: base, dir: opened.dir, denoised: project.audio.mic.denoise, telemetry, onProgress: (p: number) => opts.onProgress(0.86 + p * 0.1, 'Mixing audio') };
      for await (const chunk of mixChunks(project, mixOpts)) {
        if (cancelled) throw new DOMException('Export cancelled', 'AbortError');
        await audio.add(chunk);
      }
      audio.close();
    }
    opts.onProgress(0.97, isGif ? 'Building GIF palette' : 'Finalising');
    await output.finalize();
    await pending;
    const r = await api.invoke<{ path: string; bytes: number }>('export:finish', id);
    opts.onProgress(1, 'Done');
    return r;
  })().finally(() => {
    for (const d of disposers.splice(0).reverse()) {
      try { d(); } catch { /* already released */ }
    }
  });
  promise.catch(() => {
    if (jobId !== null) void api.invoke('export:abort', jobId);
  });
  return { promise, cancel };
}
