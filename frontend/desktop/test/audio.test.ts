/**
 * Audio engine pure logic (audit TLA): peak pyramid, BS.1770 loudness + balancing, voice activity, the
 * ducking envelope shared by preview and export, music range/fades, chunk planning + seam continuity,
 * WSOLA chain hand-off between export windows, analysis cache format, and the streaming PCM reader
 * (mediabunny decodes PCM WAV in plain Node).
 */
import { describe, expect, it } from 'vitest';
import { BufferSource } from 'mediabunny';
import { createProject, makeClip, type Project } from '@rec/shared';
import {
  AnalysisBuilder,
  analysePcm,
  analysisCacheName,
  balanceCurve,
  compand,
  decodeAnalysis,
  encodeAnalysis,
  integratedLoudness,
  PEAK_BLOCK,
  PEAK_FACTOR,
  peakSpan,
  sampleCurve,
  voiceActivity,
  type TrackAnalysis,
} from '../src/renderer/src/audio/analysis';
import { encodeWav } from '../src/renderer/src/audio/dsp';
import {
  clipPieces,
  DUCK_DEFAULTS,
  duckCurve,
  duckFor,
  musicEnd,
  musicGainAt,
  musicPosAt,
  musicSegments,
  pieceEnvelope,
  planChunks,
  SeamStitcher,
  trackFile,
} from '../src/renderer/src/audio/mixModel';
import { BufferReader, openPcmReaderFromSource } from '../src/renderer/src/audio/trackReader';
import { wsolaFrames, wsolaInputRange, wsolaParams, wsolaProcess, wsolaStartFrame, wsolaStretch } from '../src/renderer/src/audio/wsola';

// ---------------------------------------------------------------- helpers

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const tone = (n: number, f: number, a: number, sr: number, phase = 0) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr + phase));
const noise = (n: number, a: number) => Float32Array.from({ length: n }, () => rnd() * a);
const db = (g: number) => 20 * Math.log10(g);

function applyCurveInPlace(x: Float32Array, sr: number, c: { start: number; hop: number; values: Float32Array }): Float32Array {
  const y = x.slice();
  for (let i = 0; i < y.length; i++) y[i] = y[i]! * sampleCurve(c, i / sr);
  return y;
}

function baseProject(durationSec = 20): Project {
  return createProject('audio-test', {
    kind: 'display', width: 1920, height: 1080, fps: 60, scaleFactor: 1,
    segments: [{ file: 'media/screen_000.mp4', startNs: 0, durationNs: durationSec * 1e9 }],
    tracks: { screen: 'media/screen.mp4', mic: 'media/mic.wav' }, hasTelemetry: false, durationSec,
  });
}

// ---------------------------------------------------------------- peaks

