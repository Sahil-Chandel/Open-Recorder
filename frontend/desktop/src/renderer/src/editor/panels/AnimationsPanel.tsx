/**
 * Animations (tasks 5.6, 6.3, 6.8; ZOOM-06, CUR-09, ANI-01/02): zoom & pan speed presets + custom spring,
 * cursor movement presets + custom/off, motion blur (zoom / screen / cursor, default 50), regenerate zooms.
 */
import { autoZooms, detectTypingBursts, SPRINGS, type Spring, type SpeedPreset } from '@rec/shared';
import { Button, Section, Segmented, Slider, Toggle } from '../../ui';
import { useEditor } from '../store';
import { edit, useP } from './common';

const PRESETS: Array<{ value: SpeedPreset; label: string }> = [
  { value: 'slow', label: 'Slow' }, { value: 'medium', label: 'Medium' }, { value: 'fast', label: 'Fast' }, { value: 'rapid', label: 'Rapid' },
];

function SpringEditor({ value, onChange, label, keyPrefix, allowOff }: { value: SpeedPreset | Spring | 'off'; onChange: (v: SpeedPreset | Spring | 'off', key?: string) => void; label: string; keyPrefix: string; allowOff?: boolean }) {
  const mode = value === 'off' ? 'off' : typeof value === 'string' ? value : 'custom';
  const sp: Spring = typeof value === 'object' ? value : SPRINGS[value === 'off' ? 'medium' : value];
  return (
    <Section title={label}>
      <Segmented size="sm" value={mode} onChange={(v) => onChange(v === 'custom' ? { ...sp } : (v as SpeedPreset | 'off'))}
        options={[...PRESETS, { value: 'custom' as const, label: 'Custom' }, ...(allowOff ? [{ value: 'off' as const, label: 'Off' }] : [])]} />
      {mode === 'custom' && (
        <>
          <Slider label="Tension" value={sp.tension} min={20} max={800} step={1} onChange={(v) => onChange({ ...sp, tension: v }, `${keyPrefix}-t`)} format={(v) => `${Math.round(v)}`} />
          <Slider label="Friction" value={sp.friction} min={2} max={80} step={0.5} onChange={(v) => onChange({ ...sp, friction: v }, `${keyPrefix}-f`)} format={(v) => v.toFixed(1)} />
          <Slider label="Mass" value={sp.mass} min={0.2} max={5} step={0.05} onChange={(v) => onChange({ ...sp, mass: v }, `${keyPrefix}-m`)} format={(v) => v.toFixed(2)} />
          <Button size="sm" onClick={() => onChange(keyPrefix === 'zoom' ? 'slow' : 'medium')}>Reset</Button>
        </>
      )}
    </Section>
  );
}

export function AnimationsPanel() {
  const a = useP((p) => p.animation);
  const hasTelemetry = useP((p) => p.source.hasTelemetry);
  const pct = (v: number) => `${Math.round(v)}`;
  return (
    <>
      <SpringEditor label="Zoom & pan speed" keyPrefix="zoom" value={a.zoomPan} onChange={(v, key) => edit('Zoom speed', (p) => { p.animation.zoomPan = v as SpeedPreset | Spring; }, key)} />
      {hasTelemetry && <SpringEditor label="Cursor movement" keyPrefix="cursor" allowOff value={a.cursorMove} onChange={(v, key) => edit('Cursor movement', (p) => { p.animation.cursorMove = v; }, key)} />}
      <Section title="Motion blur">
        <Toggle label="Motion blur" checked={a.motionBlur.enabled} onChange={(v) => edit('Motion blur', (p) => { p.animation.motionBlur.enabled = v; })} />
        {a.motionBlur.enabled && (
          <>
            <Slider label="Zoom-in blur" value={a.motionBlur.zoom} min={0} max={100} step={1} onChange={(v) => edit('Zoom blur', (p) => { p.animation.motionBlur.zoom = v; }, 'mbz')} format={pct} />
            <Slider label="Screen (camera move) blur" value={a.motionBlur.screen} min={0} max={100} step={1} onChange={(v) => edit('Screen blur', (p) => { p.animation.motionBlur.screen = v; }, 'mbs')} format={pct} />
            {hasTelemetry && <Slider label="Cursor blur" value={a.motionBlur.cursor} min={0} max={100} step={1} onChange={(v) => edit('Cursor blur', (p) => { p.animation.motionBlur.cursor = v; }, 'mbc')} format={pct} />}
            <Button size="sm" onClick={() => edit('Reset motion blur', (p) => { p.animation.motionBlur = { enabled: true, zoom: 50, screen: 50, cursor: 50 }; })}>Reset</Button>
          </>
        )}
      </Section>
      {hasTelemetry && (
        <Section title="Auto zoom">
          <div className="text-xs text-muted">Re-create zooms from clicks and typing. Manual zooms are kept.</div>
          <div className="flex gap-2">
            {(['2d', '3d'] as const).map((m) => (
              <Button key={m} size="sm" onClick={() => {
                const s = useEditor.getState();
                const tel = s.telemetry;
                const gen = autoZooms(tel.clicks, detectTypingBursts(tel.keys, tel.clicks), { duration: s.project!.source.durationSec, mode: m });
                s.edit('Regenerate zooms', (p) => { p.zooms = [...p.zooms.filter((z) => z.source === 'manual'), ...gen]; });
              }}>Regenerate ({m.toUpperCase()})</Button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => edit('Disable all zooms', (p) => { p.zooms.forEach((z) => (z.enabled = false)); })}>Turn off all zooms</Button>
        </Section>
      )}
    </>
  );
}
