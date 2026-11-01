/**
 * Timeline waveform drawing (audit B1): canvas columns read the cached multi-resolution peak pyramid
 * (O(1) per device-pixel column, no allocation), mapped through the clip list so every clip shows its own
 * trimmed source range compressed by its speed. Only the visible window is drawn.
 */
import { clipOutLen, type Clip, type Project } from '@rec/shared';
import { peakSpan, sampleCurve, type GainCurve, type TrackAnalysis } from '../audio/analysis';
import { MAX_AUDIBLE_SPEED, musicGainAt, musicPosAt } from '../audio/mixModel';

export interface WaveView {
  /** css px scroll offset of the timeline content */
  scrollX: number;
  /** px per second */
  zoom: number;
  /** css px width of the visible content */
  width: number;
  dpr: number;
}

export interface WaveStyle {
  mode: 'center' | 'bottom';
  color: string;
  /** colour for clips that play silently (muted / > 2× speed) */
  mutedColor: string;
  /** device px */
  top: number;
  height: number;
  /** per-clip display gain (track volume × clip volume); 0 → muted colour */
  gainOf?: (c: Clip) => number;
  /** faint line at clip joins */
  separators?: string;
}

const span = new Float32Array(2);

/** Companded display scale so the loudest peak of the file reaches ~95 % of the lane. */
export function waveScale(a: Pick<TrackAnalysis, 'peakMax'>): number {
  return 0.95 / Math.max(0.05, Math.sqrt(Math.min(1, a.peakMax)));
}

function column(ctx: CanvasRenderingContext2D, x: number, lo: number, hi: number, s: WaveStyle): void {
  if (s.mode === 'center') {
    const mid = s.top + s.height / 2;
    const y0 = mid - Math.min(1, hi) * (s.height / 2);
    const y1 = mid - Math.max(-1, lo) * (s.height / 2);
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  } else {
    const amp = Math.min(1, Math.max(-lo, hi));
    const h = Math.max(1, amp * s.height);
    ctx.fillRect(x, s.top + s.height - h, 1, h);
  }
}

/** Waveform of one audio file through the clip map (output time on x). */
export function drawClipWaveform(ctx: CanvasRenderingContext2D, a: TrackAnalysis, clips: readonly Clip[], offset: number, v: WaveView, s: WaveStyle): void {
  const W = Math.round(v.width * v.dpr);
  const pxPerSec = v.zoom * v.dpr;
  const x0 = v.scrollX / v.zoom;
  const viewEnd = x0 + v.width / v.zoom;
  const scale = waveScale(a);
  let outStart = 0;
  for (let ci = 0; ci < clips.length; ci++) {
    const c = clips[ci]!;
    const outEnd = outStart + clipOutLen(c);
    if (outEnd > x0 && outStart < viewEnd) {
      const gain = s.gainOf ? s.gainOf(c) : 1;
      const silent = c.speed > MAX_AUDIBLE_SPEED || gain <= 0;
      const g = silent ? 0.35 : Math.sqrt(Math.min(4, gain)); // companded display gain
      ctx.fillStyle = silent ? s.mutedColor : s.color;
      const xa = Math.max(0, Math.floor((outStart - x0) * pxPerSec));
      const xb = Math.min(W, Math.ceil((outEnd - x0) * pxPerSec));
      for (let x = xa; x < xb; x++) {
        const ta = Math.max(outStart, x0 + x / pxPerSec);
        const tb = Math.min(outEnd, x0 + (x + 1) / pxPerSec);
        if (!(tb > ta)) continue;
        const fa = c.srcStart + (ta - outStart) * c.speed - offset;
        const fb = c.srcStart + (tb - outStart) * c.speed - offset;
        if (!peakSpan(a, fa, fb, span)) continue;
        column(ctx, x, span[0]! * scale * g, span[1]! * scale * g, s);
      }
      if (s.separators && ci > 0 && xa > 0) {
        ctx.fillStyle = s.separators;
        ctx.fillRect(xa, s.top, 1, s.height);
      }
    }
    outStart = outEnd;
    if (outStart >= viewEnd) break;
  }
}

/**
 * Music waveform in output time (trim + loop, clamped to the edited duration) plus the gain envelope
 * (fades × ducking, normalised to the music volume) as a line — exactly what preview and export apply.
 */
export function drawMusicWaveform(ctx: CanvasRenderingContext2D, a: TrackAnalysis | null, project: Project, duck: GainCurve | null, v: WaveView, s: WaveStyle & { envelope: string }): void {
  const m = project.music;
  if (!m) return;
  const W = Math.round(v.width * v.dpr);
  const pxPerSec = v.zoom * v.dpr;
  const x0 = v.scrollX / v.zoom;
  if (a) {
    const scale = waveScale(a);
    ctx.fillStyle = s.color;
    for (let x = 0; x < W; x++) {
      const t = x0 + x / pxPerSec;
      const pos = musicPosAt(project, t);
      if (pos === null) continue;
      if (!peakSpan(a, pos, pos + 1 / pxPerSec, span)) continue;
      column(ctx, x, span[0]! * scale, span[1]! * scale, s);
    }
  }
  const vol = Math.max(1e-3, m.volume);
  ctx.strokeStyle = s.envelope;
  ctx.lineWidth = Math.max(1, v.dpr);
  ctx.beginPath();
  let pen = false;
  for (let x = 0; x <= W; x += 2) {
    const t = x0 + x / pxPerSec;
    if (musicPosAt(project, t) === null) {
      pen = false;
      continue;
    }
    const g = (musicGainAt(project, t) * (duck ? sampleCurve(duck, t) : 1)) / vol;
    const y = s.top + s.height - Math.min(1, g) * s.height + 0.5;
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();
}