describe('peak pyramid', () => {
  const sr = 48000;
  const x = Float32Array.from({ length: Math.round(sr * 2.3) + 17 }, (_, i) => 0.6 * Math.sin(i / 37) * Math.sin(i / 5000) + 0.05 * rnd());
  const a = analysePcm([x], sr);

  it('level 0 holds the companded min/max of every 64-frame block; higher levels reduce ×4', () => {
    const l0 = a.peaks[0]!;
    expect(l0.block).toBe(PEAK_BLOCK);
    expect(l0.count).toBe(Math.ceil(x.length / PEAK_BLOCK));
    for (const b of [0, 1, 17, 500, l0.count - 1]) {
      const seg = x.subarray(b * PEAK_BLOCK, (b + 1) * PEAK_BLOCK);
      expect(l0.data[b * 2]).toBe(compand(Math.min(...seg)));
      expect(l0.data[b * 2 + 1]).toBe(compand(Math.max(...seg)));
    }
    for (let l = 1; l < a.peaks.length; l++) {
      const lv = a.peaks[l]!, prev = a.peaks[l - 1]!;
      expect(lv.block).toBe(prev.block * PEAK_FACTOR);
      expect(lv.count).toBe(Math.ceil(prev.count / PEAK_FACTOR));
      const i = Math.floor(lv.count / 2);
      const kids = Array.from({ length: PEAK_FACTOR }, (_, k) => i * PEAK_FACTOR + k).filter((k) => k < prev.count);
      expect(lv.data[i * 2]).toBe(Math.min(...kids.map((k) => prev.data[k * 2]!)));
      expect(lv.data[i * 2 + 1]).toBe(Math.max(...kids.map((k) => prev.data[k * 2 + 1]!)));
    }
    expect(a.peakMax).toBeCloseTo(Math.max(...x.map(Math.abs)), 6);
  });

  it('peakSpan bounds the true min/max of any range and is exact on block-aligned ranges', () => {
    const out = new Float32Array(2);
    for (let k = 0; k < 200; k++) {
      const f0 = Math.floor(((rnd() + 1) / 2) * (x.length - 5000));
      const f1 = f0 + 1 + Math.floor(((rnd() + 1) / 2) * 4000);
      expect(peakSpan(a, f0 / sr, f1 / sr, out)).toBe(true);
      const seg = x.subarray(f0, f1);
      expect(out[0]!).toBeLessThanOrEqual(compand(Math.min(...seg)) / 127 + 1e-6);
      expect(out[1]!).toBeGreaterThanOrEqual(compand(Math.max(...seg)) / 127 - 1e-6);
    }
    const f0 = 64 * 10, f1 = 64 * 11; // exactly one level-0 block
    peakSpan(a, f0 / sr, f1 / sr, out);
    const seg = x.subarray(f0, f1);
    expect(out[0]).toBeCloseTo(compand(Math.min(...seg)) / 127, 6);
    expect(out[1]).toBeCloseTo(compand(Math.max(...seg)) / 127, 6);
    expect(peakSpan(a, 10, 11, out)).toBe(false); // past the end
    expect(peakSpan(a, -2, -1, out)).toBe(false);
  });

  it('is identical however the decoder splits the stream (chunk-boundary continuity)', () => {
    const st = [x, Float32Array.from(x, (v) => -0.5 * v)];
    const whole = encodeAnalysis(analysePcm(st, sr, 99));
    const b = new AnalysisBuilder(sr, 2);
    for (let i = 0; i < x.length; ) {
      const n = Math.min(x.length - i, 1 + Math.floor(((rnd() + 1) / 2) * 3000));
      b.push(st.map((p) => p.subarray(i, i + n)), n);
      i += n;
    }
    expect(encodeAnalysis(b.finish(99))).toEqual(whole);
  });
});

// ---------------------------------------------------------------- loudness

describe('BS.1770 loudness', () => {
  it('reads a 997 Hz sine at amplitude 0.1 (mono, played on both speakers) as ≈ −20 LUFS at 48 and 44.1 kHz', () => {
    for (const sr of [48000, 44100]) {
      const a = analysePcm([tone(sr * 5, 997, 0.1, sr)], sr);
      expect(Math.abs(a.integratedLufs - -20)).toBeLessThan(0.3);
    }
  });

  it('dual-mono stereo equals the mono reading; silence is gated out; digital silence reads −70', () => {
    const sr = 48000;
    const t = tone(sr * 4, 997, 0.1, sr);
    const mono = analysePcm([t], sr).integratedLufs;
    expect(analysePcm([t, t], sr).integratedLufs).toBeCloseTo(mono, 1);
    const withPause = new Float32Array(sr * 8);
    withPause.set(t, 0);
    expect(Math.abs(analysePcm([withPause], sr).integratedLufs - mono)).toBeLessThan(0.5);
    expect(analysePcm([new Float32Array(sr * 2)], sr).integratedLufs).toBe(-70);
    expect(integratedLoudness(new Float32Array(0))).toBe(-70);
  });
});

