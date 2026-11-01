/**
 * Track analysis (audit B1 / B11 / B14). ONE streaming pass over a decoded audio file yields:
 *  - a multi-resolution min/max peak pyramid (timeline waveforms; 64-frame base blocks, ×4 per level),
 *  - a 10 ms RMS envelope of the mono mix (voice activity → music ducking),
 *  - 100 ms K-weighted energy blocks (ITU-R BS.1770-4 loudness → smart volume balancing).
 * Pure and allocation-bounded: O(n) time, O(n / 64) memory, and bit-identical results however the
 * input is split into blocks (the decoder hands us arbitrary chunk sizes).
 */

export const ANALYSIS_VERSION = 1;
/** frames per level-0 peak block (≈ 1.3 ms at 48 kHz → crisp even at the max timeline zoom) */
export const PEAK_BLOCK = 64;
export const PEAK_FACTOR = 4;
export const PEAK_LEVELS = 6;
const ENV_SEC = 0.01;
const LOUD_SEC = 0.1;
/** loudness target of "Smart volume balancing" (podcast / YouTube voice standard) */
export const TARGET_LUFS = -16;

export interface PeakLevel {
  /** frames per entry */
  block: number;
  count: number;
  /** interleaved [min, max] per block, companded: q = sign(v)·round(127·√|v|) */
  data: Int8Array;
}

export interface TrackAnalysis {
  version: number;
  sampleRate: number;
  channels: number;
  frames: number;
  duration: number;
  peaks: PeakLevel[];
  /** max |sample| of the mono mix (linear) */
  peakMax: number;
  /** seconds per envelope value (exactly envFrames / sampleRate) */
  envHop: number;
  /** RMS of the mono mix per hop, dBFS (≥ −120) */
  env: Float32Array;
  /** seconds per loudness sub-block */
  loudHop: number;
  /** K-weighted mean-square energy per sub-block, summed over the channels as played in stereo */
  loud: Float32Array;
  /** BS.1770 gated integrated loudness of the file, LUFS (−70 when silent) */
  integratedLufs: number;
  /** byte size of the analysed file (cache validation) */
  sourceBytes: number;
}

/** A gain (or any) curve sampled every `hop` seconds, value i at time start + i·hop. */
export interface GainCurve {
  start: number;
  hop: number;
  values: Float32Array;
}

/** Linear interpolation into a sampled curve; clamps to the end values. O(1). */
export function sampleCurve(c: GainCurve, t: number): number {
  const n = c.values.length;
  if (n === 0) return 1;
  const x = (t - c.start) / c.hop;
  if (!(x > 0)) return c.values[0]!;
  if (x >= n - 1) return c.values[n - 1]!;
  const i = Math.floor(x);
  const f = x - i;
  return c.values[i]! * (1 - f) + c.values[i + 1]! * f;
}

export const compand = (v: number): number => {
  const a = Math.round(Math.sqrt(Math.min(1, Math.abs(v))) * 127);
  return v < 0 ? -a : a;
};

// ---------------------------------------------------------------- K-weighting (BS.1770-4)

/** Two biquads (high shelf "pre-filter" + RLB high-pass) for any sample rate (libebur128 derivation). */
export function kWeighting(sr: number): { shelf: number[]; hp: number[] } {
  // [b0, b1, b2, a1, a2] with a0 normalised to 1
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return { shelf, hp };
}

const LUFS_OFFSET = -0.691;
const energyToLufs = (z: number): number => (z > 0 ? LUFS_OFFSET + 10 * Math.log10(z) : -Infinity);

