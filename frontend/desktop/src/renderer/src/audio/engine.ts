/**
 * Audio graph (plan §6.13, Phase 9): mic / system / device tracks → track gain (0–300 %) × per-clip gain →
 * master → limiter; music with trim, loop, fades and range (OUTPUT time); click sounds; optional ducking.
 * Preview: media elements + WebAudio. Export: the same decisions (mixModel.ts) rendered with
 * OfflineAudioContext in ~30 s windows (C22) that overlap and are seam-stitched, so an hour-long project
 * never needs one giant buffer.
 *
 * Preview ≡ export (B14 / B11): both read the ONE analysis of the mic file that actually plays —
 * loudness-normalisation curve (≈ −16 LUFS) and the voice-activity ducking envelope — and both clamp the
 * music range to the edited duration, so fades and ducking land on the same frames.
 */
import { clicksToOutput, consoleSink, createLogger, outToSrc, outputDuration, type ClickEvent, type Clip, type Project, type Telemetry } from '@rec/shared';
import { mediaUrl, syncElement } from '../editor/media';
import { sampleCurve, type GainCurve, type TrackAnalysis } from './analysis';
import { loadAnalysis, requestAnalysis } from './analysisStore';
import { CLICK_SOUNDS, synthClick } from './clickSounds';
import {
  balanceFor,
  clipPieces,
  duckFor,
  MAX_AUDIBLE_SPEED,
  musicEnd,
  musicGainAt,
  musicGainWithEnd,
  musicPosAt,
  musicSegments,
  pieceEnvelope,
  planChunks,
  SeamStitcher,
  TRACK_KEYS,
  trackFile,
  trackGain,
  type ChunkWindow,
  type ClipPiece,
  type TrackKey,
} from './mixModel';
import { openPcmReader, type PcmReader } from './trackReader';
import { wsolaFrames, wsolaInputRange, wsolaParams, wsolaProcess, wsolaStartFrame, type WsolaChain } from './wsola';

export const SAMPLE_RATE = 48000;
export { trackFile, musicGainAt, musicPosAt };

const log = createLogger('renderer.audio.engine', consoleSink);

/** Brick-wall-ish master limiter; identical in preview and export. */
function createLimiter(ctx: BaseAudioContext): DynamicsCompressorNode {
  const l = ctx.createDynamicsCompressor();
  l.threshold.value = -1;
  l.knee.value = 0;
  l.ratio.value = 20;
  l.attack.value = 0.003;
  l.release.value = 0.1;
  return l;
}

// ---------------------------------------------------------------- preview

type VoiceKey = TrackKey | 'micRaw' | 'music';
interface Voice {
  el: HTMLAudioElement;
  node: MediaElementAudioSourceNode;
  gain: GainNode;
  url: string;
}

export class PreviewAudio {
  /** The editor's live preview graph (meters / A-B compare reach it without prop drilling). */
  static active: PreviewAudio | null = null;
  private static revisions = new Map<string, number>();

  /** Re-open a bundle file whose content changed on disk (e.g. re-run vocal enhancement keeps the name). */
  static reloadFile(file: string): void {
    PreviewAudio.revisions.set(file, (PreviewAudio.revisions.get(file) ?? 0) + 1);
    const a = PreviewAudio.active;
    if (a) a.rebuild(a.project, a.denoised);
  }

  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly analyser: AnalyserNode;
  private readonly analyserL: AnalyserNode;
  private readonly analyserR: AnalyserNode;
  private readonly bufL = new Float32Array(1024);
  private readonly bufR = new Float32Array(1024);
  private readonly lv = new Float32Array(4);
  private voices = new Map<VoiceKey, Voice>();
  private clickBuffers = new Map<string, AudioBuffer>();
  private clickMemo: { clips: readonly Clip[]; clicks: readonly ClickEvent[]; times: Float64Array } | null = null;
  private lastT = 0;
  private compare = false;
  private micA: TrackAnalysis | null = null;
  private micAFile: string | undefined;
  private micAPolled = 0;

