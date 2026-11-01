/**
 * DSP utilities: radix-2 FFT, spectral-gating noise reduction (AUD-01 "Audio Noise Reduction", free & local),
 * WAV encode/decode helpers. Pure functions → unit-testable in Node.
 */

export function fft(re: Float32Array, im: Float32Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = im[i]! / n; }
}

/**
 * Spectral gating: noise profile = per-bin 20th-percentile magnitude across frames; gain per bin =
 * soft mask vs (k × noise), smoothed over time & frequency to avoid musical noise. O(n log N).
 */
export async function spectralDenoise(x: Float32Array, opts: { strength?: number; onProgress?: (p: number) => void; yieldEvery?: number } = {}): Promise<Float32Array> {
  const N = 2048, hop = 512;
  // threshold ≈ 2.6 × the 20th-percentile magnitude ≈ 1.7σ of a Rayleigh-distributed noise bin → ~85 % of pure-noise bins gated
  const strength = opts.strength ?? 2.6;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const frames = Math.max(1, Math.ceil((x.length - N) / hop) + 1);
  const bins = N / 2 + 1;
  // pass 1: magnitudes (subsample frames for the profile to bound memory)
  const step = Math.max(1, Math.floor(frames / 600));
  const samples: Float32Array[] = Array.from({ length: bins }, () => new Float32Array(Math.ceil(frames / step)));
  const re = new Float32Array(N), im = new Float32Array(N);
  let s = 0;
  for (let f = 0; f < frames; f += step, s++) {
    for (let i = 0; i < N; i++) { re[i] = (x[f * hop + i] ?? 0) * win[i]!; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < bins; b++) samples[b]![s] = Math.hypot(re[b]!, im[b]!);
  }
  const noise = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const arr = Array.from(samples[b]!.subarray(0, s)).sort((a, c) => a - c);
    noise[b] = arr[Math.floor(arr.length * 0.2)] ?? 0;
  }
  // pass 2: gate + overlap-add
  const out = new Float32Array(x.length + N);
  const norm = new Float32Array(x.length + N);
  let prevGain = new Float32Array(bins).fill(1);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = (x[f * hop + i] ?? 0) * win[i]!; im[i] = 0; }
    fft(re, im);
    const gain = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      const mag = Math.hypot(re[b]!, im[b]!);
      const thr = noise[b]! * strength;
      const g = mag <= thr ? 0.08 : Math.min(1, Math.max(0.08, 1 - (thr / mag) ** 2));
      gain[b] = 0.6 * g + 0.4 * prevGain[b]!; // temporal smoothing
    }
    for (let b = 1; b < bins - 1; b++) gain[b] = (gain[b - 1]! + 2 * gain[b]! + gain[b + 1]!) / 4; // spectral smoothing
    prevGain = gain;
    for (let b = 0; b < bins; b++) {
      re[b] = re[b]! * gain[b]!;
      im[b] = im[b]! * gain[b]!;
      if (b > 0 && b < N / 2) { re[N - b] = re[b]!; im[N - b] = -im[b]!; }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) {
      out[f * hop + i] = out[f * hop + i]! + re[i]! * win[i]!;
      norm[f * hop + i] = norm[f * hop + i]! + win[i]! * win[i]!;
    }
    if (opts.yieldEvery && f % opts.yieldEvery === 0) {
      opts.onProgress?.(f / frames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const res = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) res[i] = norm[i]! > 1e-6 ? out[i]! / norm[i]! : 0;
  return res;
}

/** 16-bit PCM WAV (interleaved). */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const nCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const buf = new ArrayBuffer(44 + len * nCh * 2);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + len * nCh * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nCh * 2, true); dv.setUint16(32, nCh * 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, len * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nCh; c++) {
    const v = Math.max(-1, Math.min(1, channels[c]![i]!));
    dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

/** Integrated loudness approximation (RMS-based, gated) in LUFS-ish dB for normalisation. */
export function approxLoudnessDb(x: Float32Array, sampleRate: number): number {
  const win = Math.round(sampleRate * 0.4);
  const vals: number[] = [];
  for (let i = 0; i + win <= x.length; i += win / 2) {
    let e = 0;
    for (let j = 0; j < win; j++) e += x[i + j]! ** 2;
    const db = 10 * Math.log10(e / win + 1e-12);
    if (db > -70) vals.push(db);
  }
  if (!vals.length) return -70;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const gated = vals.filter((v) => v > mean - 10);
  return gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length) - 0.7;
}