/** BS.1770-4 integrated loudness from 100 ms sub-block energies (400 ms blocks, 75 % overlap, −70/−10 gates). */
export function integratedLoudness(loud: Float32Array): number {
  const n = loud.length;
  if (n === 0) return -70;
  const nb = n >= 4 ? n - 3 : 1;
  const z = new Float64Array(nb);
  for (let j = 0; j < nb; j++) {
    const w = Math.min(4, n - j);
    let s = 0;
    for (let k = 0; k < w; k++) s += loud[j + k]!;
    z[j] = s / w;
  }
  let sum = 0, cnt = 0;
  for (let j = 0; j < nb; j++) if (energyToLufs(z[j]!) > -70) { sum += z[j]!; cnt++; }
  if (!cnt) return -70;
  const rel = energyToLufs(sum / cnt) - 10;
  let s2 = 0, c2 = 0;
  for (let j = 0; j < nb; j++) {
    const l = energyToLufs(z[j]!);
    if (l > -70 && l > rel) { s2 += z[j]!; c2++; }
  }
  return c2 ? Math.max(-70, energyToLufs(s2 / c2)) : -70;
}

// ---------------------------------------------------------------- streaming builder

function grow<T extends Int8Array | Float32Array>(a: T, need: number): T {
  if (need <= a.length) return a;
  const b = new (a.constructor as new (n: number) => T)(Math.max(need, a.length * 2));
  b.set(a);
  return b;
}

export class AnalysisBuilder {
  readonly envFrames: number;
  readonly loudFrames: number;
  private frames = 0;
  // level-0 peaks
  private peaks = new Int8Array(1 << 14);
  private nBlocks = 0;
  private bN = 0;
  private bMin = Infinity;
  private bMax = -Infinity;
  private peakMax = 0;
  // RMS envelope
  private env = new Float32Array(1 << 12);
  private nEnv = 0;
  private eN = 0;
  private eAcc = 0;
  // loudness
  private loud = new Float32Array(1 << 10);
  private nLoud = 0;
  private lN = 0;
  private lAcc = 0;
  private readonly kw: { shelf: number[]; hp: number[] };
  /** per channel: [shelf s1, shelf s2, hp s1, hp s2] (transposed direct form II) */
  private readonly st: Float64Array;
  private readonly monoWeight: number;

  constructor(readonly sampleRate: number, readonly channels: number) {
    if (!(sampleRate > 0) || !(channels > 0)) throw new RangeError('AnalysisBuilder: bad format');
    this.envFrames = Math.max(1, Math.round(sampleRate * ENV_SEC));
    this.loudFrames = Math.max(1, Math.round(sampleRate * LOUD_SEC));
    this.kw = kWeighting(sampleRate);
    this.st = new Float64Array(4 * channels);
    // a mono file is up-mixed to both speakers when played → counts twice in the stereo loudness sum
    this.monoWeight = channels === 1 ? 2 : 1;
  }