  constructor(private project: Project, private mediaBase: string, private denoised: boolean) {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    const limiter = createLimiter(this.ctx);
    this.master.connect(limiter).connect(this.ctx.destination);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    limiter.connect(this.analyser);
    // explicit stereo up-mix so a mono-only mix still meters on both sides
    const stereo = this.ctx.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = 'explicit';
    stereo.channelInterpretation = 'speakers';
    const split = this.ctx.createChannelSplitter(2);
    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    this.analyserL.fftSize = this.analyserR.fftSize = 1024;
    limiter.connect(stereo).connect(split);
    split.connect(this.analyserL, 0);
    split.connect(this.analyserR, 1);
    PreviewAudio.active = this;
    this.rebuild(project, denoised);
  }

  private urlFor(file: string): string {
    const rev = PreviewAudio.revisions.get(file);
    return rev ? `${mediaUrl(this.mediaBase, file)}?r=${rev}` : mediaUrl(this.mediaBase, file);
  }

  private makeVoice(file: string): Voice {
    const url = this.urlFor(file);
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = url;
    (el as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch = true;
    const node = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0; // first tick sets the real value → no blip
    node.connect(gain).connect(this.master);
    return { el, node, gain, url };
  }

  private dropVoice(k: VoiceKey): void {
    const v = this.voices.get(k);
    if (!v) return;
    v.el.pause();
    v.el.removeAttribute('src');
    v.el.load();
    v.node.disconnect();
    v.gain.disconnect();
    this.voices.delete(k);
  }

  rebuild(project: Project, denoised = this.denoised): void {
    this.project = project;
    this.denoised = denoised;
    const want = new Map<VoiceKey, string>();
    for (const k of TRACK_KEYS) {
      const f = trackFile(project, k, denoised);
      if (f) want.set(k, f);
    }
    // A/B compare (B8): keep the unprocessed mic warm when the played one is denoised / enhanced
    const raw = project.source.tracks.mic;
    const played = want.get('mic');
    if (raw && played && played !== raw) want.set('micRaw', raw);
    if (project.music) want.set('music', project.music.file);
    for (const [k, v] of [...this.voices]) {
      const f = want.get(k);
      if (!f || this.urlFor(f) !== v.url) this.dropVoice(k);
    }
    for (const [k, f] of want) if (!this.voices.has(k)) this.voices.set(k, this.makeVoice(f));
    if (this.micAFile !== played) {
      this.micA = null;
      this.micAFile = played;
      this.micAPolled = 0;
    }
    const cs = project.cursor.clickSound;
    if (cs.enabled && !this.clickBuffers.has(cs.soundId)) this.clickBuffers.set(cs.soundId, synthClick(this.ctx, cs.soundId));
  }

  /** Mic analysis for balance / ducking, polled at most 4×/s until ready (no per-frame allocation once loaded). */
  private micAnalysis(p: Project): TrackAnalysis | null {
    if (this.micA || !this.micAFile || !(p.audio.mic.balance || p.audio.ducking)) return this.micA;
    const now = performance.now();
    if (now - this.micAPolled > 250) {
      this.micAPolled = now;
      this.micA = requestAnalysis({ mediaBase: this.mediaBase, file: this.micAFile });
    }
    return this.micA;
  }

  private clickTimes(p: Project, telemetry: Telemetry): Float64Array {
    const m = this.clickMemo;
    if (m && m.clips === p.clips && m.clicks === telemetry.clicks) return m.times;
    const times = Float64Array.from(clicksToOutput(telemetry.clicks, p.clips), (c) => c.tOut);
    this.clickMemo = { clips: p.clips, clicks: telemetry.clicks, times };
    return times;
  }

  /** Called every animation frame with the output time. */
  tick(t: number, playing: boolean, telemetry: Telemetry): void {
    const p = this.project;
    if (playing && this.ctx.state === 'suspended') void this.ctx.resume();
    const now = this.ctx.currentTime;
    const { src, clip } = outToSrc(p.clips, t);
    const fast = clip.speed > MAX_AUDIBLE_SPEED; // > 2× → muted (pitch-preserving stretch up to 2×)
    const micA = this.micAnalysis(p);
    for (const k of TRACK_KEYS) {
      const v = this.voices.get(k);
      if (!v) continue;
      const fileT = src - (p.source.trackOffsets[k] ?? 0);
      let vol = fast ? 0 : trackGain(p, k) * clip.volume[k];
      if (k === 'mic') {
        if (vol > 0 && p.audio.mic.balance && micA) vol *= sampleCurve(balanceFor(micA).curve, fileT);
        const raw = this.voices.get('micRaw');
        if (raw) {
          raw.gain.gain.setTargetAtTime(this.compare ? vol : 0, now, 0.01);
          syncElement(raw.el, fileT, playing, clip.speed, 0.08);
          if (this.compare) vol = 0;
        }
      }
      v.gain.gain.setTargetAtTime(vol, now, 0.01);
      syncElement(v.el, fileT, playing, clip.speed, 0.08);
    }
    const mv = this.voices.get('music');
    if (mv) {
      const pos = musicPosAt(p, t);
      let gain = musicGainAt(p, t);
      if (gain > 0) {
        const duck = duckFor(p, micA);
        if (duck) gain *= sampleCurve(duck, t);
      }
      mv.gain.gain.setTargetAtTime(pos === null ? 0 : gain, now, 0.02);
      if (pos === null) {
        if (!mv.el.paused) mv.el.pause();
      } else syncElement(mv.el, pos, playing, 1, 0.15);
    }
    // click sounds when the playhead crosses a click (sorted output times → binary search)
    const cs = p.cursor.clickSound;
    if (playing && cs.enabled && t > this.lastT && t - this.lastT < 0.5) {
      const buf = this.clickBuffers.get(cs.soundId);
      const times = buf ? this.clickTimes(p, telemetry) : null;
      if (buf && times && times.length) {
        let lo = 0, hi = times.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (times[mid]! <= this.lastT) lo = mid + 1;
          else hi = mid;
        }
        for (let i = lo; i < times.length && times[i]! <= t; i++) {
          const s = this.ctx.createBufferSource();
          const g = this.ctx.createGain();
          g.gain.value = cs.volume;
          s.buffer = buf;
          s.connect(g).connect(this.master);
          s.start();
        }
      }
    }
    this.lastT = t;
  }

