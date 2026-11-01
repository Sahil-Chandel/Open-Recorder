/**
 * Mix model (audit B14 / C22): the pure decisions shared by preview (PreviewAudio), export (mixChunks)
 * and the timeline drawing — which file plays, track gains, music range / fades / loop in OUTPUT time,
 * the ONE voice-activity ducking envelope, clip join fades, and the chunk plan + seam stitching used by
 * the chunked export mixdown. No DOM / WebAudio here → unit-testable in Node.
 */
import { clipOutLen, outputDuration, type Clip, type MusicTrack, type Project } from '@rec/shared';
import { balanceCurve, voiceActivity, type BalanceInfo, type GainCurve, type TrackAnalysis, type VoiceActivity } from './analysis';

export type TrackKey = 'mic' | 'system' | 'device';
export const TRACK_KEYS: readonly TrackKey[] = ['mic', 'system', 'device'];

/** Bundle-relative file that actually plays for a track (processed mic first). */
export function trackFile(project: Project, key: TrackKey, denoisedAvailable = false): string | undefined {
  if (key === 'mic' && project.audio.mic.enhance && project.source.tracks.mic) return 'cache/mic.enhanced.wav';
  if (key === 'mic' && project.audio.mic.denoise && denoisedAvailable && project.source.tracks.mic) return 'cache/mic.denoised.wav';
  return project.source.tracks[key];
}

export function trackGain(project: Project, key: TrackKey): number {
  const a = project.audio[key];
  return a.mute ? 0 : a.volume;
}

/** Clips faster than this are muted in preview AND export (pitch-preserving stretch is limited to 2×). */
export const MAX_AUDIBLE_SPEED = 2;

// ---------------------------------------------------------------- music (OUTPUT time)

/** Music stops at the end of its range or of the edited video, whichever comes first (fades follow). */
export function musicEnd(project: Project): number {
  const m = project.music;
  if (!m) return 0;
  return Math.max(m.rangeStart, Math.min(m.rangeEnd, outputDuration(project.clips)));
}

/** Core envelope with a precomputed end (hot path of the export mixdown). */
export function musicGainWithEnd(m: MusicTrack, end: number, t: number): number {
  if (t < m.rangeStart || t >= end) return 0;
  let g = m.volume;
  if (m.fadeIn > 0 && t < m.rangeStart + m.fadeIn) g *= (t - m.rangeStart) / m.fadeIn;
  if (m.fadeOut > 0 && t > end - m.fadeOut) g *= (end - t) / m.fadeOut;
  return g > 0 ? g : 0;
}

/** Music gain envelope at output time t (volume × fade in/out, fade-out ending at musicEnd). */
export function musicGainAt(project: Project, t: number): number {
  return project.music ? musicGainWithEnd(project.music, musicEnd(project), t) : 0;
}

/** Position inside the music file for output time t, or null when silent. */
export function musicPosAt(project: Project, t: number): number | null {
  const m = project.music;
  if (!m || t < m.rangeStart || t >= musicEnd(project)) return null;
  const len = Math.max(0.05, m.trimEnd - m.trimStart);
  const rel = t - m.rangeStart;
  if (!m.loop && rel >= len) return null;
  return m.trimStart + (rel % len);
}

export interface MusicSegment {
  outStart: number;
  outEnd: number;
  /** file position played at outStart (speed 1) */
  fileStart: number;
}

/** Contiguous music file ranges audible in output window [t0, t1) — consistent with musicPosAt. */
export function musicSegments(project: Project, t0: number, t1: number): MusicSegment[] {
  const m = project.music;
  if (!m) return [];
  const a = Math.max(t0, m.rangeStart), b = Math.min(t1, musicEnd(project));
  if (!(b > a)) return [];
  const len = Math.max(0.05, m.trimEnd - m.trimStart);
  if (!m.loop) {
    const e = Math.min(b, m.rangeStart + len);
    return e > a ? [{ outStart: a, outEnd: e, fileStart: m.trimStart + (a - m.rangeStart) }] : [];
  }
  const out: MusicSegment[] = [];
  for (let k = Math.floor((a - m.rangeStart) / len); ; k++) {
    const segS = m.rangeStart + k * len, segE = segS + len;
    const s = Math.max(a, segS), e = Math.min(b, segE);
    if (e > s) out.push({ outStart: s, outEnd: e, fileStart: m.trimStart + (s - segS) });
    if (segE >= b) break;
  }
  return out;
}