  /** Feed `frames` frames of planar float PCM (any block size). */
  push(planes: readonly Float32Array[], frames: number): void {
    const C = this.channels;
    if (frames <= 0) return;
    const first = planes[0];
    if (!first || first.length < frames) throw new RangeError('AnalysisBuilder.push: short plane');
    // missing planes (decoder delivered fewer channels) repeat the first one
    const ps: Float32Array[] = [];
    for (let c = 0; c < C; c++) ps.push(planes[c] && planes[c]!.length >= frames ? planes[c]! : first);
    const [sb0, sb1, sb2, sa1, sa2] = this.kw.shelf as [number, number, number, number, number];
    const [hb0, hb1, hb2, ha1, ha2] = this.kw.hp as [number, number, number, number, number];
    const st = this.st;
    const envFrames = this.envFrames, loudFrames = this.loudFrames;
    const invC = 1 / C;
    let bN = this.bN, bMin = this.bMin, bMax = this.bMax, peakMax = this.peakMax;
    let eN = this.eN, eAcc = this.eAcc, lN = this.lN, lAcc = this.lAcc;
    for (let i = 0; i < frames; i++) {
      let mono = 0;
      let kSum = 0;
      for (let c = 0; c < C; c++) {
        const x = ps[c]![i]!;
        mono += x;
        const o = c * 4;
        // pre-filter (high shelf)
        const y1 = sb0 * x + st[o]!;
        st[o] = sb1 * x - sa1 * y1 + st[o + 1]!;
        st[o + 1] = sb2 * x - sa2 * y1;
        // RLB high-pass
        const y2 = hb0 * y1 + st[o + 2]!;
        st[o + 2] = hb1 * y1 - ha1 * y2 + st[o + 3]!;
        st[o + 3] = hb2 * y1 - ha2 * y2;
        kSum += y2 * y2;
      }
      mono *= invC;
      if (mono < bMin) bMin = mono;
      if (mono > bMax) bMax = mono;
      if (++bN === PEAK_BLOCK) {
        this.pushBlock(bMin, bMax);
        const a = Math.max(-bMin, bMax);
        if (a > peakMax) peakMax = a;
        bN = 0; bMin = Infinity; bMax = -Infinity;
      }
      eAcc += mono * mono;
      if (++eN === envFrames) {
        this.pushEnv(eAcc / eN);
        eN = 0; eAcc = 0;
      }
      lAcc += kSum;
      if (++lN === loudFrames) {
        this.pushLoud((lAcc / lN) * this.monoWeight);
        lN = 0; lAcc = 0;
        // flush denormals during long silences (x86 denormal arithmetic is ~100× slower)
        for (let k = 0; k < st.length; k++) if (Math.abs(st[k]!) < 1e-25) st[k] = 0;
      }
    }
    this.bN = bN; this.bMin = bMin; this.bMax = bMax; this.peakMax = peakMax;
    this.eN = eN; this.eAcc = eAcc; this.lN = lN; this.lAcc = lAcc;
    this.frames += frames;
  }

  /** Feed silence (gaps between decoded packets). */
  pushSilence(frames: number): void {
    if (frames <= 0) return;
    const z = new Float32Array(Math.min(frames, 1 << 15));
    const planes = Array.from({ length: this.channels }, () => z);
    for (let left = frames; left > 0; left -= z.length) this.push(planes, Math.min(left, z.length));
  }

  private pushBlock(mn: number, mx: number): void {
    this.peaks = grow(this.peaks, (this.nBlocks + 1) * 2);
    this.peaks[this.nBlocks * 2] = compand(mn);
    this.peaks[this.nBlocks * 2 + 1] = compand(mx);
    this.nBlocks++;
  }
  private pushEnv(meanSq: number): void {
    this.env = grow(this.env, this.nEnv + 1);
    this.env[this.nEnv++] = Math.max(-120, 10 * Math.log10(meanSq + 1e-12));
  }
  private pushLoud(e: number): void {
    this.loud = grow(this.loud, this.nLoud + 1);
    this.loud[this.nLoud++] = e;
  }

  finish(sourceBytes = 0): TrackAnalysis {
    if (this.bN > 0) {
      this.pushBlock(this.bMin, this.bMax);
      this.peakMax = Math.max(this.peakMax, -this.bMin, this.bMax);
      this.bN = 0;
    }
    if (this.eN > 0) { this.pushEnv(this.eAcc / this.eN); this.eN = 0; }
    if (this.lN > 0) { this.pushLoud((this.lAcc / this.lN) * this.monoWeight); this.lN = 0; }
    const levels: PeakLevel[] = [{ block: PEAK_BLOCK, count: this.nBlocks, data: this.peaks.slice(0, this.nBlocks * 2) }];
    for (let l = 1; l < PEAK_LEVELS; l++) levels.push(reduceLevel(levels[l - 1]!));
    const loud = this.loud.slice(0, this.nLoud);
    return {
      version: ANALYSIS_VERSION,
      sampleRate: this.sampleRate,
      channels: this.channels,
      frames: this.frames,
      duration: this.frames / this.sampleRate,
      peaks: levels,
      peakMax: this.peakMax,
      envHop: this.envFrames / this.sampleRate,
      env: this.env.slice(0, this.nEnv),
      loudHop: this.loudFrames / this.sampleRate,
      loud,
      integratedLufs: integratedLoudness(loud),
      sourceBytes,
    };
  }
}

