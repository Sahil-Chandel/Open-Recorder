/**
 * Editor output meter (audit B3): post-limiter L/R peak bars (−60…0 dBFS) with 1 s peak-hold, polled from
 * the live PreviewAudio graph every animation frame. Drawn on a tiny canvas with preallocated buffers —
 * no React state, no allocation per frame, and no redraw while the levels are idle.
 */
import { useEffect, useRef } from 'react';
import { PreviewAudio } from '../audio/engine';

const W = 96;
const H = 14;
const DB_MIN = -60;
/** zone edges as fractions of the −60…0 dB scale: −12 dBFS and −3 dBFS */
const Z_WARN = (DB_MIN + 12) / DB_MIN;
const Z_HOT = (DB_MIN + 3) / DB_MIN;

export const levelToFraction = (lin: number): number => (lin > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(lin) - DB_MIN) / -DB_MIN)) : 0);

export function AudioMeter() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const bg = color('--color-line', '#2a2a36');
    const ok = color('--color-ok', '#22c55e');
    const warn = color('--color-warn', '#f59e0b');
    const hot = color('--color-danger', '#ef4444');
    const lv = new Float32Array(4);
    const shown = new Float32Array(2);
    const hold = new Float32Array(2);
    const holdAt = new Float64Array(2);
    let last = performance.now();
    let raf = 0;
    let drawn = false;
    const bw = c.width, barH = Math.round(4 * dpr), gap = Math.round(2 * dpr), y0 = Math.round((c.height - 2 * barH - gap) / 2);
    const bar = (y: number, frac: number, peak: number) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, y, bw, barH);
      const x = frac * bw;
      ctx.fillStyle = ok;
      ctx.fillRect(0, y, Math.min(x, Z_WARN * bw), barH);
      if (x > Z_WARN * bw) {
        ctx.fillStyle = warn;
        ctx.fillRect(Z_WARN * bw, y, Math.min(x, Z_HOT * bw) - Z_WARN * bw, barH);
      }
      if (x > Z_HOT * bw) {
        ctx.fillStyle = hot;
        ctx.fillRect(Z_HOT * bw, y, x - Z_HOT * bw, barH);
      }
      if (peak > 0.01) {
        ctx.fillStyle = peak > Z_HOT ? hot : peak > Z_WARN ? warn : ok;
        ctx.fillRect(Math.min(bw - dpr, peak * bw), y, Math.max(1, dpr), barH);
      }
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const pa = PreviewAudio.active;
      if (pa) pa.levels(lv);
      else lv.fill(0);
      let changed = !drawn;
      for (let ch = 0; ch < 2; ch++) {
        const target = levelToFraction(lv[ch]!);
        // instant attack, ~24 dB/s fall-back (PPM-like ballistics)
        const next = target >= shown[ch]! ? target : Math.max(target, shown[ch]! - dt * 0.4);
        if (Math.abs(next - shown[ch]!) > 1e-4) changed = true;
        shown[ch] = next;
        if (next >= hold[ch]!) {
          hold[ch] = next;
          holdAt[ch] = now;
        } else if (now - holdAt[ch]! > 1000 && hold[ch]! > next) {
          hold[ch] = Math.max(next, hold[ch]! - dt * 0.6);
          changed = true;
        }
      }
      if (!changed) return;
      drawn = true;
      ctx.clearRect(0, 0, c.width, c.height);
      bar(y0, shown[0]!, hold[0]!);
      bar(y0 + barH + gap, shown[1]!, hold[1]!);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} role="img" aria-label="Output level meter, left and right" title="Output level (L / R)" className="shrink-0" style={{ width: W, height: H }} />;
}
