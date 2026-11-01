/** File menu: Save, Save As, Project history, Import video, Extract source files, Show in folder. */
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errMsg, modKey } from '../lib/api';
import { toast } from '../ui';
import { useEditor } from './store';

export function FileMenu({ dir, onExport }: { dir: string; onExport: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);
  const run = (f: () => Promise<unknown> | unknown) => async () => {
    setOpen(false);
    try { await f(); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const items: Array<[string, string, () => Promise<unknown> | unknown]> = [
    ['Save', `${modKey()}+S`, () => useEditor.getState().save().then(() => toast('Saved', 'success'))],
    ['Save as…', `${modKey()}+Shift+S`, async () => { const d = await api.invoke<string | null>('projects:saveAs', dir, useEditor.getState().project); if (d) await api.invoke('win:open', 'editor', { dir: d }); }],
    ['Export…', '', onExport],
    ['Project history', `${modKey()}+H`, () => api.invoke('win:open', 'library')],
    ['Import video…', '', async () => { const d = await api.invoke<string | null>('projects:import'); if (d) await api.invoke('win:open', 'editor', { dir: d }); }],
    ['Extract source files…', '', async () => { const d = await api.invoke<string | null>('projects:extract', dir); if (d) toast('Source files extracted', 'success', { label: 'Show', run: () => api.invoke('app:showItemInFolder', d) }); }],
    ['Show in folder', '', () => api.invoke('app:showItemInFolder', dir)],
    ['New recording', '', () => api.invoke('win:open', 'recorder')],
  ];
  return (
    <div ref={ref} className="no-drag relative">
      <button onClick={() => setOpen(!open)} className="flex h-7 items-center gap-1 rounded-md px-2 text-[13px] hover:bg-panel-2">File <ChevronDown size={13} /></button>
      {open && (
        <div className="absolute left-0 top-8 z-50 w-60 rounded-xl border border-line bg-panel-2 p-1 shadow-2xl" role="menu">
          {items.map(([label, kb, f]) => (
            <button key={label} role="menuitem" onClick={run(f)} className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[13px] hover:bg-accent/20">
              {label}<span className="text-[11px] text-muted">{kb}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}