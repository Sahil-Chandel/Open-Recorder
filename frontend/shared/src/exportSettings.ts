/**
 * Export settings (plan §4.1, §6.14) — EXP-01…04, SET-07.
 */
import { z } from 'zod';
import { outputSize } from './layout';

export const RESOLUTIONS = ['480p', '720p', '1080p', '2k', '4k', 'original'] as const;
export const FPS_OPTIONS = [10, 20, 24, 25, 30, 50, 60] as const;
export const QUALITIES = ['low', 'medium', 'high', 'best'] as const;

export const ExportSettingsSchema = z.object({
  name: z.string().min(1).max(200),
  dir: z.string(),
  format: z.enum(['mp4', 'gif']),
  resolution: z.enum(RESOLUTIONS),
  fps: z.number().refine((v) => (FPS_OPTIONS as readonly number[]).includes(v), 'unsupported fps'),
  quality: z.enum(QUALITIES),
});
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;

const SHORT: Record<Exclude<(typeof RESOLUTIONS)[number], 'original'>, number> = { '480p': 480, '720p': 720, '1080p': 1080, '2k': 1440, '4k': 2160 };
const BPP: Record<(typeof QUALITIES)[number], number> = { low: 0.05, medium: 0.08, high: 0.12, best: 0.18 };

/** e.g. 1080p @ 9:16 → 1080×1920. "original" uses the source short side. GIF capped at 720p. */
export function exportDimensions(res: ExportSettings['resolution'], aspect: number, sourceShortSide: number, format: 'mp4' | 'gif' = 'mp4'): { width: number; height: number } {
  let short = res === 'original' ? sourceShortSide : SHORT[res];
  if (format === 'gif') short = Math.min(short, 720);
  return outputSize(aspect, short);
}

export function bitrateFor(width: number, height: number, fps: number, quality: ExportSettings['quality']): number {
  return Math.round(BPP[quality] * width * height * fps);
}

/** H.264 High profile codec string by level from resolution × fps (§6.14). */
export function avcCodecFor(width: number, height: number, fps: number): string {
  const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps; // macroblocks per second
  const levels: Array<[number, string]> = [
    [245760, '28'], // 4.0 (1080p30)
    [522240, '2A'], // 4.2 (1080p60)
    [589824, '32'], // 5.0
    [983040, '33'], // 5.1 (4K30)
    [2073600, '34'], // 5.2 (4K60)
    [4177920, '3C'], // 6.0
    [8355840, '3D'], // 6.1
    [16711680, '3E'], // 6.2
  ];
  const lvl = levels.find(([max]) => mbps <= max)?.[1] ?? '3C';
  return `avc1.6400${lvl}`;
}

export function gifSettings(fps: number): { fps: number } {
  return { fps: Math.min(Math.max(fps, 10), 20) };
}

/** Rough GIF size estimate (bytes) — screen content ≈ 0.12 bytes/pixel/frame after palette + LZW. */
export function estimateGifBytes(width: number, height: number, fps: number, durationSec: number): number {
  return Math.round(width * height * Math.min(fps, 20) * durationSec * 0.12);
}

export const DEFAULT_EXPORT: Omit<ExportSettings, 'name' | 'dir'> = { format: 'mp4', resolution: '1080p', fps: 60, quality: 'high' };
