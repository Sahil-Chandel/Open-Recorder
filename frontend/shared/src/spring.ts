/**
 * Spring physics (plan §6.2) — drives zoom/pan, cursor and layout transitions.
 * Deterministic fixed-step semi-implicit Euler at 240 Hz; never integrate with wall-clock dt.
 * Tracks are precomputed once per edit and sampled by interpolation, so preview == export.
 */
import type { SpeedPreset, Spring } from './schema';

export const SIM_HZ = 240;
export const SIM_DT = 1 / SIM_HZ;

export const SPRINGS: Record<SpeedPreset, Spring> = {
  slow: { tension: 120, friction: 26, mass: 1 },
  medium: { tension: 170, friction: 26, mass: 1 },
  fast: { tension: 260, friction: 32, mass: 1 },
  rapid: { tension: 400, friction: 40, mass: 1 },
};

export function resolveSpring(s: SpeedPreset | Spring): Spring {
  return typeof s === 'string' ? SPRINGS[s] : s;
}

export function step(x: number, v: number, target: number, s: Spring, dt = SIM_DT): readonly [number, number] {
  const a = (-s.tension * (x - target) - s.friction * v) / s.mass;
  const nv = v + a * dt;
  return [x + nv * dt, nv] as const;
}

/**
 * A multi-channel precomputed track sampled at SIM_HZ.
 * data layout: [t0c0, t0c1, …, t1c0, …] — Float32Array chosen for cache-friendly linear interpolation.
 */
export class SampledTrack {
  constructor(
    readonly channels: number,
    readonly data: Float32Array,
    readonly hz: number = SIM_HZ,
    readonly t0 = 0,
  ) {}

  get length(): number {
    return this.data.length / this.channels;
  }
  get duration(): number {
    return Math.max(0, (this.length - 1) / this.hz);
  }

  /** O(1) linear interpolation at time t (clamped). Writes into `out` to avoid allocation in the render loop. */
  sample(t: number, out: Float64Array | number[] = new Array(this.channels)): Float64Array | number[] {
    const n = this.length;
    if (n === 0) {
      for (let c = 0; c < this.channels; c++) out[c] = 0;
      return out;
    }
    const f = Math.min(Math.max((t - this.t0) * this.hz, 0), n - 1);
    const i = Math.floor(f);
    const j = Math.min(i + 1, n - 1);
    const k = f - i;
    for (let c = 0; c < this.channels; c++) {
      const a = this.data[i * this.channels + c]!;
      const b = this.data[j * this.channels + c]!;
      out[c] = a + (b - a) * k;
    }
    return out;
  }
}

/**
 * Simulate `channels` independent springs following a target function over [0, duration].
 * targetAt(t, prevState, outTarget) fills the target per channel; returns a SampledTrack of positions.
 * Cost: O(duration · SIM_HZ · channels). A 10-min video ≈ 144k steps — a few ms.
 */
export function simulateSprings(
  duration: number,
  channels: number,
  spring: Spring | ((channel: number) => Spring),
  init: ArrayLike<number>,
  targetAt: (t: number, state: Float64Array, outTarget: Float64Array) => void,
  substeps = 1,
): SampledTrack {
  const n = Math.max(1, Math.ceil(duration * SIM_HZ) + 1);
  const data = new Float32Array(n * channels);
  const x = new Float64Array(channels);
  const v = new Float64Array(channels);
  const target = new Float64Array(channels);
  const springs = Array.from({ length: channels }, (_, c) => (typeof spring === 'function' ? spring(c) : spring));
  for (let c = 0; c < channels; c++) x[c] = init[c] ?? 0;
  const dt = SIM_DT / substeps;
  for (let i = 0; i < n; i++) {
    const t = i * SIM_DT;
    targetAt(t, x, target);
    for (let s = 0; s < substeps; s++) {
      for (let c = 0; c < channels; c++) {
        const sp = springs[c]!;
        const a = (-sp.tension * (x[c]! - target[c]!) - sp.friction * v[c]!) / sp.mass;
        v[c] = v[c]! + a * dt;
        x[c] = x[c]! + v[c]! * dt;
      }
    }
    for (let c = 0; c < channels; c++) data[i * channels + c] = x[c]!;
  }
  return new SampledTrack(channels, data);
}

/** Critically-damped-ish easing for simple UI transitions (layout switch ≈ 400 ms). */
export function easeInOutCubic(k: number): number {
  const x = Math.min(Math.max(k, 0), 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