describe('smart volume balancing', () => {
  it('normalises a quiet voice to ≈ −16 LUFS (measure → gain → re-measure)', () => {
    const sr = 16000;
    const x = tone(sr * 10, 997, 0.04, sr); // ≈ −28 LUFS
    const a = analysePcm([x], sr);
    const b = balanceCurve(a);
    expect(b.normDb).toBeCloseTo(-16 - a.integratedLufs, 5);
    expect(b.normDb).toBeGreaterThan(11);
    const after = analysePcm([applyCurveInPlace(x, sr, b.curve)], sr).integratedLufs;
    expect(Math.abs(after - -16)).toBeLessThan(0.6);
  });

  it('evens out quiet and loud passages (bounded leveller) and caps extreme gains', () => {
    const sr = 16000;
    // speech-like: 400 ms phrases + 200 ms pauses over a −70 dBFS floor; first half 20 dB quieter
    const x = noise(sr * 16, 0.0005);
    for (let t = 0.2; t < 15.4; t += 0.6) {
      const seg = tone(Math.round(0.4 * sr), 400, t < 8 ? 0.02 : 0.2, sr);
      const o = Math.round(t * sr);
      for (let i = 0; i < seg.length; i++) x[o + i] = x[o + i]! + seg[i]!;
    }
    const b = balanceCurve(analysePcm([x], sr));
    const gQuiet = sampleCurve(b.curve, 4), gLoud = sampleCurve(b.curve, 12);
    const spread = db(gQuiet) - db(gLoud);
    expect(spread).toBeGreaterThan(3);
    expect(spread).toBeLessThanOrEqual(12.01);
    for (const v of b.curve.values) expect(Number.isFinite(v)).toBe(true);
    expect(balanceCurve(analysePcm([tone(sr * 4, 400, 0.0008, sr)], sr)).normDb).toBe(20);
    expect(balanceCurve(analysePcm([new Float32Array(sr)], sr)).curve.values).toEqual(new Float32Array([1]));
  });
});

// ---------------------------------------------------------------- voice activity + ducking

describe('voice activity envelope (mic PCM, not the master bus)', () => {
  const sr = 16000;
  const x = noise(sr * 6, 0.0017); // ≈ −60 dBFS floor
  const burst = (t0: number, t1: number) => x.set(tone(Math.round((t1 - t0) * sr), 300, 0.14, sr).map((v, i) => v + x[Math.round(t0 * sr) + i]!), Math.round(t0 * sr));
  burst(1.0, 1.8);
  burst(3.0, 3.5);
  burst(4.5, 4.75);
  burst(4.87, 5.2); // 120 ms gap → bridged
  burst(2.6, 2.63); // 30 ms blip → dropped
  const vad = voiceActivity(analysePcm([x], sr));
  const on = (t: number) => vad.active[Math.floor(t / vad.hop)] === 1;

  it('detects speech, keeps a 250 ms hangover, bridges short gaps and drops blips', () => {
    expect(vad.hop).toBeCloseTo(0.01, 6);
    for (const t of [1.1, 1.5, 1.95, 3.2, 4.6, 4.8, 5.1]) expect(on(t)).toBe(true);
    for (const t of [0.2, 0.9, 2.3, 2.61, 2.7, 4.0, 5.6]) expect(on(t)).toBe(false);
  });
});