function reduceLevel(prev: PeakLevel): PeakLevel {
  const count = Math.ceil(prev.count / PEAK_FACTOR);
  const data = new Int8Array(count * 2);
  const src = prev.data;
  for (let i = 0; i < count; i++) {
    let mn = 127, mx = -127;
    const end = Math.min(prev.count, (i + 1) * PEAK_FACTOR);
    for (let j = i * PEAK_FACTOR; j < end; j++) {
      const a = src[j * 2]!, b = src[j * 2 + 1]!;
      if (a < mn) mn = a;
      if (b > mx) mx = b;
    }
    data[i * 2] = mn;
    data[i * 2 + 1] = mx;
  }
  return { block: prev.block * PEAK_FACTOR, count, data };
}

/** Convenience for tests / small buffers. */
export function analysePcm(planes: readonly Float32Array[], sampleRate: number, sourceBytes = 0): TrackAnalysis {
  const b = new AnalysisBuilder(sampleRate, planes.length);
  b.push(planes, planes[0]?.length ?? 0);
  return b.finish(sourceBytes);
}

// ---------------------------------------------------------------- peak queries (timeline drawing)

/**
 * Companded [min, max] over file time [t0, t1) into out[0..1] (no allocation). Picks the coarsest level
 * whose block still fits the span, so a query touches ≤ ~2·PEAK_FACTOR entries → O(1) per pixel column.
 * Returns false when the span is outside the file.
 */
export function peakSpan(a: TrackAnalysis, t0: number, t1: number, out: Float32Array | number[]): boolean {
  const f0 = t0 * a.sampleRate;
  const f1 = Math.max(f0 + 1, t1 * a.sampleRate);
  if (f1 <= 0 || f0 >= a.frames || a.peaks.length === 0) return false;
  const span = f1 - f0;
  let lv = a.peaks[0]!;
  for (let l = a.peaks.length - 1; l >= 0; l--) {
    if (a.peaks[l]!.block <= span) { lv = a.peaks[l]!; break; }
  }
  const i0 = Math.max(0, Math.floor(f0 / lv.block));
  const i1 = Math.min(lv.count, Math.max(i0 + 1, Math.ceil(f1 / lv.block)));
  if (i0 >= i1) return false;
  let mn = 127, mx = -127;
  const d = lv.data;
  for (let i = i0; i < i1; i++) {
    const lo = d[i * 2]!, hi = d[i * 2 + 1]!;
    if (lo < mn) mn = lo;
    if (hi > mx) mx = hi;
  }
  out[0] = mn / 127;
  out[1] = mx / 127;
  return true;
}

// ---------------------------------------------------------------- loudness normalisation / levelling

export interface BalanceInfo {
  /** gain (linear) over FILE time of the analysed track */
  curve: GainCurve;
  measuredLufs: number;
  /** static normalisation gain toward the target, dB */
  normDb: number;
  targetLufs: number;
}

/**
 * Smart volume balancing (B11): static gain that brings the integrated loudness to `target` (≈ −16 LUFS),
 * plus a gentle zero-phase leveller (½ of the short-term deviation, ±6 dB) so quiet and loud passages even
 * out. Short-term loudness is measured over VOICED blocks only (same detector as ducking), and pauses hold
 * the last correction, so the noise floor is never pumped up. Deterministic → preview and export apply the
 * identical curve.
 */
