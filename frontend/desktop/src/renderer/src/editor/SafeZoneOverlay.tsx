/**
 * Preview-only overlay of a social target's UI areas (titles, like/share buttons, progress bar) so captions
 * and key content can be kept inside the visible area. Never rendered into exports.
 */
import { socialTarget } from '@rec/shared';
import type { PlayerGeometry } from './Player';
import { useEditor } from './store';

const HATCH = 'repeating-linear-gradient(135deg, rgba(239,68,68,0.22) 0 6px, rgba(239,68,68,0.08) 6px 12px)';

export function SafeZoneOverlay({ box }: { box: PlayerGeometry['box'] }) {
  const targetId = useEditor((s) => s.project?.canvas.target);
  const show = useEditor((s) => s.safeZones);
  const target = socialTarget(targetId);
  if (!show || !target?.safeZone) return null;
  const z = target.safeZone;
  const pct = (v: number) => `${v * 100}%`;
  const band = (style: React.CSSProperties) => <div className="absolute" style={{ background: HATCH, ...style }} />;
  return (
    <div aria-hidden className="pointer-events-none absolute overflow-hidden rounded-md" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      {band({ left: 0, right: 0, top: 0, height: pct(z.top) })}
      {band({ left: 0, right: 0, bottom: 0, height: pct(z.bottom) })}
      {band({ left: 0, top: pct(z.top), bottom: pct(z.bottom), width: pct(z.left) })}
      {band({ right: 0, top: pct(z.top), bottom: pct(z.bottom), width: pct(z.right) })}
      <div className="absolute border border-dashed border-white/50" style={{ left: pct(z.left), right: pct(z.right), top: pct(z.top), bottom: pct(z.bottom) }} />
      <div className="absolute rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white" style={{ left: pct(z.left), top: `calc(${pct(z.top)} + 4px)`, marginLeft: 4 }}>
        {target.name} safe area
      </div>
    </div>
  );
}