describe('ducking curve (identical for preview and export)', () => {
  const hop = 0.01;
  const active = new Uint8Array(1000);
  active.fill(1, 200, 400); // voice in source [2, 4)
  const vad = { hop, active };
  const at = (c: { start: number; hop: number; values: Float32Array }, t: number) => sampleCurve(c, t);

  it('dips under voice with look-ahead, attack and release', () => {
    const c = duckCurve([makeClip(0, 10)], vad, 0, true, 10);
    expect(at(c, 1.5)).toBe(1);
    expect(at(c, 2.0)).toBeLessThan(0.9); // look-ahead: already ducking at the first syllable
    expect(at(c, 2.5)).toBeLessThan(DUCK_DEFAULTS.level + 0.01);
    expect(at(c, 3.9)).toBeLessThan(DUCK_DEFAULTS.level + 0.01);
    expect(at(c, 4.2)).toBeGreaterThan(0.5);
    expect(at(c, 4.2)).toBeLessThan(0.9);
    expect(at(c, 5.6)).toBeGreaterThan(0.99);
    for (let i = 400; i < 560; i++) expect(c.values[i + 1]!).toBeGreaterThanOrEqual(c.values[i]! - 1e-7); // monotonic release
  });

  it('follows cuts, muted mic, silent clips (mic volume 0) and > 2× clips', () => {
    const flat = (c: { values: Float32Array }) => c.values.every((v) => v > 0.999);
    expect(flat(duckCurve([makeClip(0, 1.5), makeClip(4.5, 10)], vad, 0, true, 7))).toBe(true);
    expect(flat(duckCurve([makeClip(0, 10)], vad, 0, false, 10))).toBe(true);
    expect(flat(duckCurve([makeClip(0, 10, { volume: { mic: 0, system: 1, device: 1 } })], vad, 0, true, 10))).toBe(true);
    expect(flat(duckCurve([makeClip(0, 2), makeClip(2, 4, { speed: 4 }), makeClip(4, 10)], vad, 0, true, 6.5))).toBe(true);
    // track offset: the mic file starts 1 s after source 0 → voice at source [3, 5)
    const off = duckCurve([makeClip(0, 10)], vad, 1, true, 10);
    expect(at(off, 2.5)).toBe(1);
    expect(at(off, 4)).toBeLessThan(0.4);
  });

  it('duckFor memoises per (clips, analysis) and is disabled without music or ducking', () => {
    const p = baseProject(10);
    const a = analysePcm([noise(16000 * 10, 0.001)], 16000);
    expect(duckFor(p, a)).toBeNull();
    p.audio.ducking = true;
    p.music = { file: 'cache/m.wav', name: 'm', trimStart: 0, trimEnd: 5, volume: 0.4, fadeIn: 0, fadeOut: 0, loop: true, rangeStart: 0, rangeEnd: 10 };
    const c1 = duckFor(p, a);
    expect(c1).not.toBeNull();
    expect(duckFor(p, a)).toBe(c1);
    p.clips = [makeClip(0, 5)];
    expect(duckFor(p, a)).not.toBe(c1);
  });
});

// ---------------------------------------------------------------- music + clips

describe('music in output time', () => {
  const p = baseProject(20);
  p.clips = [makeClip(0, 4), makeClip(10, 14)]; // edited to 8 s
  p.music = { file: 'cache/music.wav', name: 'x', trimStart: 0, trimEnd: 3, volume: 0.5, fadeIn: 1, fadeOut: 2, loop: true, rangeStart: 0, rangeEnd: 20 };

  it('clamps the range to the edited duration so the fade-out still happens (preview = export)', () => {
    expect(musicEnd(p)).toBe(8);
    expect(musicGainAt(p, 0.5)).toBeCloseTo(0.25, 6);
    expect(musicGainAt(p, 7)).toBeCloseTo(0.25, 6);
    expect(musicGainAt(p, 8)).toBe(0);
    expect(musicPosAt(p, 4)).toBeCloseTo(1, 6);
    expect(musicPosAt(p, 8.5)).toBeNull();
  });

  it('musicSegments agree with musicPosAt sample by sample (loops, window edges)', () => {
    for (const [t0, t1] of [[2.5, 7.2], [0, 8], [5.9, 6.1], [7.5, 9]] as const) {
      const segs = musicSegments(p, t0, t1);
      for (let t = t0; t < t1; t += 0.0137) {
        const pos = musicPosAt(p, t);
        const s = segs.find((g) => t >= g.outStart && t < g.outEnd);
        if (pos === null) expect(s).toBeUndefined();
        else expect(s!.fileStart + (t - s!.outStart)).toBeCloseTo(pos, 6);
      }
    }
    p.music!.loop = false;
    expect(musicSegments(p, 0, 8)).toEqual([{ outStart: 0, outEnd: 3, fileStart: 0 }]);
    p.music!.loop = true;
  });

  it('joins: contiguous speed-1 splits are seamless, real cuts get 10 ms fades', () => {
    const clips = [makeClip(0, 5), makeClip(5, 8), makeClip(10, 12)];
    const [a, b, c] = clipPieces(clips, 0, 100);
    expect([a!.fadeIn, a!.fadeOut, b!.fadeIn, b!.fadeOut, c!.fadeIn, c!.fadeOut]).toEqual([true, false, false, true, true, true]);
    expect(pieceEnvelope(c!, c!.outStart + 0.005)).toBeCloseTo(0.5, 6);
    expect(pieceEnvelope(b!, b!.outStart)).toBe(1);
    expect(clipPieces(clips, 6, 7.5).map((x) => x.index)).toEqual([1]);
  });

  it('plays the processed mic when available (enhanced > denoised > raw)', () => {
    const q = baseProject(5);
    expect(trackFile(q, 'mic', true)).toBe('media/mic.wav');
    q.audio.mic.denoise = true;
    expect(trackFile(q, 'mic', true)).toBe('cache/mic.denoised.wav');
    expect(trackFile(q, 'mic', false)).toBe('media/mic.wav');
    q.audio.mic.enhance = true;
    expect(trackFile(q, 'mic', true)).toBe('cache/mic.enhanced.wav');
  });
});

