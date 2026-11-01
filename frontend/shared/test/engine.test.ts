import { describe, expect, it } from 'vitest';
import {
  applySmartCut,
  autoZooms,
  buildCaptionBlocks,
  buildDerived,
  buildShortcutEvents,
  buildSmartCut,
  computeCameraTrack,
  createPreset,
  applyPreset,
  createProject,
  cameraAt,
  decodeCursorBin,
  detectFillers,
  detectSilences,
  detectTypingBursts,
  encodeCursorSamples,
  evaluateScene,
  exportDimensions,
  avcCodecFor,
  layoutAt,
  makeClip,
  makeNsToSource,
  mergeWithNext,
  migrateProject,
  outToSrc,
  outputDuration,
  parsePreset,
  parseSrt,
  removeSourceRanges,
  serializePreset,
  simulateSprings,
  splitAt,
  splitBlock,
  srcToOut,
  speedUpSourceRange,
  SPRINGS,
  toSrt,
  parseJsonl,
  ClickEventSchema,
  canvasToSource,
  sourceToCanvas,
  type ClickEvent,
  type KeyEvent,
  type SourceInfoInput,
  DEFAULT_CAMERA,
  createLogger,
  type LogRecord,
} from '../src';

const source = (dur = 20, extra: Partial<SourceInfoInput> = {}): SourceInfoInput => ({
  kind: 'display', width: 1920, height: 1080, fps: 60, scaleFactor: 1,
  segments: [{ file: 'media/screen_000.mp4', startNs: 0, durationNs: dur * 1e9 }],
  tracks: {}, hasTelemetry: true, durationSec: dur, ...extra,
});

describe('time model', () => {
  it('round-trips out↔src with speed and cuts', () => {
    const clips = [makeClip(0, 10, { speed: 2 }), makeClip(15, 20)];
    expect(outputDuration(clips)).toBeCloseTo(10);
    expect(outToSrc(clips, 2.5).src).toBeCloseTo(5);
    expect(outToSrc(clips, 6).src).toBeCloseTo(16);
    expect(srcToOut(clips, 12)).toBeNull();
    expect(srcToOut(clips, 16)).toBeCloseTo(6);
  });
  it('split + remove ranges + speed-up are consistent', () => {
    const clips = splitAt([makeClip(0, 10)], 4);
    expect(clips).toHaveLength(2);
    expect(clips[0]!.srcEnd).toBeCloseTo(4);
    const cut = removeSourceRanges(clips, [{ start: 2, end: 3 }, { start: 6, end: 7 }]);
    expect(outputDuration(cut)).toBeCloseTo(8);
    const sped = speedUpSourceRange([makeClip(0, 10)], 2, 6, 4);
    expect(outputDuration(sped)).toBeCloseTo(7);
  });
  it('clamps out-of-range lookups', () => {
    const clips = [makeClip(0, 5)];
    expect(outToSrc(clips, -3).src).toBe(0);
    expect(outToSrc(clips, 99).src).toBe(5);
  });
});

describe('springs', () => {
  it('is deterministic and converges', () => {
    const run = () => simulateSprings(3, 1, SPRINGS.slow, [0], (_t, _s, out) => { out[0] = 1; });
    const a = run(); const b = run();
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(a.sample(3)[0]).toBeCloseTo(1, 2);
  });
  it('slow preset has no meaningful overshoot', () => {
    const tr = simulateSprings(3, 1, SPRINGS.slow, [0], (_t, _s, out) => { out[0] = 1; });
    expect(Math.max(...Array.from(tr.data))).toBeLessThan(1.02);
  });
});

