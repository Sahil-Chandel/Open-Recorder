/**
 * Cursor pipeline (plan §6.6) — CUR-01…09, ANI-02 (cursor part).
 * Precomputed in OUTPUT time at 240 Hz → channels: x, y, rotationDeg, visibility(0..1).
 * Clicks are mapped to output time for click effects (CUR-05) and click sounds (CUR-06).
 */
import { cursorAt, type ClickEvent, type CursorSample } from './events';
import type { AnimationSettings, Clip, CursorSettings } from './schema';
import { clamp, lerp, resolveSpring, SampledTrack, SIM_DT, SIM_HZ } from './spring';
import { outToSrc, outputDuration, srcToOut } from './time';

export const CUR = { X: 0, Y: 1, ROT: 2, VIS: 3 } as const;
export const CUR_CHANNELS = 4;

export interface OutputClick {
  tOut: number;
  x: number;
  y: number;
  button: ClickEvent['button'];
}

export function clicksToOutput(clicks: readonly ClickEvent[], clips: readonly Clip[]): OutputClick[] {
  const out: OutputClick[] = [];
  for (const c of clicks) {
    if (c.phase !== 'down') continue;
    const t = srcToOut(clips, c.t);
    if (t !== null) out.push({ tOut: t, x: c.x, y: c.y, button: c.button });
  }
  return out.sort((a, b) => a.tOut - b.tOut);
}

export interface CursorTrackInputs {
  clips: readonly Clip[];
  cursor: readonly CursorSample[];
  clicks: readonly ClickEvent[];
  settings: CursorSettings;
  animation: AnimationSettings;
  /** stage width in px per normalised unit — scales the dynamic-direction gain */
  aspect?: number;
}