  /** Hold-to-compare: hear the unprocessed mic instead of the denoised / enhanced one. */
  setCompare(on: boolean): void {
    this.compare = on;
  }
  get canCompare(): boolean {
    return this.voices.has('micRaw');
  }

  /** Post-limiter levels without allocation: out = [peakL, peakR, rmsL, rmsR] (linear). */
  levels(out: Float32Array): void {
    this.analyserL.getFloatTimeDomainData(this.bufL);
    this.analyserR.getFloatTimeDomainData(this.bufR);
    const a = this.bufL, b = this.bufR, n = a.length;
    let pl = 0, pr = 0, sl = 0, sr = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i]!, y = b[i]!;
      const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
      if (ax > pl) pl = ax;
      if (ay > pr) pr = ay;
      sl += x * x;
      sr += y * y;
    }
    out[0] = pl;
    out[1] = pr;
    out[2] = Math.sqrt(sl / n);
    out[3] = Math.sqrt(sr / n);
  }

  /** Peak level of the master output (0…1+). */
  level(): number {
    this.levels(this.lv);
    return Math.max(this.lv[0]!, this.lv[1]!);
  }

  pauseAll(): void {
    for (const v of this.voices.values()) v.el.pause();
  }

  dispose(): void {
    this.pauseAll();
    for (const k of [...this.voices.keys()]) this.dropVoice(k);
    if (PreviewAudio.active === this) PreviewAudio.active = null;
    void this.ctx.close();
  }
}

// ---------------------------------------------------------------- export mixdown (chunked)

