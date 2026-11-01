import { describe, expect, it } from 'vitest';
import {
  applySocialTarget,
  ASPECTS,
  canvasAspect,
  createProject,
  DEFAULT_CAPTION_STYLE,
  defaultCaptionStyleFor,
  durationWarning,
  exportDimensions,
  ProjectSchema,
  safeCaptionPosition,
  SOCIAL_TARGETS,
  socialTarget,
  targetsByPlatform,
} from '../src';

const project = () => createProject('t', { kind: 'display', width: 1920, height: 1080, fps: 60, scaleFactor: 1, segments: [{ file: 'media/screen_000.mp4', startNs: 0, durationNs: 10e9 }], tracks: {}, hasTelemetry: true, durationSec: 10 });

describe('social targets', () => {
  it('cover the platforms people ask for, with unique ids', () => {
    const ids = SOCIAL_TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['youtube', 'youtube-shorts', 'instagram-reels', 'tiktok', 'linkedin', 'x', 'facebook']) expect(socialTarget(id)).toBeDefined();
    expect(targetsByPlatform().flatMap((g) => g.targets)).toHaveLength(SOCIAL_TARGETS.length);
  });

  it('recommended sizes match their aspect, and 1080p export produces exactly that size', () => {
    for (const t of SOCIAL_TARGETS) {
      expect(Math.abs(t.width / t.height - ASPECTS[t.aspect])).toBeLessThan(0.01);
      expect(exportDimensions('1080p', ASPECTS[t.aspect], 1080)).toEqual({ width: t.width, height: t.height });
    }
  });

  it('applying a vertical target sets aspect, fills the frame without a camera and lifts captions', () => {
    const p = project();
    const style = structuredClone(DEFAULT_CAPTION_STYLE);
    applySocialTarget(socialTarget('youtube-shorts')!, p.canvas, { sourceAspect: 16 / 9, hasCamera: false, captionStyle: style });
    expect(p.canvas.aspect).toBe('9:16');
    expect(p.canvas.target).toBe('youtube-shorts');
    expect(p.canvas.verticalFill).toBe(true);
    expect(style.position).toBeGreaterThanOrEqual(safeCaptionPosition(socialTarget('youtube-shorts'))!);
    expect(ProjectSchema.safeParse(p).success).toBe(true);
    expect(canvasAspect(p.canvas, 1920, 1080)).toBeCloseTo(9 / 16);
  });

  it('keeps letter-boxing when a camera can share the frame, and never fills for wider canvases', () => {
    const p = project();
    applySocialTarget(socialTarget('instagram-reels')!, p.canvas, { sourceAspect: 16 / 9, hasCamera: true });
    expect(p.canvas.verticalFill).toBe(false);
    applySocialTarget(socialTarget('youtube')!, p.canvas, { sourceAspect: 16 / 9, hasCamera: false });
    expect(p.canvas.verticalFill).toBe(false);
    applySocialTarget(socialTarget('instagram-post')!, p.canvas, { sourceAspect: 16 / 9, hasCamera: false });
    expect(p.canvas.aspect).toBe('4:5');
    expect(p.canvas.verticalFill).toBe(true);
  });

  it('defaults caption height per target', () => {
    expect(defaultCaptionStyleFor({}).position).toBe(DEFAULT_CAPTION_STYLE.position);
    expect(defaultCaptionStyleFor({ target: 'tiktok' }).position).toBeGreaterThan(0.24);
    expect(defaultCaptionStyleFor({ target: 'youtube' }).position).toBe(DEFAULT_CAPTION_STYLE.position);
  });

  it('warns only past the short-form limit, with m:ss formatting', () => {
    const shorts = socialTarget('youtube-shorts');
    expect(durationWarning(shorts, 180)).toBeNull();
    expect(durationWarning(shorts, 179.6)).toBeNull();
    expect(durationWarning(shorts, 241)).toMatch(/3:00.*4:01/);
    expect(durationWarning(socialTarget('x'), 150)).toMatch(/2:20/);
    expect(durationWarning(socialTarget('youtube'), 7200)).toBeNull();
    expect(durationWarning(undefined, 7200)).toBeNull();
  });
});

describe('preset assets', () => {
  it('maps every asset reference and recognises project-relative paths', async () => {
    const { createPreset, mapPresetAssets, isProjectAssetRef } = await import('../src');
    const p = createProject('t', { kind: 'display', width: 1920, height: 1080, fps: 60, scaleFactor: 1, segments: [{ file: 'media/screen_000.mp4', startNs: 0, durationNs: 1e9 }], tracks: {}, hasTelemetry: true, durationSec: 1 });
    p.canvas.background = { type: 'image', value: 'assets/bg.png' };
    p.watermark = { file: 'assets/logo.png', x: 0.9, y: 0.9, scale: 0.2, opacity: 1, visible: true };
    const seen: string[] = [];
    const mapped = mapPresetAssets(createPreset(p, 'x'), (r) => { seen.push(r); return `preset:abc/${r.split('/').pop()}`; });
    expect(seen.sort()).toEqual(['assets/bg.png', 'assets/logo.png']);
    expect(mapped.canvas.background.value).toBe('preset:abc/bg.png');
    expect(isProjectAssetRef('assets/bg.png')).toBe(true);
    for (const r of ['preset:abc/bg.png', 'rec-media://local/x', 'C:\\x.png', '/x.png', 'https://a/b.png']) expect(isProjectAssetRef(r)).toBe(false);
  });
});

describe('chapters', () => {
  it('formats YouTube chapters in output time, starting at 00:00 and skipping cut-out ones', async () => {
    const { youtubeChapters, makeClip } = await import('../src');
    const clips = [makeClip(0, 30), makeClip(60, 200)]; // 30–60 s cut out
    const text = youtubeChapters([{ t: 90, title: 'Setup' }, { t: 45, title: 'Gone' }, { t: 10, title: 'Why' }], clips);
    expect(text.split('\n')).toEqual(['00:00 Intro', '00:10 Why', '01:00 Setup']);
    expect(youtubeChapters([], clips)).toBe('');
    expect(youtubeChapters([{ t: 0.2, title: 'Start' }], clips)).toBe('00:00 Start');
  });
});