// ---------------------------------------------------------------- chunked mixdown

describe('chunked mixdown plan + seam stitching', () => {
  it('emits every frame exactly once with bounded windows', () => {
    for (const total of [1, 999, 3000, 3001, 10_000, 12_345]) {
      const ws = planChunks(total, 3000, 800, 120);
      let next = 0;
      for (const w of ws) {
        expect(w.f0).toBe(next);
        expect(w.f1 - w.f0).toBeLessThanOrEqual(3000);
        expect(w.w0).toBe(Math.max(0, w.f0 - 800));
        expect(w.w1).toBe(w.f1 < total ? Math.min(total, w.f1 + 120) : w.f1);
        next = w.f1;
      }
      expect(next).toBe(total);
    }
  });

  const sr = 8000;
  const sig = (i: number) => Math.sin(i * 0.013) * 0.7 + Math.sin(i * 0.0007) * 0.2 + (((i * 7919) % 1000) / 1000) * 0.1;
  /** stateful renderer (one-pole + peak follower with 150 ms release, like the limiter), state reset per window */
  const render = (w0: number, w1: number) => {
    const out = new Float32Array(w1 - w0);
    const k = 1 - Math.exp(-1 / (0.15 * sr));
    let y = 0, env = 0;
    for (let i = w0; i < w1; i++) {
      y += (sig(i) - y) * 0.2;
      const a = Math.abs(y);
      env = a > env ? a : env + (a - env) * k;
      out[i - w0] = y / Math.max(0.5, env * 1.2);
    }
    return [out, out.map((v) => -v)];
  };
  const stitchAll = (total: number, chunk: number, pre: number, xf: number, r: (a: number, b: number) => Float32Array[]) => {
    const st = new SeamStitcher(2);
    const parts = planChunks(total, chunk, pre, xf).map((w) => st.stitch(w, r(w.w0, w.w1)));
    const L = new Float32Array(total);
    let o = 0;
    for (const p of parts) { L.set(p[0]!, o); o += p[0]!.length; }
    return L;
  };

  it('stateful windows rendered with pre-roll join the whole-file render without seams', () => {
    const total = 40_000;
    const whole = render(0, total)[0]!;
    const L = stitchAll(total, 6000, sr, 400, render);
    let max = 0, jump = 0;
    for (let i = 0; i < total; i++) max = Math.max(max, Math.abs(L[i]! - whole[i]!));
    for (let i = 1; i < total; i++) jump = Math.max(jump, Math.abs(L[i]! - L[i - 1]!) - Math.abs(whole[i]! - whole[i - 1]!));
    expect(max).toBeLessThan(5e-3);
    expect(jump).toBeLessThan(5e-3);
  });

  it('identical content passes through the cross-fade unchanged; different content is ramped, not stepped', () => {
    const pure = (a: number, b: number) => { const x = Float32Array.from({ length: b - a }, (_, i) => sig(a + i)); return [x, x]; };
    const L = stitchAll(20_000, 3000, 800, 200, pure);
    for (let i = 0; i < 20_000; i++) expect(Math.abs(L[i]! - sig(i))).toBeLessThan(1e-6);
    // window 1 renders constant 1 except its tail; window 2 renders 0 → the seam ramps 1 → 0 over xf
    const st = new SeamStitcher(1);
    const [w0, w1] = planChunks(2000, 1000, 100, 100);
    st.stitch(w0!, [new Float32Array(w0!.w1 - w0!.w0).fill(1)]);
    const out = st.stitch(w1!, [new Float32Array(w1!.w1 - w1!.w0)])[0]!;
    expect(out[0]).toBeGreaterThan(0.98);
    expect(out[99]).toBeLessThan(0.01);
    for (let i = 1; i < 100; i++) expect(out[i]!).toBeLessThanOrEqual(out[i - 1]!);
  });
});