export interface MixOptions {
  mediaBase: string;
  denoised: boolean;
  telemetry: Telemetry;
  /** bundle dir → reuse the cached mic analysis (balance / ducking) instead of re-analysing */
  dir?: string;
  onProgress?: (p: number) => void;
  /** seconds rendered per OfflineAudioContext (default 30) */
  chunkSec?: number;
  signal?: AbortSignal;
}

const PRE_ROLL_SEC = 1; // limiter state converges before the emitted part of a window
const SEAM_XF_FRAMES = 2400; // 50 ms seam cross-fade (identical content passes through unchanged)
const timeToFrame = (t: number, sr: number) => Math.ceil(t * sr - 1e-7);

interface Rendered {
  planes: Float32Array[];
  rate: number;
  /** output time of planes[·][0] */
  at: number;
}

/** One clip × track inside a window: sample-exact slice (speed 1) or a continued WSOLA chain (speed ≠ 1). */
async function voicePiece(
  reader: PcmReader,
  piece: ClipPiece,
  key: TrackKey,
  offset: number,
  vol: number,
  balance: GainCurve | null,
  t0: number,
  t1: number,
  next: ChunkWindow | undefined,
  chains: Map<string, WsolaChain>,
): Promise<Rendered | null> {
  const clip = piece.clip;
  const sr = reader.sampleRate;
  const fs = clip.srcStart - offset; // file time at the clip's output start
  const clipF0 = timeToFrame(fs, sr);
  const clipF1 = timeToFrame(clip.srcEnd - offset, sr);
  const a = Math.max(piece.outStart, t0), b = Math.min(piece.outEnd, t1);
  if (!(b > a) || clipF1 <= clipF0) return null;
  const applyBalance = (planes: Float32Array[], firstFrame: number) => {
    if (!balance) return;
    const n = planes[0]!.length;
    for (let i = 0; i < n; i++) {
      const g = sampleCurve(balance, (firstFrame + i) / sr);
      for (const pl of planes) pl[i] = pl[i]! * g;
    }
  };
  if (clip.speed === 1) {
    const j0 = Math.max(clipF0, timeToFrame(fs + (a - piece.outStart), sr));
    const j1 = Math.min(clipF1, timeToFrame(fs + (b - piece.outStart), sr) + 1);
    if (j1 - j0 < 2) return null;
    const planes = await reader.readFrames(j0, j1 - j0);
    applyBalance(planes, j0);
    const at = piece.outStart + (j0 / sr - fs);
    for (let i = 0; i < j1 - j0; i++) {
      const g = vol * pieceEnvelope(piece, at + i / sr);
      for (const pl of planes) pl[i] = pl[i]! * g;
    }
    return { planes, rate: sr, at };
  }
  // speed ≠ 1: pitch-preserving WSOLA, chain state handed from window to window (bit-identical overlap)
  const p = wsolaParams(sr);
  const inLen = clipF1 - clipF0;
  const outLen = Math.max(1, Math.round(inLen / clip.speed));
  const o0 = Math.max(0, Math.floor((a - piece.outStart) * sr));
  const o1 = Math.min(outLen, Math.ceil((b - piece.outStart) * sr) + 1);
  if (o1 - o0 < 2) return null;
  const chainKey = `${clip.id}:${key}`;
  const chain = chains.get(chainKey) ?? null;
  const mStart = wsolaStartFrame(o0, o1, p, chain);
  const [i0, i1] = wsolaInputRange(mStart, wsolaFrames(o0, o1, p)[1], clip.speed, p, inLen);
  const input = await reader.readFrames(clipF0 + i0, Math.max(0, i1 - i0));
  applyBalance(input, clipF0 + i0);
  let captureM = -1;
  if (next) {
    const n0 = Math.floor((next.w0 / SAMPLE_RATE - piece.outStart) * sr);
    if (n0 > 0 && n0 < outLen) captureM = wsolaFrames(n0, n0 + 1, p)[0];
  }
  const { out, captured } = wsolaProcess(input, i0, inLen, clip.speed, p, o0, o1, chain, captureM);
  if (captured) chains.set(chainKey, captured);
  const at = piece.outStart + o0 / sr;
  for (let i = 0; i < o1 - o0; i++) {
    const g = vol * pieceEnvelope(piece, at + i / sr);
    for (const pl of out) pl[i] = pl[i]! * g;
  }
  return { planes: out, rate: sr, at };
}

