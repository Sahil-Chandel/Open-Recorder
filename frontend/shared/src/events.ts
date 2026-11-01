/**
 * Input telemetry (plan §5.1): cursor.bin, clicks.jsonl, keys.jsonl, windows.jsonl.
 * Helpers stamp events in ns since t0 (monotonic). The editor works in SOURCE seconds:
 * segment-relative time with paused gaps removed (§4.4.3).
 */
import { z } from 'zod';

/** 18-byte packed record: int64 tNs | float32 x | float32 y | uint16 shapeId (little-endian). */
export const CURSOR_RECORD_BYTES = 18;

export interface CursorSample {
  t: number; // source seconds once mapped; ns while raw
  x: number;
  y: number;
  shape: number;
}

export function encodeCursorSamples(samples: ReadonlyArray<{ tNs: number; x: number; y: number; shape: number }>): Uint8Array {
  const buf = new Uint8Array(samples.length * CURSOR_RECORD_BYTES);
  const dv = new DataView(buf.buffer);
  samples.forEach((s, i) => {
    const o = i * CURSOR_RECORD_BYTES;
    dv.setBigInt64(o, BigInt(Math.round(s.tNs)), true);
    dv.setFloat32(o + 8, s.x, true);
    dv.setFloat32(o + 12, s.y, true);
    dv.setUint16(o + 16, s.shape, true);
  });
  return buf;
}

/** Decodes; a truncated trailing record (crash mid-write) is ignored rather than failing. */
export function decodeCursorBin(bytes: Uint8Array): Array<{ tNs: number; x: number; y: number; shape: number }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / CURSOR_RECORD_BYTES);
  const out = new Array<{ tNs: number; x: number; y: number; shape: number }>(n);
  for (let i = 0; i < n; i++) {
    const o = i * CURSOR_RECORD_BYTES;
    out[i] = { tNs: Number(dv.getBigInt64(o, true)), x: dv.getFloat32(o + 8, true), y: dv.getFloat32(o + 12, true), shape: dv.getUint16(o + 16, true) };
  }
  return out;
}

export const ClickEventSchema = z.object({
  t: z.number(),
  x: z.number(),
  y: z.number(),
  button: z.enum(['left', 'right', 'middle']),
  phase: z.enum(['down', 'up']),
});
export type ClickEvent = z.infer<typeof ClickEventSchema>;

export const KeyEventSchema = z.object({
  t: z.number(),
  code: z.string().optional(), // only for shortcuts / non-printing keys (privacy, §5.1)
  mods: z.array(z.enum(['Meta', 'Ctrl', 'Alt', 'Shift'])),
  phase: z.enum(['down', 'up']),
  printable: z.boolean(),
});
export type KeyEvent = z.infer<typeof KeyEventSchema>;

export const WindowEventSchema = z.object({ t: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type WindowEvent = z.infer<typeof WindowEventSchema>;

/** Parse JSONL leniently: invalid or truncated lines are skipped (crash-safe append-only logs). */
export function parseJsonl<T>(text: string, schema: z.ZodType<T>): T[] {
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = schema.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      /* truncated line from a crash — skip */
    }
  }
  return out;
}

export interface Segment {
  startNs: number;
  durationNs: number;
}

/** Map helper ns timestamps to source seconds. Returns null for instants during pauses. O(log n) per call. */
export function makeNsToSource(segments: readonly Segment[]): (tNs: number) => number | null {
  const starts = segments.map((s) => s.startNs);
  const offsets: number[] = [];
  let acc = 0;
  for (const s of segments) {
    offsets.push(acc);
    acc += s.durationNs;
  }
  return (tNs) => {
    let lo = 0;
    let hi = starts.length - 1;
    if (hi < 0 || tNs < starts[0]!) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= tNs) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo]!;
    const rel = tNs - seg.startNs;
    if (rel > seg.durationNs) return null;
    return (offsets[lo]! + rel) / 1e9;
  };
}

export interface Telemetry {
  /** Cursor positions in SOURCE seconds and normalised 0..1 source-frame coords. Sorted by t. */
  cursor: CursorSample[];
  clicks: ClickEvent[]; // t in source seconds, x/y normalised
  keys: KeyEvent[]; // t in source seconds
}

export const emptyTelemetry = (): Telemetry => ({ cursor: [], clicks: [], keys: [] });

/** Normalise raw helper telemetry (ns, source-frame pixels) into source-seconds + 0..1. */
export function normaliseTelemetry(
  raw: { cursor: Array<{ tNs: number; x: number; y: number; shape: number }>; clicks: ClickEvent[]; keys: KeyEvent[] },
  segments: readonly Segment[],
  width: number,
  height: number,
): Telemetry {
  const map = makeNsToSource(segments);
  const cursor: CursorSample[] = [];
  for (const c of raw.cursor) {
    const t = map(c.tNs);
    if (t !== null) cursor.push({ t, x: c.x / width, y: c.y / height, shape: c.shape });
  }
  cursor.sort((a, b) => a.t - b.t);
  const clicks: ClickEvent[] = [];
  for (const c of raw.clicks) {
    const t = map(c.t);
    if (t !== null) clicks.push({ ...c, t, x: c.x / width, y: c.y / height });
  }
  const keys: KeyEvent[] = [];
  for (const k of raw.keys) {
    const t = map(k.t);
    if (t !== null) keys.push({ ...k, t });
  }
  return { cursor, clicks, keys };
}