describe('telemetry', () => {
  it('cursor.bin round-trips and tolerates truncation', () => {
    const bytes = encodeCursorSamples([{ tNs: 1e9, x: 10.5, y: 20, shape: 3 }, { tNs: 2e9, x: 11, y: 21, shape: 1 }]);
    const dec = decodeCursorBin(bytes.subarray(0, bytes.length - 4));
    expect(dec).toHaveLength(1);
    expect(dec[0]).toEqual({ tNs: 1e9, x: 10.5, y: 20, shape: 3 });
  });
  it('maps ns to source time across pauses', () => {
    const map = makeNsToSource([{ startNs: 0, durationNs: 5e9 }, { startNs: 8e9, durationNs: 2e9 }]);
    expect(map(4e9)).toBeCloseTo(4);
    expect(map(6e9)).toBeNull();
    expect(map(9e9)).toBeCloseTo(6);
  });
  it('parses jsonl leniently', () => {
    const text = '{"t":1,"x":1,"y":1,"button":"left","phase":"down"}\n{"t":2,"x":'; // truncated
    expect(parseJsonl(text, ClickEventSchema)).toHaveLength(1);
  });
  it('detects typing bursts and shortcut combos without leaking characters', () => {
    const keys: KeyEvent[] = [];
    for (let i = 0; i < 10; i++) keys.push({ t: 1 + i * 0.2, mods: [], phase: 'down', printable: true });
    keys.push({ t: 5, code: 'KeyS', mods: ['Ctrl'], phase: 'down', printable: false });
    const bursts = detectTypingBursts(keys);
    expect(bursts).toHaveLength(1);
    const sc = buildShortcutEvents(keys, false);
    expect(sc).toHaveLength(1);
    expect(sc[0]!.label).toEqual(['Ctrl', 'S']);
  });
});

describe('auto zoom', () => {
  const click = (t: number, x: number, y: number): ClickEvent => ({ t, x, y, button: 'left', phase: 'down' });
  it('groups clicks into sessions and adds lead-in/hold', () => {
    const zooms = autoZooms([click(2, 0.2, 0.2), click(3, 0.22, 0.25), click(10, 0.8, 0.8)], [], { duration: 20 });
    expect(zooms).toHaveLength(2);
    expect(zooms[0]!.start).toBeCloseTo(1.5);
    expect(zooms[0]!.end).toBeCloseTo(4.8);
    expect(zooms[0]!.level).toBeGreaterThanOrEqual(1.25);
    expect(zooms[0]!.level).toBeLessThanOrEqual(4);
  });
  it('starts a new session on a big jump after >1s', () => {
    const zooms = autoZooms([click(2, 0.1, 0.1), click(4.5, 0.9, 0.9)], [], { duration: 20, params: { mergeGap: 0 } });
    expect(zooms.length).toBe(2);
  });
  it('camera follows zoom and stays within bounds', () => {
    const clips = [makeClip(0, 10)];
    const zooms = autoZooms([click(2, 0.95, 0.95)], [], { duration: 10 });
    const track = computeCameraTrack({ clips, zooms, cursor: [{ t: 0, x: 0.95, y: 0.95, shape: 0 }], animation: { zoomPan: 'slow', cursorMove: 'medium', motionBlur: { enabled: true, zoom: 50, screen: 50, cursor: 50 } }, fixedZoom: false, viewport: { w: 1, h: 1 } });
    const c = cameraAt(track, 3.5);
    expect(c.z).toBeGreaterThan(1.5);
    expect(c.cx).toBeLessThanOrEqual(1 - 0.5 / c.z + 0.02);
    expect(cameraAt(track, 9.9).z).toBeLessThan(1.2);
  });
  it('fixed zoom part locks onto the clicked area, not the screen centre', () => {
    const clips = [makeClip(0, 10)];
    const zooms = autoZooms([click(2, 0.15, 0.2)], [], { duration: 10 });
    const cursor = [{ t: 0, x: 0.5, y: 0.5, shape: 0 }, { t: 1.6, x: 0.15, y: 0.2, shape: 0 }, { t: 3, x: 0.16, y: 0.21, shape: 0 }];
    const anim = { zoomPan: 'slow' as const, cursorMove: 'medium' as const, motionBlur: { enabled: true, zoom: 50, screen: 50, cursor: 50 } };
    const track = computeCameraTrack({ clips, zooms, cursor, animation: anim, fixedZoom: true, viewport: { w: 1, h: 1 } });
    const c = cameraAt(track, 3.5);
    expect(c.z).toBeGreaterThan(1.5);
    // clamped towards the top-left corner instead of staying at 0.5 / 0.5
    expect(c.cx).toBeLessThan(0.4);
    expect(c.cy).toBeLessThan(0.4);
  });
});