export function computeCursorTrack(inp: CursorTrackInputs): SampledTrack {
  const dur = outputDuration(inp.clips);
  const n = Math.max(1, Math.ceil(dur * SIM_HZ) + 1);
  const rawX = new Float32Array(n);
  const rawY = new Float32Array(n);
  const clipVisible = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const { src, clip } = outToSrc(inp.clips, i * SIM_DT);
    const p = cursorAt(inp.cursor, src);
    rawX[i] = p.x;
    rawY[i] = p.y;
    clipVisible[i] = clip.showCursor ? 1 : 0;
  }

  // 2. spring smoothing (CUR-09) with smoothing level mapped to tension (CUR-07)
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const move = inp.animation.cursorMove;
  const smoothing = inp.settings.smoothPath.enabled && move !== 'off';
  if (smoothing) {
    const base = resolveSpring(move);
    const level = inp.settings.smoothPath.level / 100; // 0 → stiff, 1 → very smooth
    const tension = base.tension * lerp(2.2, 0.35, level);
    const friction = 2 * Math.sqrt(tension * base.mass) * (base.friction / (2 * Math.sqrt(base.tension * base.mass)));
    let px = rawX[0]!, py = rawY[0]!, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) {
      const ax = (-tension * (px - rawX[i]!) - friction * vx) / base.mass;
      const ay = (-tension * (py - rawY[i]!) - friction * vy) / base.mass;
      vx += ax * SIM_DT; vy += ay * SIM_DT;
      px += vx * SIM_DT; py += vy * SIM_DT;
      x[i] = px; y[i] = py;
    }
  } else {
    x.set(rawX);
    y.set(rawY);
  }

  // 3. click snapping: within ±120 ms of a click, blend to raw so effects land on the button
  const outClicks = clicksToOutput(inp.clicks, inp.clips);
  if (smoothing) {
    const win = 0.12;
    for (const c of outClicks) {
      const i0 = Math.max(0, Math.floor((c.tOut - win) * SIM_HZ));
      const i1 = Math.min(n - 1, Math.ceil((c.tOut + win) * SIM_HZ));
      for (let i = i0; i <= i1; i++) {
        const k = 1 - Math.abs(i * SIM_DT - c.tOut) / win; // triangular weight, 1 at the click
        const w = clamp(k * 1.5, 0, 1);
        x[i] = lerp(x[i]!, rawX[i]!, w);
        y[i] = lerp(y[i]!, rawY[i]!, w);
      }
    }
  }

  // 7. end behaviour: return to start position during the last durationSec
  const end = inp.settings.endBehavior;
  if (end.mode === 'returnToStart' && end.durationSec > 0) {
    const iStart = Math.max(0, n - 1 - Math.round(end.durationSec * SIM_HZ));
    const sx = x[iStart]!, sy = y[iStart]!;
    for (let i = iStart; i < n; i++) {
      const k = (i - iStart) / Math.max(1, n - 1 - iStart);
      const e = 1 - (1 - k) ** 3;
      x[i] = lerp(sx, rawX[0]!, e);
      y[i] = lerp(sy, rawY[0]!, e);
    }
  }

  // 4. rotation: angle + dynamic direction (spring-smoothed)
  const rot = new Float32Array(n);
  {
    let r = inp.settings.angle, vr = 0;
    const aspect = inp.aspect ?? 16 / 9;
    for (let i = 0; i < n; i++) {
      let target = inp.settings.angle;
      if (inp.settings.dynamicDirection && i > 0) {
        const vxs = ((x[i]! - x[i - 1]!) * SIM_HZ) * aspect; // normalised-units/s, aspect-corrected
        target += clamp(vxs * 25, -20, 20);
      }
      const a = -300 * (r - target) - 35 * vr;
      vr += a * SIM_DT;
      r += vr * SIM_DT;
      rot[i] = r;
    }
  }

  // 5. idle hide: speed < eps for afterSec → fade out 200 ms; reappear in 150 ms. 0. global/per-clip show
  const vis = new Float32Array(n);
  const hide = inp.settings.hideWhenIdle;
  const idleSteps = Math.round(hide.afterSec * SIM_HZ);
  let still = 0;
  let v = 1;
  const outRate = SIM_DT / 0.2;
  const inRate = SIM_DT / 0.15;
  for (let i = 0; i < n; i++) {
    const moved = i > 0 && Math.hypot(rawX[i]! - rawX[i - 1]!, rawY[i]! - rawY[i - 1]!) > 1e-4;
    still = moved ? 0 : still + 1;
    let target = 1;
    if (hide.enabled && still >= idleSteps) target = 0;
    if (!inp.settings.show || !clipVisible[i]) target = 0;
    if (hide.animation === 'none' && hide.enabled) v = target;
    else v = target > v ? Math.min(target, v + inRate) : Math.max(target, v - outRate);
    vis[i] = !inp.settings.show || !clipVisible[i] ? 0 : v;
  }

  const data = new Float32Array(n * CUR_CHANNELS);
  for (let i = 0; i < n; i++) {
    data[i * 4] = x[i]!;
    data[i * 4 + 1] = y[i]!;
    data[i * 4 + 2] = rot[i]!;
    data[i * 4 + 3] = vis[i]!;
  }
  return new SampledTrack(CUR_CHANNELS, data);
}

export interface CursorState {
  x: number;
  y: number;
  rotation: number;
  visibility: number;
  shape: number;
}

const scratch = new Float64Array(CUR_CHANNELS);
export function cursorStateAt(track: SampledTrack, t: number, shape: number): CursorState {
  const s = track.sample(t, scratch);
  return { x: s[0]!, y: s[1]!, rotation: s[2]!, visibility: clamp(s[3]!, 0, 1), shape };
}

/** Active click effects at output time t: progress 0..1 over `life` seconds (CUR-05). O(log n + k). */
export function activeClicks(clicks: readonly OutputClick[], t: number, life = 0.5): Array<OutputClick & { progress: number }> {
  let lo = 0, hi = clicks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clicks[mid]!.tOut < t - life) lo = mid + 1;
    else hi = mid;
  }
  const out: Array<OutputClick & { progress: number }> = [];
  for (let i = lo; i < clicks.length && clicks[i]!.tOut <= t; i++) out.push({ ...clicks[i]!, progress: (t - clicks[i]!.tOut) / life });
  return out;
}
