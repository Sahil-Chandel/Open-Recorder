/**
 * Social-platform targets (STY-01 "record once, reach all"): one click sets the canvas aspect, the
 * recommended upload size / frame rate for export, and exposes the platform's on-screen UI areas
 * ("safe zones") so captions and key content stay visible.
 *
 * Duration limits and safe zones are the platforms' published guidance as of 2026 and change over time —
 * they drive soft warnings and a preview overlay only, never hard limits.
 */
import { DEFAULT_CAPTION_STYLE } from './defaults';
import type { Aspect, CanvasSettings, CaptionStyle } from './schema';

export type SocialPlatform = 'youtube' | 'tiktok' | 'instagram' | 'linkedin' | 'x' | 'facebook' | 'generic';

/** Canvas fractions covered by the platform's own UI (buttons, captions, progress bar…). */
export interface SafeZone {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SocialTarget {
  id: string;
  platform: SocialPlatform;
  /** full name, e.g. "YouTube Shorts" */
  name: string;
  /** short format label shown under the platform, e.g. "Shorts" */
  format: string;
  aspect: Exclude<Aspect, 'auto'>;
  /** recommended upload size in pixels */
  width: number;
  height: number;
  fps: 30 | 60;
  /** soft limit for the platform's short-form surface; longer videos get a warning */
  maxDurationSec?: number;
  durationNote?: string;
  safeZone?: SafeZone;
}

export const PLATFORM_NAMES: Record<SocialPlatform, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook',
  generic: 'Other',
};

/** Vertical short-form feeds overlay the bottom (title, captions) and right edge (like/comment/share). */
const SHORTS_ZONE: SafeZone = { top: 0.1, bottom: 0.2, left: 0.05, right: 0.15 };
const TIKTOK_ZONE: SafeZone = { top: 0.08, bottom: 0.24, left: 0.05, right: 0.14 };
const REELS_ZONE: SafeZone = { top: 0.13, bottom: 0.22, left: 0.05, right: 0.12 };

export const SOCIAL_TARGETS: SocialTarget[] = [
  { id: 'youtube', platform: 'youtube', name: 'YouTube video', format: 'Video', aspect: '16:9', width: 1920, height: 1080, fps: 60 },
  { id: 'youtube-shorts', platform: 'youtube', name: 'YouTube Shorts', format: 'Shorts', aspect: '9:16', width: 1080, height: 1920, fps: 60, maxDurationSec: 180, safeZone: SHORTS_ZONE },
  { id: 'tiktok', platform: 'tiktok', name: 'TikTok', format: 'Video', aspect: '9:16', width: 1080, height: 1920, fps: 60, durationNote: 'Uploads can be long, but the in-app editor works best with clips under 10 min.', safeZone: TIKTOK_ZONE },
  { id: 'instagram-reels', platform: 'instagram', name: 'Instagram Reels', format: 'Reels', aspect: '9:16', width: 1080, height: 1920, fps: 30, maxDurationSec: 180, safeZone: REELS_ZONE },
  { id: 'instagram-post', platform: 'instagram', name: 'Instagram post', format: 'Post 4:5', aspect: '4:5', width: 1080, height: 1350, fps: 30 },
  { id: 'instagram-square', platform: 'instagram', name: 'Instagram square', format: 'Square', aspect: '1:1', width: 1080, height: 1080, fps: 30 },
  { id: 'linkedin', platform: 'linkedin', name: 'LinkedIn feed', format: 'Feed 1:1', aspect: '1:1', width: 1080, height: 1080, fps: 30, maxDurationSec: 900, durationNote: '10 min when posting from the mobile app.' },
  { id: 'linkedin-portrait', platform: 'linkedin', name: 'LinkedIn portrait', format: 'Portrait 4:5', aspect: '4:5', width: 1080, height: 1350, fps: 30, maxDurationSec: 900, durationNote: '10 min when posting from the mobile app.' },
  { id: 'linkedin-landscape', platform: 'linkedin', name: 'LinkedIn landscape', format: 'Landscape', aspect: '16:9', width: 1920, height: 1080, fps: 30, maxDurationSec: 900, durationNote: '10 min when posting from the mobile app.' },
  { id: 'x', platform: 'x', name: 'X post', format: 'Post', aspect: '16:9', width: 1920, height: 1080, fps: 60, maxDurationSec: 140, durationNote: 'Premium accounts can post longer videos.' },
  { id: 'facebook', platform: 'facebook', name: 'Facebook feed', format: 'Feed 4:5', aspect: '4:5', width: 1080, height: 1350, fps: 30 },
  { id: 'facebook-reels', platform: 'facebook', name: 'Facebook Reels', format: 'Reels', aspect: '9:16', width: 1080, height: 1920, fps: 30, safeZone: REELS_ZONE },
  { id: 'slides', platform: 'generic', name: 'Slides / classic 4:3', format: '4:3', aspect: '4:3', width: 1440, height: 1080, fps: 30 },
];

export const socialTarget = (id: string | undefined): SocialTarget | undefined => (id ? SOCIAL_TARGETS.find((t) => t.id === id) : undefined);

/** Targets grouped by platform, in display order. */
export function targetsByPlatform(): Array<{ platform: SocialPlatform; name: string; targets: SocialTarget[] }> {
  const order: SocialPlatform[] = ['youtube', 'instagram', 'tiktok', 'linkedin', 'x', 'facebook', 'generic'];
  return order.map((platform) => ({ platform, name: PLATFORM_NAMES[platform], targets: SOCIAL_TARGETS.filter((t) => t.platform === platform) }));
}

/** Lowest caption position (0 = bottom … 1 = top) that keeps a caption above the platform's bottom UI. */
export function safeCaptionPosition(target: SocialTarget | undefined): number | null {
  return target?.safeZone ? Math.min(0.5, target.safeZone.bottom + 0.07) : null;
}

/** Default caption style for a canvas — lifted above the bottom UI band of vertical short-form targets. */
export function defaultCaptionStyleFor(canvas: Pick<CanvasSettings, 'target'>): CaptionStyle {
  const style = structuredClone(DEFAULT_CAPTION_STYLE);
  const min = safeCaptionPosition(socialTarget(canvas.target));
  if (min !== null && style.position < min) style.position = min;
  return style;
}

/**
 * Canvas + caption changes for picking a target. Landscape recordings without a camera fill narrow frames
 * (follow the action) instead of letter-boxing a tiny screen into a tall canvas.
 */
export function applySocialTarget(
  target: SocialTarget,
  canvas: CanvasSettings,
  opts: { sourceAspect: number; hasCamera: boolean; captionStyle?: CaptionStyle },
): void {
  canvas.aspect = target.aspect;
  canvas.target = target.id;
  const narrower = aspectValue(target.aspect) < opts.sourceAspect - 0.01;
  canvas.verticalFill = narrower && !opts.hasCamera;
  const minCaption = safeCaptionPosition(target);
  if (opts.captionStyle && minCaption !== null && opts.captionStyle.position < minCaption) opts.captionStyle.position = minCaption;
}

export function aspectValue(a: Exclude<Aspect, 'auto'>): number {
  const [w, h] = a.split(':').map(Number) as [number, number];
  return w / h;
}

/** Soft warning when the output is longer than the target's short-form limit. */
export function durationWarning(target: SocialTarget | undefined, outputSec: number): string | null {
  if (!target?.maxDurationSec || outputSec <= target.maxDurationSec + 0.5) return null;
  const fmt = (s: number) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  return `${target.name} allows up to ${fmt(target.maxDurationSec)} — this video is ${fmt(outputSec)}. Trim it (Smart Cut helps) or post it as a regular video.`;
}