describe('WSOLA chain hand-off between export windows', () => {
  const sr = 16000;
  const n = sr * 3;
  const Lch = Float32Array.from(tone(n, 220, 0.4, sr), (v) => v + rnd() * 0.05);
  const Rch = Float32Array.from(Lch, (v, i) => 0.5 * v + 0.2 * Math.sin((2 * Math.PI * 330 * i) / sr));
  const input = [Lch, Rch];

  for (const speed of [1.5, 0.75, 2]) {
    it(`window renders are bit-identical to the whole-clip render (speed ${speed})`, () => {
      const p = wsolaParams(sr);
      const outLen = Math.round(n / speed);
      const full = wsolaProcess(input, 0, n, speed, p, 0, outLen, null).out;
      const o1A = Math.round(outLen * 0.6), o0B = Math.round(outLen * 0.45);
      const capture = wsolaFrames(o0B, o0B + 1, p)[0];
      const [a0, a1] = wsolaInputRange(0, wsolaFrames(0, o1A, p)[1], speed, p, n);
      const A = wsolaProcess(input.map((x) => x.slice(a0, a1)), a0, n, speed, p, 0, o1A, null, capture);
      expect(A.captured?.m).toBe(capture);
      const mB = wsolaStartFrame(o0B, outLen, p, A.captured);
      expect(mB).toBe(capture);
      const [b0, b1] = wsolaInputRange(mB, wsolaFrames(o0B, outLen, p)[1], speed, p, n);
      const B = wsolaProcess(input.map((x) => x.slice(b0, b1)), b0, n, speed, p, o0B, outLen, A.captured);
      for (let c = 0; c < 2; c++) {
        expect(A.out[c]).toEqual(full[c]!.slice(0, o1A));
        expect(B.out[c]).toEqual(full[c]!.slice(o0B));
      }
    });
  }

  it('keeps length 1/speed, energy, and one alignment for all channels', () => {
    const y = wsolaStretch(Lch, 1.5, sr);
    expect(Math.abs(y.length - n / 1.5)).toBeLessThan(2);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    expect(rms(y.subarray(1000, y.length - 1000))).toBeGreaterThan(rms(Lch) * 0.8);
    // identical channels stay identical (shared alignment → no stereo smearing)
    const st = wsolaProcess([Lch, Lch], 0, n, 1.5, wsolaParams(sr), 0, Math.round(n / 1.5), null).out;
    expect(st[0]).toEqual(st[1]);
  });
});

// ---------------------------------------------------------------- cache format

describe('analysis cache format', () => {
  const a = analysePcm([tone(48000, 440, 0.3, 48000), noise(48000, 0.1)], 48000, 4242);

  it('round-trips byte-exactly and validates', () => {
    const bytes = encodeAnalysis(a);
    const b = decodeAnalysis(bytes) as TrackAnalysis;
    expect(b).not.toBeNull();
    expect(b).toEqual(a);
    // unaligned views (IPC buffers) decode too
    const shifted = new Uint8Array(bytes.length + 3);
    shifted.set(bytes, 3);
    expect(decodeAnalysis(shifted.subarray(3))).toEqual(a);
  });

  it('rejects corrupt, truncated, empty and other-version data', () => {
    const bytes = encodeAnalysis(a);
    expect(decodeAnalysis(bytes.slice(0, bytes.length - 1))).toBeNull();
    expect(decodeAnalysis(new Uint8Array(0))).toBeNull();
    expect(decodeAnalysis(null)).toBeNull();
    const bad = bytes.slice();
    bad[0] = 0;
    expect(decodeAnalysis(bad)).toBeNull();
    const v2 = encodeAnalysis({ ...a, version: 999 });
    expect(decodeAnalysis(v2)).toBeNull();
    expect(analysisCacheName('media/mic.wav')).toBe('analysis-media_mic.wav.bin');
    expect(analysisCacheName('cache/mic.enhanced.wav')).not.toMatch(/[\\/]/);
  });
});

