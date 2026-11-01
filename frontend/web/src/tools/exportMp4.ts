/**
 * Mini-editor MP4 export (loaded on demand — it pulls in mediabunny's demuxers and muxers).
 *
 * The MediaRecorder file is decoded sequentially with WebCodecs (no per-frame <video> seeking, which was slow,
 * imprecise and — because MediaRecorder WebM reports duration = Infinity — exported zero frames). Every output frame
 * at a constant 30 fps gets the manual zooms applied in `process`, then H.264 is encoded. The recorded audio is carried
 * over: AAC when the browser can encode it, otherwise the original Opus is copied into the MP4.
 */
import { BlobSource, BufferTarget, Conversion, Input, MATROSKA, MP4, Mp4OutputFormat, Output, QTFF, QUALITY_HIGH, WEBM, canEncodeAudio, canEncodeVideo, type DiscardedTrack } from 'mediabunny';
import { even, fitContain, zoomViewport, type Zoom } from './geometry';

export interface ExportOptions {
  fps?: number;
  /** Real recording length (seconds) for progress; mediabunny's own estimate is used when absent. */
  duration?: number;
  signal?: AbortSignal;
  /** Called with 0…1, at most once per whole percent. */
  onProgress?: (fraction: number) => void;
}
export interface ExportResult { blob: Blob; warnings: string[] }

export const canExportMp4 = (): Promise<boolean> =>
  typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined' ? Promise.resolve(false) : canEncodeVideo('avc').catch(() => false);

const REASON: Record<DiscardedTrack['reason'], string> = {
  discarded_by_user: 'skipped',
  max_track_count_reached: 'too many tracks',
  max_track_count_of_type_reached: 'too many tracks of this kind',
  unknown_source_codec: 'unknown codec',
  undecodable_source_codec: 'this browser can’t decode it',
  no_encodable_target_codec: 'this browser can’t encode it for MP4',
  cannot_copy: 'it couldn’t be copied',
};
const kindOf = (d: DiscardedTrack): string => (d.track.isVideoTrack() ? 'video' : d.track.isAudioTrack() ? 'audio' : 'track');

export async function exportMp4(src: Blob, zooms: readonly Zoom[], o: ExportOptions = {}): Promise<ExportResult> {
  const fps = o.fps ?? 30;
  if (o.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  // MediaRecorder only writes WebM (Chromium, Firefox) or MP4 (Safari); other demuxers would just bloat this chunk.
  const input = new Input({ source: new BlobSource(src), formats: [WEBM, MATROSKA, MP4, QTFF] });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('the recording has no video track');
    const W = even(await track.getDisplayWidth());
    const H = even(await track.getDisplayHeight());
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('this browser can’t draw video frames');

    let lastPct = -1;
    const report = (f: number) => {
      const pct = Math.floor(Math.min(1, Math.max(0, f)) * 100);
      if (pct !== lastPct) { lastPct = pct; o.onProgress?.(pct / 100); }
    };
    const knownDuration = o.duration !== undefined && Number.isFinite(o.duration) && o.duration > 0 ? o.duration : null;
    const aac = await canEncodeAudio('aac').catch(() => false);
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });

    const conversion = await Conversion.init({
      input,
      output,
      showWarnings: false,
      video: {
        codec: 'avc',
        frameRate: fps,
        quality: QUALITY_HIGH,
        processedWidth: W,
        processedHeight: H,
        // Called once per output frame (after frame-rate correction); the returned canvas is snapshotted immediately.
        process: (sample) => {
          const size = { w: sample.displayWidth, h: sample.displayHeight };
          const vp = zoomViewport(sample.timestamp, zooms, size);
          const fit = fitContain({ w: vp.sw, h: vp.sh }, { w: W, h: H });
          if (fit.width < W - 0.5 || fit.height < H - 0.5) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
          sample.draw(ctx, vp.sx, vp.sy, vp.sw, vp.sh, fit.left, fit.top, fit.width, fit.height);
          if (knownDuration) report(sample.timestamp / knownDuration);
          return canvas;
        },
      },
      // AAC plays everywhere (QuickTime, phones, social uploads); without an AAC encoder keep the Opus track (copied).
      audio: aac ? { codec: 'aac', quality: QUALITY_HIGH } : {},
    });
    if (!conversion.isValid) {
      const why = conversion.discardedTracks.map((d) => `${kindOf(d)}: ${REASON[d.reason]}`).join('; ');
      throw new Error(why || 'this browser can’t encode H.264 video');
    }
    const warnings = conversion.discardedTracks
      .filter((d) => d.track.isAudioTrack())
      .map((d) => `The audio couldn’t be included (${REASON[d.reason]}).`);
    if (!aac && conversion.utilizedTracks.some((t) => t.isAudioTrack())) {
      warnings.push('This browser can’t encode AAC, so the MP4 keeps the original Opus audio — it plays in browsers and most players, but not in QuickTime.');
    }
    if (!knownDuration) conversion.onProgress = (p) => report(p);

    const cancel = () => { void conversion.cancel(); };
    o.signal?.addEventListener('abort', cancel, { once: true });
    try {
      await conversion.execute();
    } finally {
      o.signal?.removeEventListener('abort', cancel);
    }
    const buffer = target.buffer;
    if (!buffer) throw new Error('the encoder produced no data');
    report(1);
    return { blob: new Blob([buffer], { type: 'video/mp4' }), warnings };
  } finally {
    input.dispose();
  }
}