// ---------------------------------------------------------------- ducking (ONE envelope for preview + export)

export interface DuckOptions {
  level: number;
  attack: number;
  release: number;
  /** offline look-ahead: the music starts dipping just before the first syllable */
  lookahead: number;
  hop: number;
}
export const DUCK_DEFAULTS: DuckOptions = { level: 0.35, attack: 0.08, release: 0.25, lookahead: 0.06, hop: 0.01 };

/**
 * Music ducking gain over OUTPUT time from the mic's voice activity (not the master bus, which contains
 * the music itself). Voice counts only where the mic is audible (clip speed ≤ 2, clip mic volume > 0,
 * track not muted). Asymmetric one-pole smoothing (attack / release). O(duration / hop + clips).
 */
export function duckCurve(clips: readonly Clip[], vad: VoiceActivity, micOffset: number, micOn: boolean, outDuration: number, o: Partial<DuckOptions> = {}): GainCurve {
  const opt = { ...DUCK_DEFAULTS, ...o };
  const hop = opt.hop;
  const n = Math.max(1, Math.ceil(outDuration / hop) + 1);
  const values = new Float32Array(n);
  const ka = 1 - Math.exp(-hop / opt.attack);
  const kr = 1 - Math.exp(-hop / opt.release);
  const act = vad.active, vh = vad.hop;
  let y = 1;
  let ci = 0;
  let cStart = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.min(outDuration, i * hop + opt.lookahead);
    while (ci < clips.length - 1 && t >= cStart + clipOutLen(clips[ci]!)) {
      cStart += clipOutLen(clips[ci]!);
      ci++;
    }
    const c = clips[ci];
    let voice = false;
    if (micOn && c && c.speed <= MAX_AUDIBLE_SPEED && c.volume.mic > 0) {
      const k = Math.floor((c.srcStart + (t - cStart) * c.speed - micOffset) / vh);
      voice = k >= 0 && k < act.length && act[k] === 1;
    }
    const target = voice ? opt.level : 1;
    y += (target - y) * (target < y ? ka : kr);
    values[i] = y;
  }
  return { start: 0, hop, values };
}

const vadMemo = new WeakMap<TrackAnalysis, VoiceActivity>();
export function vadFor(a: TrackAnalysis): VoiceActivity {
  let v = vadMemo.get(a);
  if (!v) vadMemo.set(a, (v = voiceActivity(a)));
  return v;
}

const balanceMemo = new WeakMap<TrackAnalysis, BalanceInfo>();
export function balanceFor(a: TrackAnalysis): BalanceInfo {
  let b = balanceMemo.get(a);
  if (!b) balanceMemo.set(a, (b = balanceCurve(a)));
  return b;
}

let duckMemo: { clips: readonly Clip[]; a: TrackAnalysis; off: number; on: boolean; curve: GainCurve } | null = null;
/** Memoised ducking curve for the project (identity checks only → safe to call every frame). */
export function duckFor(project: Project, micAnalysis: TrackAnalysis | null): GainCurve | null {
  if (!project.audio.ducking || !project.music || !project.source.tracks.mic || !micAnalysis) return null;
  const on = !project.audio.mic.mute && project.audio.mic.volume > 0;
  const off = project.source.trackOffsets.mic ?? 0;
  const d = duckMemo;
  if (d && d.clips === project.clips && d.a === micAnalysis && d.off === off && d.on === on) return d.curve;
  const curve = duckCurve(project.clips, vadFor(micAnalysis), off, on, outputDuration(project.clips));
  duckMemo = { clips: project.clips, a: micAnalysis, off, on, curve };
  return curve;
}