// ---------------------------------------------------------------- streaming reader (mediabunny, PCM in Node)

describe('PCM reader', () => {
  const sr = 48000;
  const n = sr + 1234;
  const L = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(i / 23) + 0.1 * rnd());
  const R = Float32Array.from(L, (v) => -0.7 * v);
  const wav = encodeWav([L, R], sr);
  const close = (got: Float32Array, want: Float32Array) => {
    expect(got.length).toBe(want.length);
    let m = 0;
    for (let i = 0; i < want.length; i++) m = Math.max(m, Math.abs(got[i]! - want[i]!));
    expect(m).toBeLessThan(1e-4);
  };

  it('reads exact frame ranges (packet boundaries, before start, past end)', async () => {
    const r = (await openPcmReaderFromSource(new BufferSource(wav)))!;
    expect(r).not.toBeNull();
    expect([r.sampleRate, r.channels, r.frames]).toEqual([sr, 2, n]);
    const [l1, r1] = await r.readFrames(1000, 2500);
    close(l1!, L.subarray(1000, 3500));
    close(r1!, R.subarray(1000, 3500));
    const [l2] = await r.readFrames(-100, 300);
    close(l2!, Float32Array.from({ length: 300 }, (_, i) => (i < 100 ? 0 : L[i - 100]!)));
    const [l3] = await r.readFrames(n - 50, 200);
    close(l3!, Float32Array.from({ length: 200 }, (_, i) => (i < 50 ? L[n - 50 + i]! : 0)));
    r.dispose();
  });

  it('streams every frame once, and analysis via the stream equals analysis of the decoded buffer', async () => {
    const r = (await openPcmReaderFromSource(new BufferSource(wav)))!;
    const got = new Float32Array(n + 4096);
    let o = 0;
    const b = new AnalysisBuilder(r.sampleRate, r.channels);
    await r.stream((planes, k) => { got.set(planes[0]!.subarray(0, k), o); o += k; b.push(planes, k); }, { sliceMs: 0 });
    expect(o).toBe(n);
    close(got.subarray(0, n), L);
    const decoded = await r.readFrames(0, n);
    expect(encodeAnalysis(b.finish(7))).toEqual(encodeAnalysis(analysePcm(decoded, sr, 7)));
    r.dispose();
    const br = new BufferReader([L, R], sr);
    close((await br.readFrames(-5, 20))[1]!, Float32Array.from({ length: 20 }, (_, i) => (i < 5 ? 0 : R[i - 5]!)));
  });
});

// ---------------------------------------------------------------- performance sanity

describe('performance sanity', () => {
  it('analyses 60 s of 48 kHz stereo well under real time', () => {
    const sr = 48000;
    const block = tone(sr, 220, 0.3, sr);
    const b = new AnalysisBuilder(sr, 2);
    const t0 = performance.now();
    for (let s = 0; s < 60; s++) b.push([block, block], sr);
    const a = b.finish();
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(a.duration).toBeCloseTo(60, 6);
  });

  it('builds a 1-hour ducking curve over 2000 clips and answers 200k peak queries quickly', () => {
    const clips = Array.from({ length: 2000 }, (_, i) => makeClip(i * 1.8, i * 1.8 + 1.7));
    const vad = { hop: 0.01, active: Uint8Array.from({ length: 360_000 }, (_, i) => ((i / 50) | 0) % 3 === 0 ? 1 : 0) };
    let t0 = performance.now();
    const c = duckCurve(clips, vad, 0, true, 3400);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(c.values.length).toBe(Math.ceil(3400 / 0.01) + 1);
    const a = analysePcm([noise(48000 * 20, 0.5)], 48000);
    const out = new Float32Array(2);
    t0 = performance.now();
    for (let i = 0; i < 200_000; i++) {
      const t = ((i * 7919) % 19_000) / 1000;
      peakSpan(a, t, t + 0.004 + (i % 7) * 0.01, out);
    }
    expect(performance.now() - t0).toBeLessThan(800);
  });
});
