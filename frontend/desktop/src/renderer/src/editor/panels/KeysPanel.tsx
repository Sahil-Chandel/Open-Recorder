/**
 * Keyboard-shortcut overlay (task 8.6, KEY-02…04): show/hide, single keys, style presets, colors, opacity,
 * size, position presets, and a per-shortcut show/hide list. Plain typing is never rendered.
 */
import { Eye, EyeOff } from 'lucide-react';
import { formatTime, srcToOut } from '@rec/shared';
import { ColorPicker, Section, Segmented, Select, Slider, Toggle } from '../../ui';
import { useEditor } from '../store';
import { edit, useP } from './common';

export function KeysPanel() {
  const k = useP((p) => p.keys);
  const hasTelemetry = useP((p) => p.source.hasTelemetry);
  const clips = useP((p) => p.clips);
  const shortcuts = useEditor((s) => s.derived?.shortcuts ?? []);
  const set = (label: string, f: (x: typeof k) => void, key?: string) => edit(label, (p) => f(p.keys), key);
  if (!hasTelemetry) return <Section title="Keyboard"><div className="text-xs text-muted">No keyboard data for this recording.</div></Section>;
  const pos = typeof k.position === 'string' ? k.position : 'custom';
  return (
    <>
      <Section title="Keyboard shortcuts">
        <Toggle label="Show shortcut keys" checked={k.enabled} onChange={(v) => set('Keyboard overlay', (x) => { x.enabled = v; })} />
        <Toggle label="Also show single keys" hint="Enter, Esc, arrows, F-keys…" checked={k.singleKeys} onChange={(v) => { set('Single keys', (x) => { x.singleKeys = v; }); }} />
        <Select label="Style" value={k.styleId} onChange={(v) => set('Key style', (x) => { x.styleId = v; if (v === 'light') { x.fontColor = '#111111'; x.bgColor = '#ffffff'; } else if (v === 'dark') { x.fontColor = '#ffffff'; x.bgColor = '#111111'; } })}
          options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'pill', label: 'Pill' }, { value: 'keycap', label: 'Keycap' }]} />
        <ColorPicker label="Font color" value={k.fontColor} onChange={(v) => set('Key font color', (x) => { x.fontColor = v; }, 'kfc')} />
        <ColorPicker label="Background color" value={k.bgColor} onChange={(v) => set('Key background', (x) => { x.bgColor = v; }, 'kbg')} />
        <Slider label="Background opacity" value={k.bgOpacity} min={0} max={1} onChange={(v) => set('Key opacity', (x) => { x.bgOpacity = v; }, 'kop')} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Size" value={k.size} min={0.5} max={2.5} onChange={(v) => set('Key size', (x) => { x.size = v; }, 'ksz')} format={(v) => `${v.toFixed(1)}×`} />
        <Segmented size="sm" value={pos} onChange={(v) => v !== 'custom' && set('Key position', (x) => { x.position = v; })}
          options={[{ value: 'bottom-left', label: '↙' }, { value: 'bottom-center', label: '↓' }, { value: 'bottom-right', label: '↘' }, { value: 'top-center', label: '↑' }, { value: 'custom', label: 'Drag' }]} />
        <div className="text-[11px] text-muted">Tip: drag the keys on the preview to place them anywhere.</div>
      </Section>
      <Section title={`Recorded shortcuts (${shortcuts.length})`}>
        {shortcuts.length === 0 && <div className="text-xs text-muted">No shortcuts were pressed in this recording.</div>}
        <div className="flex max-h-72 flex-col gap-1 overflow-auto">
          {shortcuts.map((s) => {
            const hidden = k.hiddenEventIds.includes(s.id);
            const out = srcToOut(clips, s.t);
            return (
              <div key={s.id} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-panel-2">
                <button className="font-mono text-[11px] text-muted" onClick={() => out !== null && useEditor.getState().setTime(out)}>{out === null ? 'cut' : formatTime(out)}</button>
                <span className={`flex-1 text-xs ${hidden ? 'text-muted line-through' : ''}`}>{s.label.join(' + ')}</span>
                <button aria-label={hidden ? 'Show' : 'Hide'} onClick={() => set(hidden ? 'Show shortcut' : 'Hide shortcut', (x) => { x.hiddenEventIds = hidden ? x.hiddenEventIds.filter((i) => i !== s.id) : [...x.hiddenEventIds, s.id]; })}>
                  {hidden ? <EyeOff size={14} className="text-muted" /> : <Eye size={14} />}
                </button>
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}