/** Cursor position at source time t by binary search + linear interpolation. */
export function cursorAt(samples: readonly CursorSample[], t: number): { x: number; y: number; shape: number } {
  if (samples.length === 0) return { x: 0.5, y: 0.5, shape: 0 };
  if (t <= samples[0]!.t) return samples[0]!;
  const last = samples[samples.length - 1]!;
  if (t >= last.t) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const k = (t - a.t) / Math.max(b.t - a.t, 1e-9);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, shape: k < 0.5 ? a.shape : b.shape };
}

// ---------------------------------------------------------------- typing (§6.4)

export interface TypingBurst {
  start: number;
  end: number;
  count: number;
  caret?: { x: number; y: number };
}

/** ≥6 printable key-downs without Ctrl/⌘/Alt, inter-key gap < 1.2 s. O(n). */
export function detectTypingBursts(keys: readonly KeyEvent[], clicks: readonly ClickEvent[] = [], minKeys = 6, maxGap = 1.2): TypingBurst[] {
  const bursts: TypingBurst[] = [];
  let cur: TypingBurst | null = null;
  let last = -Infinity;
  for (const k of keys) {
    if (k.phase !== 'down') continue;
    const typing = k.printable && !k.mods.some((m) => m === 'Ctrl' || m === 'Meta' || m === 'Alt');
    if (!typing) continue;
    if (cur && k.t - last < maxGap) {
      cur.end = k.t;
      cur.count++;
    } else {
      if (cur && cur.count >= minKeys) bursts.push(cur);
      cur = { start: k.t, end: k.t, count: 1 };
    }
    last = k.t;
  }
  if (cur && cur.count >= minKeys) bursts.push(cur);
  // caret fallback = last click before the burst (§6.3)
  for (const b of bursts) {
    let best: ClickEvent | undefined;
    for (const c of clicks) if (c.phase === 'down' && c.t <= b.start) best = c;
    if (best) b.caret = { x: best.x, y: best.y };
  }
  return bursts;
}

export interface SpeedUpSuggestion {
  id: string;
  start: number;
  end: number;
  speed: number;
}

/** Bursts longer than 3 s → suggestion with speed 2×–4× by length. */
export function speedUpSuggestions(bursts: readonly TypingBurst[]): SpeedUpSuggestion[] {
  return bursts
    .filter((b) => b.end - b.start > 3)
    .map((b) => {
      const len = b.end - b.start;
      const speed = len > 20 ? 4 : len > 8 ? 3 : 2;
      return { id: `spd_${Math.round(b.start * 1000)}`, start: b.start, end: b.end, speed };
    });
}

// ---------------------------------------------------------------- shortcut overlay (KEY-02)

export interface ShortcutEvent {
  id: string;
  t: number;
  label: string[]; // e.g. ['Ctrl', 'Shift', 'S']
  duration: number;
}

const NON_PRINTING = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space']);

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: '⌫', Enter: '↵', Space: 'Space',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
  };
  return map[code] ?? code;
}

/** cursor.bin shape id the helper writes while the OS cursor is hidden. */
export const CURSOR_HIDDEN = 65535;

/** Build overlay events from key-downs: modifier combos always; single non-printing keys if enabled. */
export function buildShortcutEvents(keys: readonly KeyEvent[], singleKeys: boolean, mac = false): ShortcutEvent[] {
  const out: ShortcutEvent[] = [];
  for (const k of keys) {
    if (k.phase !== 'down' || !k.code) continue;
    if (/^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(k.code)) continue;
    const hasMods = k.mods.some((m) => m !== 'Shift');
    const single = !hasMods && (NON_PRINTING.has(k.code) || /^F\d+$/.test(k.code));
    if (!hasMods && !(singleKeys && single)) continue;
    const modLabels = k.mods.map((m) => (mac ? { Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }[m] : { Meta: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }[m]));
    const prev = out[out.length - 1];
    const label = [...modLabels, keyLabel(k.code)];
    // collapse auto-repeat of the same combo within 150 ms
    if (prev && prev.label.join('+') === label.join('+') && k.t - prev.t < prev.duration + 0.15) {
      prev.duration = k.t - prev.t + 0.9;
      continue;
    }
    out.push({ id: `key_${Math.round(k.t * 1000)}_${label.join('+')}`, t: k.t, label, duration: 0.9 });
  }
  return out;
}
