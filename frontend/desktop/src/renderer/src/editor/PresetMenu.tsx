/**
 * Preset menu (PRE-01…04): create from current project, apply (partial), rename, set default, delete,
 * import / export `.preset.json`.
 */
import { ChevronDown, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { applyPreset, createPreset, type Preset } from '@rec/shared';
import type { Settings } from '../../../shared/ipc';
import { api, errMsg } from '../lib/api';
import { Button, cx, TextInput, toast, useConfirm } from '../ui';
import { useEditor } from './store';

export function PresetMenu() {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [def, setDef] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const load = async () => {
    setPresets(await api.invoke<Preset[]>('presets:list'));
    setDef((await api.invoke<Settings>('settings:get')).defaultPresetId);
  };
  useEffect(() => {
    if (open) void load();
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const apply = async (pr0: Preset) => {
    const s = useEditor.getState();
    // copy the preset's images (background, watermark, cursor) into this project first
    const pr = await api.invoke<Preset>('presets:materialize', pr0.id, s.dir).catch(() => pr0);
    const { project, report } = applyPreset(s.project!, pr);
    s.edit(`Apply preset “${pr.name}”`, (d) => { Object.assign(d, project); });
    toast(report.skipped.length ? `Applied (skipped: ${report.skipped.join(', ')})` : 'Preset applied', 'success');
  };
  return (
    <div ref={ref} className="no-drag relative">
      <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>Preset <ChevronDown size={13} /></Button>
      {open && (
        <div className="absolute right-0 top-9 z-50 w-80 rounded-xl border border-line bg-panel-2 p-2 shadow-2xl">
          <div className="flex gap-1">
            <TextInput placeholder="New preset name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
            <Button size="sm" variant="primary" disabled={!name.trim()} onClick={async () => {
              try { const st = useEditor.getState(); await api.invoke('presets:save', createPreset(st.project!, name.trim()), st.dir); setName(''); await load(); toast('Preset created', 'success'); } catch (e) { toast(errMsg(e), 'error'); }
            }}>Create</Button>
          </div>
          <div className="mt-2 max-h-72 overflow-auto">
            {presets.length === 0 && <div className="p-3 text-center text-xs text-muted">No presets yet. Style a video, then save it as a preset.</div>}
            {presets.map((p) => (
              <div key={p.id} className="group flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-panel">
                <Star size={13} className={cx(def === p.id ? 'fill-warn text-warn' : 'text-muted')} />
                {renaming === p.id ? (
                  <TextInput autoFocus defaultValue={p.name} className="h-6 flex-1 text-xs" onBlur={async (e) => { setRenaming(null); const v = e.target.value.trim(); if (v && v !== p.name) { await api.invoke('presets:save', { ...p, name: v }); await load(); } }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                ) : (
                  <button className="flex-1 truncate text-left text-[13px]" onClick={() => void apply(p).catch((e) => toast(errMsg(e), 'error'))}>{p.name}</button>
                )}
                <div className="hidden gap-1 group-hover:flex">
                  <button className="text-[11px] text-muted hover:text-text" onClick={() => setRenaming(p.id)}>Rename</button>
                  <button className="text-[11px] text-muted hover:text-text" onClick={async () => { await api.invoke('presets:setDefault', def === p.id ? null : p.id); await load(); }}>{def === p.id ? 'Unset default' : 'Default'}</button>
                  <button className="text-[11px] text-muted hover:text-text" onClick={() => api.invoke<string | null>('presets:export', p.id).then((f) => f && toast('Preset exported', 'success')).catch((e) => toast(errMsg(e), 'error'))}>Export</button>
                  <button className="text-[11px] text-danger" onClick={async () => { if (await confirm(`Delete preset “${p.name}”?`, { danger: true, ok: 'Delete' })) { await api.invoke('presets:delete', p.id); await load(); } }}>Delete</button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between border-t border-line pt-2">
            <Button size="sm" variant="ghost" onClick={async () => { try { if (await api.invoke('presets:import')) { await load(); toast('Preset imported', 'success'); } } catch (e) { toast(errMsg(e), 'error'); } }}>Import…</Button>
            <span className="self-center text-[11px] text-muted">★ default = auto-applied to new recordings</span>
          </div>
        </div>
      )}
    </div>
  );
}