/**
 * Render the final stereo mix as consecutive AudioBuffers (≈ chunkSec each, 48 kHz). Each window is
 * rendered with 1 s pre-roll + 50 ms tail and seam-stitched to the previous one; fades, ducking and
 * balance are evaluated per frame from absolute output time, so chunking never changes the result.
 * Memory is bounded by one window regardless of project length.
 */
export async function* mixChunks(project: Project, opts: MixOptions): AsyncGenerator<AudioBuffer, void, undefined> {
  const started = performance.now();
  const duration = outputDuration(project.clips);
  const total = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  const windows = planChunks(total, Math.max(SAMPLE_RATE, Math.round((opts.chunkSec ?? 30) * SAMPLE_RATE)), PRE_ROLL_SEC * SAMPLE_RATE, SEAM_XF_FRAMES);
  const readers = new Map<TrackKey, PcmReader>();
  let musicReader: PcmReader | null = null;
  try {
    for (const k of TRACK_KEYS) {
      const f = trackFile(project, k, opts.denoised);
      if (!f || trackGain(project, k) === 0) continue;
      const r = await openPcmReader(mediaUrl(opts.mediaBase, f));
      if (r) readers.set(k, r);
      else log.warn('mix.track_unavailable', { track: k, file: f });
    }
    const micFile = trackFile(project, 'mic', opts.denoised);
    const wantMicAnalysis = !!micFile && ((project.audio.mic.balance && readers.has('mic')) || (project.audio.ducking && !!project.music));
    const micA = wantMicAnalysis ? await loadAnalysis({ mediaBase: opts.mediaBase, file: micFile!, ...(opts.dir ? { dir: opts.dir } : {}) }) : null;
    if (wantMicAnalysis && !micA) log.warn('mix.mic_analysis_unavailable', { file: micFile });
    const balance = project.audio.mic.balance && micA ? balanceFor(micA).curve : null;
    const duck = duckFor(project, micA);
    const m = project.music;
    if (m && m.volume > 0) {
      musicReader = await openPcmReader(mediaUrl(opts.mediaBase, m.file));
      if (!musicReader) log.warn('mix.music_unavailable', { file: m.file });
    }
    const mEnd = musicEnd(project);
    const cs = project.cursor.clickSound;
    const clicks = cs.enabled && project.source.hasTelemetry ? clicksToOutput(opts.telemetry.clicks, project.clips).map((c) => c.tOut) : [];
    let clickIdx = 0;
    const stitcher = new SeamStitcher(2);
    const chains = new Map<string, WsolaChain>();

    for (let wi = 0; wi < windows.length; wi++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const w = windows[wi]!;
      const next = windows[wi + 1];
      const t0 = w.w0 / SAMPLE_RATE, t1 = w.w1 / SAMPLE_RATE;
      const ctx = new OfflineAudioContext(2, Math.max(1, w.w1 - w.w0), SAMPLE_RATE);
      const master = ctx.createGain();
      master.connect(createLimiter(ctx)).connect(ctx.destination);
      const schedule = (r: Rendered | null) => {
        const n = r?.planes[0]?.length ?? 0;
        if (!r || n < 2) return;
        const buf = ctx.createBuffer(r.planes.length, n, r.rate);
        r.planes.forEach((pl, c) => buf.getChannelData(c).set(pl));
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.connect(master);
        const rel = r.at - t0;
        if (rel >= 0) s.start(rel);
        else s.start(0, -rel);
      };
      // decode jobs: files in parallel, sequential within one file (bounded memory, one decoder per file)
      const jobs: Array<Promise<Rendered | null>> = [];
      const lanes = new Map<PcmReader, Promise<unknown>>();
      const enqueue = (r: PcmReader, f: () => Promise<Rendered | null>) => {
        // a single undecodable range must not fail a long export at the very end → that piece stays silent
        const run = (lanes.get(r) ?? Promise.resolve()).then(f).catch((e: unknown) => {
          log.error('mix.piece_failed', e, { window: wi, t0: Math.round(t0 * 1000) / 1000 });
          return null;
        });
        lanes.set(r, run);
        jobs.push(run);
      };
      for (const piece of clipPieces(project.clips, t0, t1)) {
        if (piece.clip.speed > MAX_AUDIBLE_SPEED) continue;
        for (const [k, reader] of readers) {
          const vol = trackGain(project, k) * piece.clip.volume[k];
          if (vol <= 0) continue;
          enqueue(reader, () => voicePiece(reader, piece, k, project.source.trackOffsets[k] ?? 0, vol, k === 'mic' ? balance : null, t0, t1, next, chains));
        }
      }
      // music: trim / loop / range in output time; fades × ducking evaluated per frame
      if (musicReader && m) {
        const mr = musicReader;
        for (const seg of musicSegments(project, t0, t1)) {
          enqueue(mr, async () => {
            const sr = mr.sampleRate;
            const j0 = Math.floor(seg.fileStart * sr);
            const at = seg.outStart + (j0 / sr - seg.fileStart);
            const n = Math.ceil((seg.outEnd - at) * sr - 1e-7);
            if (n < 2) return null;
            const planes = await mr.readFrames(j0, n);
            for (let i = 0; i < n; i++) {
              const t = at + i / sr;
              const g = musicGainWithEnd(m, mEnd, t) * (duck ? sampleCurve(duck, t) : 1);
              for (const pl of planes) pl[i] = pl[i]! * g;
            }
            return { planes, rate: sr, at };
          });
        }
      }
      for (const r of await Promise.all(jobs)) schedule(r);
      // click sounds (≤ 90 ms each; a click started just before the window still sounds into it)
      if (clicks.length) {
        while (clickIdx < clicks.length && clicks[clickIdx]! < t0 - 0.1) clickIdx++;
        const cb = synthClick(ctx, cs.soundId);
        for (let i = clickIdx; i < clicks.length && clicks[i]! < t1; i++) {
          const s = ctx.createBufferSource();
          s.buffer = cb;
          const g = ctx.createGain();
          g.gain.value = cs.volume;
          s.connect(g).connect(master);
          const rel = clicks[i]! - t0;
          if (rel >= 0) s.start(rel);
          else if (-rel < cb.duration) s.start(0, -rel);
        }
      }
      const rendered = await ctx.startRendering();
      const out = stitcher.stitch(w, [rendered.getChannelData(0), rendered.getChannelData(1)]);
      const ab = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, out[0]!.length), sampleRate: SAMPLE_RATE });
      ab.getChannelData(0).set(out[0]!);
      ab.getChannelData(1).set(out[1]!);
      opts.onProgress?.((wi + 1) / windows.length);
      yield ab;
    }
    log.info('mix.done', { duration_s: Math.round(duration), chunks: windows.length, latency_ms: Math.round(performance.now() - started), balance: !!balance, ducking: !!duck });
  } finally {
    for (const r of readers.values()) r.dispose();
    musicReader?.dispose();
  }
}

/** Whole mix in one AudioBuffer (short projects / callers that need random access). */
export async function renderMix(project: Project, opts: MixOptions): Promise<AudioBuffer> {
  const parts: AudioBuffer[] = [];
  let total = 0;
  for await (const b of mixChunks(project, opts)) {
    parts.push(b);
    total += b.length;
  }
  const out = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, total), sampleRate: SAMPLE_RATE });
  let o = 0;
  for (const b of parts) {
    for (let c = 0; c < 2; c++) out.getChannelData(c).set(b.getChannelData(c), o);
    o += b.length;
  }
  return out;
}

export { CLICK_SOUNDS };