describe('scene + layouts', () => {
  it('evaluates a scene deterministically (preview == export)', () => {
    const p = createProject('Demo', source(10));
    p.zooms = autoZooms([{ t: 2, x: 0.3, y: 0.3, button: 'left', phase: 'down' }], [], { duration: 10 });
    const tel = { cursor: [{ t: 0, x: 0.3, y: 0.3, shape: 0 }, { t: 5, x: 0.6, y: 0.5, shape: 0 }], clicks: [{ t: 2, x: 0.3, y: 0.3, button: 'left' as const, phase: 'down' as const }], keys: [] };
    const d1 = buildDerived(p, tel);
    const d2 = buildDerived(p, tel);
    const s1 = evaluateScene(p, d1, 2.2, 1920, 1080);
    const s2 = evaluateScene(p, d2, 2.2, 1920, 1080);
    expect(s1).toEqual(s2);
    expect(s1.clicks.length).toBe(1);
    expect(s1.cursor).not.toBeNull();
  });
  it('source↔canvas transforms invert', () => {
    const stage = { x: 100, y: 50, w: 1600, h: 900 };
    const cam = { z: 2.3, cx: 0.4, cy: 0.6 };
    const q = sourceToCanvas(stage, { w: 1, h: 1 }, cam, { x: 0.33, y: 0.71 });
    const p = canvasToSource(stage, { w: 1, h: 1 }, cam, q);
    expect(p.x).toBeCloseTo(0.33);
    expect(p.y).toBeCloseTo(0.71);
  });
  it('layout transitions blend between segments', () => {
    const segs = [{ id: 'a', start: 5, end: 10, layoutId: 'camera-full', transitionSec: 0.4 }];
    const mid = layoutAt(segs, DEFAULT_CAMERA, 5.2, 'landscape');
    expect(mid.camera!.w).toBeGreaterThan(0.22);
    expect(mid.camera!.w).toBeLessThan(1);
    expect(layoutAt(segs, DEFAULT_CAMERA, 7, 'landscape').camera!.w).toBe(1);
  });
  it('camera rect moves continuously through a PiP → full-camera transition', () => {
    const p = createProject('Demo', { ...source(10), tracks: { camera: 'media/camera.webm' } });
    p.layouts = [{ id: 'a', start: 5, end: 10, layoutId: 'camera-full', transitionSec: 0.4 }];
    const d = buildDerived(p, { cursor: [], clicks: [], keys: [] });
    const widths = Array.from({ length: 41 }, (_, i) => evaluateScene(p, d, 4.95 + i * 0.0125, 1920, 1080).cameraLayer!.rect.w);
    // monotonic growth, no frame-to-frame jump bigger than a smooth ease would produce
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]! - 1e-6);
      expect(widths[i]! - widths[i - 1]!).toBeLessThan(1920 * 0.08);
    }
    expect(widths.at(-1)!).toBeCloseTo(1920, 0);
  });
  it('a user-drawn (Adjust Layout) camera rect renders exactly as drawn', () => {
    const p = createProject('Demo', { ...source(10), tracks: { camera: 'media/camera.webm' } });
    p.camera.layoutId = 'custom';
    p.camera.customLayout = { orientation: 'landscape', screen: { x: 0, y: 0, w: 1, h: 1 }, camera: { x: 0.1, y: 0.6, w: 0.3, h: 0.2 }, cameraBehindScreen: false };
    const d = buildDerived(p, { cursor: [], clicks: [], keys: [] });
    const r = evaluateScene(p, d, 1, 1000, 1000).cameraLayer!.rect;
    expect(r.x).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(600);
    expect(r.w).toBeCloseTo(300);
    expect(r.h).toBeCloseTo(200);
  });
});

describe('captions', () => {
  const words = 'Hello there this is a test. Another sentence follows here quickly'.split(' ').map((w, i) => ({ w, start: i * 0.4, end: i * 0.4 + 0.35 }));
  it('builds blocks that respect line limits', () => {
    const blocks = buildCaptionBlocks(words);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const b of blocks) for (const line of b.text.split('\n')) expect(line.length).toBeLessThanOrEqual(42);
  });
  it('split / merge / srt round trip', () => {
    const blocks = buildCaptionBlocks(words);
    const split = splitBlock(blocks, blocks[0]!.id, 5);
    expect(split.length).toBe(blocks.length + 1);
    const merged = mergeWithNext(split, split[0]!.id);
    expect(merged.length).toBe(blocks.length);
    const srt = toSrt(blocks);
    const back = parseSrt(srt);
    expect(back.length).toBe(blocks.length);
    expect(back[0]!.start).toBeCloseTo(blocks[0]!.start, 2);
  });
});