export function balanceCurve(a: Pick<TrackAnalysis, 'loud' | 'loudHop' | 'integratedLufs' | 'env' | 'envHop'>, target = TARGET_LUFS): BalanceInfo {
  const n = a.loud.length;
  const measured = a.integratedLufs;
  const hop = a.loudHop;
  if (n === 0 || measured <= -69.5) {
    return { curve: { start: 0, hop, values: new Float32Array([1]) }, measuredLufs: measured, normDb: 0, targetLufs: target };
  }
  const normDb = Math.min(20, Math.max(-12, target - measured));
  // voiced flag per loudness block from the voice-activity envelope
  const vad = voiceActivity(a);
  const voiced = new Uint8Array(n);
  const ratio = hop / vad.hop;
  for (let i = 0; i < n; i++) {
    const k1 = Math.min(vad.active.length, Math.ceil((i + 1) * ratio));
    for (let k = Math.floor(i * ratio); k < k1; k++) if (vad.active[k]) { voiced[i] = 1; break; }
  }
  // centred 3 s short-term loudness of the voiced blocks via prefix sums (offline → no lag)
  const preE = new Float64Array(n + 1);
  const preN = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    preE[i + 1] = preE[i]! + (voiced[i] ? a.loud[i]! : 0);
    preN[i + 1] = preN[i]! + voiced[i]!;
  }
  const half = Math.max(1, Math.round(1.5 / hop));
  const corr = new Float64Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n, i + half);
    const cnt = preN[hi]! - preN[lo]!;
    if (voiced[i] && cnt > 0) {
      const st = energyToLufs((preE[hi]! - preE[lo]!) / cnt);
      if (Number.isFinite(st)) last = Math.min(6, Math.max(-6, 0.5 * (measured - st)));
    }
    corr[i] = last; // pauses hold the last correction → no noise-floor pumping
  }
  // zero-phase one-pole smoothing (forward + backward, τ = 0.6 s)
  const k = 1 - Math.exp(-hop / 0.6);
  for (let i = 1; i < n; i++) corr[i] = corr[i - 1]! + (corr[i]! - corr[i - 1]!) * k;
  for (let i = n - 2; i >= 0; i--) corr[i] = corr[i + 1]! + (corr[i]! - corr[i + 1]!) * k;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) values[i] = 10 ** ((normDb + corr[i]!) / 20);
  return { curve: { start: hop / 2, hop, values }, measuredLufs: measured, normDb, targetLufs: target };
}

// ---------------------------------------------------------------- voice activity (ducking source)

export interface VoiceActivity {
  hop: number;
  active: Uint8Array;
}

function percentileDb(env: Float32Array, q: number): number | null {
  const bins = new Uint32Array(241); // 0.5 dB bins over [−120, 0]
  let total = 0;
  for (let i = 0; i < env.length; i++) {
    const v = env[i]!;
    if (v <= -100) continue; // digital silence (gaps, muted segments) would bias the noise floor
    bins[Math.min(240, Math.max(0, Math.round((v + 120) * 2)))]!++;
    total++;
  }
  if (!total) return null;
  const want = q * total;
  let acc = 0;
  for (let b = 0; b < bins.length; b++) {
    acc += bins[b]!;
    if (acc >= want) return b / 2 - 120;
  }
  return 0;
}

/**
 * Voice activity from the mic's RMS envelope (B14): adaptive threshold above the noise floor
 * (15th percentile) with hysteresis, blips < 60 ms dropped, gaps < 200 ms bridged, 250 ms hangover.
 */
export function voiceActivity(a: Pick<TrackAnalysis, 'env' | 'envHop'>, o: { marginDb?: number; minOn?: number; minGap?: number; hangover?: number } = {}): VoiceActivity {
  const env = a.env, hop = a.envHop, n = env.length;
  const active = new Uint8Array(n);
  const noise = percentileDb(env, 0.15);
  const loud = percentileDb(env, 0.95);
  if (noise === null || loud === null) return { hop, active };
  let thrOn = Math.max(noise + (o.marginDb ?? 10), -50);
  if (loud - 6 > noise + 3) thrOn = Math.min(thrOn, loud - 6);
  const thrOff = thrOn - 4;
  let on = false;
  for (let i = 0; i < n; i++) {
    const v = env[i]!;
    on = on ? v > thrOff : v > thrOn;
    active[i] = on ? 1 : 0;
  }
  const minOn = Math.round((o.minOn ?? 0.06) / hop);
  const minGap = Math.round((o.minGap ?? 0.2) / hop);
  const hang = Math.round((o.hangover ?? 0.25) / hop);
  // drop blips
  for (let i = 0; i < n; ) {
    if (!active[i]) { i++; continue; }
    let j = i;
    while (j < n && active[j]) j++;
    if (j - i < minOn) active.fill(0, i, j);
    i = j;
  }
  // bridge short gaps (only between two voiced runs)
  for (let i = 0; i < n; ) {
    if (active[i]) { i++; continue; }
    let j = i;
    while (j < n && !active[j]) j++;
    if (i > 0 && j < n && j - i < minGap) active.fill(1, i, j);
    i = j;
  }
  // hangover
  if (hang > 0) {
    let until = -1;
    for (let i = 0; i < n; i++) {
      if (active[i]) until = i + hang;
      else if (i <= until) active[i] = 1;
    }
  }
  return { hop, active };
}

