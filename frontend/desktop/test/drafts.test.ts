/**
 * Every editor action runs inside an Immer recipe, where project objects are Proxy drafts. structuredClone
 * throws DataCloneError on those, which used to break Smart Cut delete/reset, zoom split, "apply to all
 * zooms", annotation duplicate and One-click Pro Edit. These run the same calls on real drafts.
 */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import {
  applyPreset,
  applySmartCut,
  applyZoomSettingsToAll,
  buildSmartCut,
  cloneData,
  createPreset,
  createProject,
  makeZoom,
  ProjectSchema,
  resetSmartCut,
  splitZoom,
  type Project,
} from '@rec/shared';

function project(): Project {
  const p = createProject('drafts', { kind: 'display', width: 1920, height: 1080, fps: 60, scaleFactor: 1, segments: [{ file: 'media/screen_000.mp4', startNs: 0, durationNs: 20e9 }], tracks: {}, hasTelemetry: true, durationSec: 20 });
  p.zooms = [makeZoom(1, 6, 2, { type: 'follow' }, 'manual', '3d'), makeZoom(8, 12, 1.5, { type: 'follow' }, 'manual')];
  return Object.freeze(p) as Project; // the store hands out frozen state, like Immer does
}

describe('edit recipes on Immer drafts', () => {
  it('split zoom and apply-to-all work on draft zooms', () => {
    const base = project();
    const id = base.zooms[0]!.id;
    const split = produce(base, (p) => { p.zooms = splitZoom(p.zooms, id, 3); });
    expect(split.zooms).toHaveLength(3);
    const all = produce(base, (p) => { p.zooms = applyZoomSettingsToAll(p.zooms, id); });
    expect(all.zooms[1]!.mode).toBe('3d');
    expect(all.zooms[1]!.m3d).toEqual(base.zooms[0]!.m3d);
    expect(all.zooms[1]!.m3d).not.toBe(base.zooms[0]!.m3d);
  });

  it('smart cut delete + reset round-trip on drafts', () => {
    const base = produce(project(), (p) => { p.smartCut = buildSmartCut('en', [{ start: 2, end: 3 }, { start: 10, end: 11 }], []); });
    const cut = produce(base, (p) => {
      const before = p.smartCut!.clipsBefore ?? cloneData(p.clips);
      const r = applySmartCut(p.clips, p.smartCut!);
      p.clips = r.clips;
      p.smartCut = { ...r.result, clipsBefore: before };
    });
    expect(cut.clips.length).toBeGreaterThan(1);
    expect(cut.smartCut!.items.every((i) => i.deleted)).toBe(true);
    const reset = produce(cut, (p) => {
      if (p.smartCut?.clipsBefore) p.clips = p.smartCut.clipsBefore;
      p.smartCut = { ...resetSmartCut(p.smartCut!), clipsBefore: undefined };
    });
    expect(reset.clips).toEqual(base.clips);
    expect(reset.smartCut!.items.every((i) => !i.deleted && i.selected)).toBe(true);
    expect(ProjectSchema.safeParse(reset).success).toBe(true);
  });

  it('presets apply to drafts and annotations duplicate from drafts', () => {
    const base = project();
    const preset = createPreset(produce(base, (p) => { p.canvas.padding = 0.2; }), 'wide');
    const applied = produce(base, (p) => applyPreset(p as Project, preset).project);
    expect(applied.canvas.padding).toBe(0.2);
    const withText = produce(base, (p) => {
      p.annotations.push({ id: 'a1', type: 'text', start: 1, end: 2, lane: 0, space: 'canvas', rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, rotation: 0, anim: { in: 'fade', out: 'fade', durSec: 0.3 }, text: 'Hi', style: {} } as never);
    });
    const dup = produce(withText, (p) => {
      const it = p.annotations[0]!;
      p.annotations.push({ ...cloneData(it), id: 'a2' });
    });
    expect(dup.annotations).toHaveLength(2);
    expect(dup.annotations[1]!.rect).toEqual(dup.annotations[0]!.rect);
  });
});