describe('smart cut', () => {
  it('finds silence in PCM and fillers in words, then ripple deletes', () => {
    const sr = 16000;
    const pcm = new Float32Array(sr * 4);
    for (let i = 0; i < sr; i++) pcm[i] = Math.sin(i / 5) * 0.5; // 0-1 s loud
    for (let i = sr * 3; i < sr * 4; i++) pcm[i] = Math.sin(i / 5) * 0.5; // 3-4 s loud
    const sil = detectSilences(pcm, sr);
    expect(sil).toHaveLength(1);
    expect(sil[0]!.start).toBeCloseTo(1.15, 1);
    expect(sil[0]!.end).toBeCloseTo(2.85, 1);
    const fillers = detectFillers([{ w: 'Um,', start: 3.1, end: 3.3 }, { w: 'hello', start: 3.3, end: 3.6 }], 'en');
    expect(fillers).toHaveLength(1);
    const res = buildSmartCut('en', sil, fillers);
    const { clips, result } = applySmartCut([makeClip(0, 4)], res);
    expect(outputDuration(clips)).toBeCloseTo(4 - 1.7 - 0.2, 1);
    expect(result.items.every((i) => i.deleted)).toBe(true);
  });
});

describe('presets & migrations', () => {
  it('round-trips presets and applies partially', () => {
    const p = createProject('A', source());
    p.cursor.size = 3;
    const pre = createPreset(p, 'Brand');
    const back = parsePreset(serializePreset(pre));
    const target = createProject('B', source(5, { hasTelemetry: false, kind: 'android' }));
    const { project, report } = applyPreset(target, back);
    expect(report.skipped).toContain('cursor');
    expect(report.skipped).toContain('camera');
    expect(project.cursor.size).not.toBe(3);
  });
  it('migrates v0 and rejects future versions', () => {
    const p = createProject('A', source());
    const { schemaVersion: _v, layouts: _l, ...v0 } = p;
    expect(migrateProject(v0).schemaVersion).toBe(1);
    expect(() => migrateProject({ ...p, schemaVersion: 99 })).toThrow(/newer/);
  });
});

describe('export settings', () => {
  it('computes dimensions and codec levels', () => {
    expect(exportDimensions('1080p', 9 / 16, 1080)).toEqual({ width: 1080, height: 1920 });
    expect(exportDimensions('4k', 16 / 9, 1080)).toEqual({ width: 3840, height: 2160 });
    expect(exportDimensions('4k', 16 / 9, 1080, 'gif').height).toBe(720);
    expect(avcCodecFor(3840, 2160, 60)).toBe('avc1.640034');
    expect(avcCodecFor(1920, 1080, 60)).toBe('avc1.64002A');
  });
});

describe('logger', () => {
  it('redacts secrets', () => {
    const recs: LogRecord[] = [];
    createLogger('t', (r) => recs.push(r)).info('x', { password: 'p', ok: 1 });
    expect(recs[0]!.context).toEqual({ password: '[redacted]', ok: 1 });
  });
});

describe('performance sanity', () => {
  it('10-minute camera + cursor tracks build fast', () => {
    const p = createProject('Long', source(600));
    const cursor = Array.from({ length: 600 * 120 }, (_, i) => ({ t: i / 120, x: 0.5 + 0.3 * Math.sin(i / 500), y: 0.5 + 0.3 * Math.cos(i / 700), shape: 0 }));
    const clicks: ClickEvent[] = Array.from({ length: 200 }, (_, i) => ({ t: i * 3, x: 0.5, y: 0.5, button: 'left', phase: 'down' }));
    p.zooms = autoZooms(clicks, [], { duration: 600 });
    const t0 = performance.now();
    const d = buildDerived(p, { cursor, clicks, keys: [] });
    const ms = performance.now() - t0;
    expect(d.duration).toBeCloseTo(600);
    expect(ms).toBeLessThan(3000);
  });
});
