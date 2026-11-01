/**
 * Time model (plan §5.3).
 *  SOURCE time = continuous recording (segments concatenated, paused gaps removed).
 *  OUTPUT time = after clip order, deletions and speed changes.
 * All clip operations are pure and return new arrays (command pattern friendly).
 * Complexity: lookups are O(log n) via a prefix-sum index (binary search); edits are O(n) in clip count.
 */
import { makeClip, uid } from './defaults';
import type { Clip } from './schema';

const EPS = 1e-6;

export const clipOutLen = (c: Clip): number => (c.srcEnd - c.srcStart) / c.speed;

/** Prefix sums of output start times — built once per clips array and memoised by identity. */
const indexCache = new WeakMap<readonly Clip[], Float64Array>();
function outStarts(clips: readonly Clip[]): Float64Array {
  let idx = indexCache.get(clips);
  if (!idx) {
    idx = new Float64Array(clips.length + 1);
    for (let i = 0; i < clips.length; i++) idx[i + 1] = idx[i]! + clipOutLen(clips[i]!);
    indexCache.set(clips, idx);
  }
  return idx;
}

export function outputDuration(clips: readonly Clip[]): number {
  const idx = outStarts(clips);
  return idx[clips.length]!;
}

/** Output start time of clip i. */
export function clipOutStart(clips: readonly Clip[], i: number): number {
  return outStarts(clips)[i]!;
}

export interface OutLookup {
  src: number;
  clipIndex: number;
  clip: Clip;
}

/** Output → source. Clamps to [0, duration]. Binary search over prefix sums. */
export function outToSrc(clips: readonly Clip[], t: number): OutLookup {
  if (clips.length === 0) throw new Error('outToSrc: empty clip list');
  const idx = outStarts(clips);
  const total = idx[clips.length]!;
  const tt = Math.min(Math.max(t, 0), total);
  let lo = 0;
  let hi = clips.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx[mid]! <= tt) lo = mid;
    else hi = mid - 1;
  }
  const clip = clips[lo]!;
  const src = Math.min(clip.srcStart + (tt - idx[lo]!) * clip.speed, clip.srcEnd);
  return { src, clipIndex: lo, clip };
}

/** Source → output; null when the source instant was cut out. First matching clip wins. */
export function srcToOut(clips: readonly Clip[], s: number): number | null {
  const idx = outStarts(clips);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    if (s >= c.srcStart - EPS && s <= c.srcEnd + EPS) {
      return idx[i]! + (Math.min(Math.max(s, c.srcStart), c.srcEnd) - c.srcStart) / c.speed;
    }
  }
  return null;
}

/** Map a source range to the output ranges it appears in (a range can be split by cuts). */
export function srcRangeToOut(clips: readonly Clip[], start: number, end: number): Array<[number, number]> {
  const idx = outStarts(clips);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    const a = Math.max(start, c.srcStart);
    const b = Math.min(end, c.srcEnd);
    if (b - a > EPS) out.push([idx[i]! + (a - c.srcStart) / c.speed, idx[i]! + (b - c.srcStart) / c.speed]);
  }
  return out;
}

/** Split the clip under output time t. No-op if t is on a boundary. */
export function splitAt(clips: readonly Clip[], t: number): Clip[] {
  const { src, clipIndex, clip } = outToSrc(clips, t);
  if (src - clip.srcStart < 0.01 || clip.srcEnd - src < 0.01) return clips.slice();
  const left: Clip = { ...clip, id: uid('clip'), srcEnd: src };
  const right: Clip = { ...clip, id: uid('clip'), srcStart: src };
  return [...clips.slice(0, clipIndex), left, right, ...clips.slice(clipIndex + 1)];
}

/** Ripple delete. Refuses to delete the last remaining clip (project needs ≥1). */
export function deleteClip(clips: readonly Clip[], id: string): Clip[] {
  if (clips.length <= 1) return clips.slice();
  return clips.filter((c) => c.id !== id);
}

export function updateClip(clips: readonly Clip[], id: string, patch: Partial<Omit<Clip, 'id'>>): Clip[] {
  return clips.map((c) => (c.id === id ? { ...c, ...patch } : c));
}

export function setSpeedAll(clips: readonly Clip[], speed: number): Clip[] {
  return clips.map((c) => ({ ...c, speed }));
}

/** Trim one edge of a clip in source seconds, bounded by neighbours' sources is not required (clips may overlap). */
export function trimClip(clips: readonly Clip[], id: string, edge: 'start' | 'end', src: number, maxSrc: number): Clip[] {
  return clips.map((c) => {
    if (c.id !== id) return c;
    if (edge === 'start') return { ...c, srcStart: Math.min(Math.max(0, src), c.srcEnd - 0.05) };
    return { ...c, srcEnd: Math.max(Math.min(maxSrc, src), c.srcStart + 0.05) };
  });
}

/**
 * Remove source ranges from every clip (Smart Cut, §6.11). Ranges are subtracted; clips are split as needed.
 * O(n·m) with n clips, m ranges (both small; m sorted once).
 */
export function removeSourceRanges(clips: readonly Clip[], ranges: ReadonlyArray<{ start: number; end: number }>): Clip[] {
  const sorted = [...ranges].filter((r) => r.end - r.start > EPS).sort((a, b) => a.start - b.start);
  const out: Clip[] = [];
  for (const c of clips) {
    let pieces: Array<[number, number]> = [[c.srcStart, c.srcEnd]];
    for (const r of sorted) {
      if (r.end <= c.srcStart || r.start >= c.srcEnd) continue;
      const next: Array<[number, number]> = [];
      for (const [a, b] of pieces) {
        if (r.end <= a || r.start >= b) next.push([a, b]);
        else {
          if (r.start - a > 0.01) next.push([a, r.start]);
          if (b - r.end > 0.01) next.push([r.end, b]);
        }
      }
      pieces = next;
    }
    pieces.forEach(([a, b], i) => out.push(i === 0 && a === c.srcStart && b === c.srcEnd ? c : { ...c, id: uid('clip'), srcStart: a, srcEnd: b }));
  }
  return out.length ? out : [makeClip(clips[0]?.srcStart ?? 0, (clips[0]?.srcStart ?? 0) + 0.1)];
}

/** Speed up a source range (typing speed-up, §6.4): split at range edges and set speed on the inside. */
export function speedUpSourceRange(clips: readonly Clip[], start: number, end: number, speed: number): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const a = Math.max(start, c.srcStart);
    const b = Math.min(end, c.srcEnd);
    if (b - a <= 0.01) {
      out.push(c);
      continue;
    }
    if (a - c.srcStart > 0.01) out.push({ ...c, id: uid('clip'), srcEnd: a });
    out.push({ ...c, id: uid('clip'), srcStart: a, srcEnd: b, speed });
    if (c.srcEnd - b > 0.01) out.push({ ...c, id: uid('clip'), srcStart: b });
  }
  return out;
}

/** Format seconds as m:ss.t (timeline / list UI). */
export function formatTime(sec: number, withTenths = true): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const base = `${m}:${whole.toString().padStart(2, '0')}`;
  return withTenths ? `${base}.${Math.floor((r - whole) * 10)}` : base;
}