// ---------------------------------------------------------------- clip pieces + join fades

export const JOIN_FADE = 0.01;

export interface ClipPiece {
  index: number;
  clip: Clip;
  outStart: number;
  outEnd: number;
  fadeIn: boolean;
  fadeOut: boolean;
}

/** Speed-1 joins that continue the same source are seamless (no dip); every other join gets 10 ms fades. */
function contiguous(a: Clip, b: Clip): boolean {
  return a.speed === 1 && b.speed === 1 && Math.abs(a.srcEnd - b.srcStart) < 1e-3;
}

/** Clips overlapping output window [t0, t1) with their output span and join-fade flags. O(clips). */
export function clipPieces(clips: readonly Clip[], t0: number, t1: number): ClipPiece[] {
  const out: ClipPiece[] = [];
  let s = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    const e = s + clipOutLen(c);
    if (e > t0 && s < t1) {
      const prev = clips[i - 1], next = clips[i + 1];
      out.push({ index: i, clip: c, outStart: s, outEnd: e, fadeIn: !prev || !contiguous(prev, c), fadeOut: !next || !contiguous(c, next) });
    }
    if (s >= t1) break;
    s = e;
  }
  return out;
}

/** 0…1 join envelope of a piece at output time t (10 ms linear fades, §6.11). */
export function pieceEnvelope(p: ClipPiece, t: number): number {
  let g = 1;
  if (p.fadeIn) g = Math.min(g, (t - p.outStart) / JOIN_FADE);
  if (p.fadeOut) g = Math.min(g, (p.outEnd - t) / JOIN_FADE);
  return g <= 0 ? 0 : g >= 1 ? 1 : g;
}

// ---------------------------------------------------------------- chunked mixdown plan (C22)

export interface ChunkWindow {
  index: number;
  /** emitted frames [f0, f1) */
  f0: number;
  f1: number;
  /** rendered frames [w0, w1): pre-roll before f0 (compressor / limiter state converges) + cross-fade tail after f1 */
  w0: number;
  w1: number;
}

export function planChunks(total: number, chunk: number, pre: number, xf: number): ChunkWindow[] {
  if (!(chunk > 0)) throw new RangeError('planChunks: chunk must be > 0');
  const out: ChunkWindow[] = [];
  for (let f0 = 0, i = 0; f0 < total; f0 += chunk, i++) {
    const f1 = Math.min(total, f0 + chunk);
    out.push({ index: i, f0, f1, w0: Math.max(0, f0 - pre), w1: f1 < total ? Math.min(total, f1 + xf) : f1 });
  }
  return out;
}

/**
 * Joins independently rendered windows into one continuous stream: each window's head [f0, f0 + xf) is
 * linearly cross-faded with the previous window's tail rendering of the same frames. Identical content
 * (the normal case) passes through unchanged; residual state differences are smoothed instead of clicking.
 */
export class SeamStitcher {
  private tail: Float32Array[] | null = null;
  constructor(readonly channels: number) {}

  stitch(w: ChunkWindow, rendered: readonly Float32Array[]): Float32Array[] {
    const n = w.f1 - w.f0;
    const off = w.f0 - w.w0;
    const out: Float32Array[] = [];
    for (let c = 0; c < this.channels; c++) {
      const src = rendered[c] ?? rendered[0];
      if (!src || src.length < w.w1 - w.w0) throw new RangeError('SeamStitcher: rendered window too short');
      const o = src.slice(off, off + n);
      const tail = this.tail?.[c];
      if (tail && w.f0 > 0) {
        const L = Math.min(tail.length, n);
        for (let i = 0; i < L; i++) {
          const k = (i + 0.5) / L;
          o[i] = tail[i]! * (1 - k) + o[i]! * k;
        }
      }
      out.push(o);
    }
    const tl = w.w1 - w.f1;
    this.tail = tl > 0 ? Array.from({ length: this.channels }, (_, c) => (rendered[c] ?? rendered[0]!).slice(w.f1 - w.w0, w.w1 - w.w0)) : null;
    return out;
  }
}
