/**
 * WSOLA time-stretch (pitch preserved) for clip speeds ≤ 2× (plan §6.13).
 * Overlap-add of Hann windows; each frame is aligned to the natural continuation of the previous one by a
 * cross-correlation search (coarse step 4, then ±3 refine) on the channel mix, and the SAME alignment is
 * applied to every channel (no stereo smearing).
 *
 * Chunked export (C22): the chain can be processed window by window. Frame m covers output
 * [m·hop, m·hop + win); `captureM` records the chain state (previous alignment) right before frame m, and a
 * later call that starts from that state reproduces the full computation bit-for-bit on every output frame
 * whose frames are ≥ m — so adjacent export windows overlap with identical samples (no seam artefacts).
 */

export interface WsolaParams {
  win: number;
  hop: number;
  search: number;
}

export function wsolaParams(sampleRate: number): WsolaParams {
  const win = Math.max(8, Math.round(sampleRate * 0.03)); // 30 ms
  return { win, hop: win >> 1, search: Math.max(2, Math.round(sampleRate * 0.008)) };
}

/** Chain state before processing frame m (prevEnd < 0 → no reference: the frame takes its nominal position). */
export interface WsolaChain {
  m: number;
  prevEnd: number;
}

/** Frames [mLo, mHi) whose windows overlap output frames [o0, o1). */
export function wsolaFrames(o0: number, o1: number, p: WsolaParams): [number, number] {
  const mLo = Math.max(0, Math.floor((o0 - p.win) / p.hop) + 1);
  return [mLo, Math.max(mLo, Math.ceil(o1 / p.hop))];
}

/** First frame a wsolaProcess call will process: the chain's frame when it is usable, else the first overlapping frame. */
export function wsolaStartFrame(o0: number, o1: number, p: WsolaParams, chain: WsolaChain | null): number {
  const mLo = wsolaFrames(o0, o1, p)[0];
  return chain && chain.m <= mLo ? chain.m : mLo;
}

/** Input frames (relative to the clip's source start) that frames [mA, mB) may touch, clamped to [0, inLen). */
export function wsolaInputRange(mA: number, mB: number, speed: number, p: WsolaParams, inLen: number): [number, number] {
  const a = Math.round(mA * p.hop * speed) - p.search - 2 * p.hop;
  const b = Math.round(mB * p.hop * speed) + p.search + p.win + 2 * p.hop;
  return [Math.max(0, a), Math.max(0, Math.min(inLen, b))];
}

const hannCache = new Map<number, Float32Array>();
function hann(win: number): Float32Array {
  let h = hannCache.get(win);
  if (!h) {
    h = new Float32Array(win);
    for (let i = 0; i < win; i++) h[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
    hannCache.set(win, h);
  }
  return h;
}

/**
 * Render output frames [o0, o1) of a stretched clip.
 * @param input planar PCM covering clip input frames [inStart, inStart + input[0].length)
 * @param inLen total input length of the clip (alignment never reads past the clip → no leaked cut audio)
 * @param chain state to continue from (must be at a frame ≤ the first frame overlapping o0), or null for fresh
 * @param captureM frame index whose pre-state should be returned in `captured` (−1 = none)
 */
export function wsolaProcess(
  input: readonly Float32Array[],
  inStart: number,
  inLen: number,
  speed: number,
  p: WsolaParams,
  o0: number,
  o1: number,
  chain: WsolaChain | null,
  captureM = -1,
): { out: Float32Array[]; captured: WsolaChain | null } {
  const C = Math.max(1, input.length);
  const n = Math.max(0, o1 - o0);
  const acc = Array.from({ length: C }, () => new Float32Array(n));
  const norm = new Float32Array(n);
  const len = input[0]?.length ?? 0;
  // channel mix used for alignment
  let mono: Float32Array;
  if (input.length <= 1) mono = input[0] ?? new Float32Array(0);
  else {
    mono = new Float32Array(len);
    for (let c = 0; c < input.length; c++) {
      const x = input[c]!;
      for (let i = 0; i < len; i++) mono[i] = mono[i]! + x[i]!;
    }
  }
  const at = (i: number): number => {
    const k = i - inStart;
    return k >= 0 && k < len && i < inLen ? mono[k]! : 0;
  };
  const mHi = wsolaFrames(o0, o1, p)[1];
  let m = wsolaStartFrame(o0, o1, p, chain);
  let prevEnd = chain && chain.m === m ? chain.prevEnd : -1;
  let captured: WsolaChain | null = null;
  const w = hann(p.win);
  const maxC = inLen - p.win;
  const ref = new Float32Array(Math.ceil(p.hop / 4));
  const score = (c: number): number => {
    let s = 0;
    for (let k = 0, r = 0; k < p.hop; k += 4, r++) s += at(c + k) * ref[r]!;
    return s;
  };
  for (; m < mHi; m++) {
    if (m === captureM) captured = { m, prevEnd };
    const o = m * p.hop;
    const nominal = Math.round(o * speed);
    let best: number;
    if (prevEnd >= 0 && maxC > 0) {
      for (let k = 0, r = 0; k < p.hop; k += 4, r++) ref[r] = at(prevEnd + k);
      const lo = Math.max(0, nominal - p.search), hi = Math.min(maxC, nominal + p.search);
      best = Math.min(Math.max(nominal, lo), Math.max(lo, hi));
      let bestScore = -Infinity;
      for (let c = lo; c <= hi; c += 4) {
        const s = score(c);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      const rLo = Math.max(lo, best - 3), rHi = Math.min(hi, best + 3);
      for (let c = rLo; c <= rHi; c++) {
        const s = score(c);
        if (s > bestScore) { bestScore = s; best = c; }
      }
    } else best = Math.min(Math.max(0, nominal), Math.max(0, maxC));
    // overlap-add the aligned frame into the requested output span
    const k0 = Math.max(0, o0 - o), k1 = Math.min(p.win, o1 - o);
    for (let c = 0; c < C; c++) {
      const x = input[c] ?? input[0];
      if (!x) continue;
      const a = acc[c]!;
      for (let k = k0; k < k1; k++) {
        const ii = best + k;
        const j = ii - inStart;
        if (j >= 0 && j < len && ii < inLen) a[o + k - o0] = a[o + k - o0]! + x[j]! * w[k]!;
      }
    }
    for (let k = k0; k < k1; k++) norm[o + k - o0] = norm[o + k - o0]! + w[k]!;
    prevEnd = best + p.hop;
  }
  if (captureM === m && !captured) captured = { m, prevEnd };
  for (let c = 0; c < C; c++) {
    const a = acc[c]!;
    for (let i = 0; i < n; i++) a[i] = norm[i]! > 1e-6 ? a[i]! / norm[i]! : 0;
  }
  return { out: acc, captured };
}

/** Whole-buffer stretch (mono). Output length = round(n / speed). */
export function wsolaStretch(input: Float32Array, speed: number, sampleRate: number): Float32Array {
  if (Math.abs(speed - 1) < 1e-3) return input.slice();
  const outLen = Math.max(1, Math.round(input.length / speed));
  return wsolaProcess([input], 0, input.length, speed, wsolaParams(sampleRate), 0, outLen, null).out[0]!;
}