// ---------------------------------------------------------------- cache serialisation

const MAGIC = 0x31415752; // "RWA1" little-endian

/** Binary cache format: magic | u32 headerLen | JSON header | pad4 | f32 env | f32 loud | i8 peaks… */
export function encodeAnalysis(a: TrackAnalysis): Uint8Array {
  const header = JSON.stringify({
    v: a.version, sr: a.sampleRate, ch: a.channels, frames: a.frames, peakMax: a.peakMax, envHop: a.envHop, loudHop: a.loudHop,
    lufs: a.integratedLufs, bytes: a.sourceBytes, env: a.env.length, loud: a.loud.length, levels: a.peaks.map((l) => [l.block, l.count]),
  });
  const hb = new TextEncoder().encode(header);
  const hEnd = 8 + hb.length;
  const fOff = (hEnd + 3) & ~3;
  const pOff = fOff + (a.env.length + a.loud.length) * 4;
  const total = pOff + a.peaks.reduce((s, l) => s + l.data.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, hb.length, true);
  out.set(hb, 8);
  new Float32Array(out.buffer, fOff, a.env.length).set(a.env);
  new Float32Array(out.buffer, fOff + a.env.length * 4, a.loud.length).set(a.loud);
  let o = pOff;
  for (const l of a.peaks) {
    out.set(new Uint8Array(l.data.buffer, l.data.byteOffset, l.data.length), o);
    o += l.data.length;
  }
  return out;
}

export function decodeAnalysis(bytes: Uint8Array | null | undefined): TrackAnalysis | null {
  try {
    if (!bytes || bytes.byteLength < 12) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) return null;
    const hl = dv.getUint32(4, true);
    if (8 + hl > bytes.byteLength) return null;
    const h = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl))) as {
      v: number; sr: number; ch: number; frames: number; peakMax: number; envHop: number; loudHop: number; lufs: number; bytes: number; env: number; loud: number; levels: Array<[number, number]>;
    };
    if (h.v !== ANALYSIS_VERSION || !(h.sr > 0) || !Array.isArray(h.levels)) return null;
    const fOff = (8 + hl + 3) & ~3;
    const f32 = (off: number, n: number) => new Float32Array(bytes.slice(off, off + n * 4).buffer);
    let o = fOff + (h.env + h.loud) * 4;
    const peaks: PeakLevel[] = [];
    for (const [block, count] of h.levels) {
      if (o + count * 2 > bytes.byteLength) return null;
      peaks.push({ block, count, data: new Int8Array(bytes.slice(o, o + count * 2).buffer) });
      o += count * 2;
    }
    if (o !== bytes.byteLength) return null;
    return {
      version: h.v, sampleRate: h.sr, channels: h.ch, frames: h.frames, duration: h.frames / h.sr, peaks, peakMax: h.peakMax,
      envHop: h.envHop, env: f32(fOff, h.env), loudHop: h.loudHop, loud: f32(fOff + h.env * 4, h.loud), integratedLufs: h.lufs, sourceBytes: h.bytes,
    };
  } catch {
    return null;
  }
}

/** Cache file name for an analysed bundle-relative file (cache names may not contain path separators). */
export const analysisCacheName = (file: string): string => `analysis-${file.replace(/[^\w.-]+/g, '_')}.bin`;
