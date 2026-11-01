/**
 * Project History (task 4.6, PRJ-01): thumbnails, rename, duration, Created / Last Opened, search,
 * select all + bulk delete (to OS trash), open, show in folder, import, extract sources.
 */
import { Film, FolderOpen, Search, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatTime } from '@rec/shared';
import type { ProjectSummary } from '../../../shared/ipc';
import { api, errMsg } from '../lib/api';
import { Button, cx, Empty, IconButton, TextInput, TitleBar, toast, useConfirm } from '../ui';

const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

export default function Library() {
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sort, setSort] = useState<'lastOpenedAt' | 'createdAt'>('lastOpenedAt');
  const confirm = useConfirm();
  const load = () => api.invoke<ProjectSummary[]>('projects:list').then(setItems).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => void load(), []);
  const shown = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b[sort].localeCompare(a[sort]));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const del = async (ids: string[]) => {
    if (!ids.length) return;
    if (!(await confirm(`Move ${ids.length} project(s) to the Recycle Bin / Trash?`, { danger: true, ok: 'Delete' }))) return;
    const n = await api.invoke<number>('projects:delete', ids);
    toast(`${n} project(s) moved to trash`, 'success');
    setSel(new Set());
    void load();
  };
  return (
    <div className="flex h-full flex-col bg-bg">
      <TitleBar title="Project history">
        <Button size="sm" variant="ghost" onClick={() => api.invoke('projects:sample').then(() => load()).catch((e) => toast(errMsg(e), 'error'))}>Open sample project</Button>
        <Button size="sm" onClick={async () => { try { const d = await api.invoke<string | null>('projects:import'); if (d) { await api.invoke('win:open', 'editor', { dir: d }); void load(); } } catch (e) { toast(errMsg(e), 'error'); } }}><Upload size={14} />Import video</Button>
      </TitleBar>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2 top-2 text-muted" />
          <TextInput placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} className="w-full pl-7" />
        </div>
        <select aria-label="Sort" className="h-8 rounded-lg border border-line bg-panel-2 px-2 text-xs" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="lastOpenedAt">Last opened</option>
          <option value="createdAt">Created</option>
        </select>
        <Button size="sm" onClick={() => setSel(sel.size === shown.length ? new Set() : new Set(shown.map((s) => s.id)))}>{sel.size === shown.length && shown.length ? 'Select none' : 'Select all'}</Button>
        <Button size="sm" variant="danger" disabled={!sel.size} onClick={() => del([...sel])}><Trash2 size={14} />Delete ({sel.size})</Button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {shown.length === 0 ? (
          <Empty icon={<Film size={32} />} title="No projects yet" hint="Recordings and imported videos appear here." />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {shown.map((p) => (
              <div key={p.id} className={cx('group flex flex-col overflow-hidden rounded-xl border bg-panel', sel.has(p.id) ? 'border-accent' : 'border-line')}>
                <button className="relative aspect-video bg-black/50" onClick={() => api.invoke('win:open', 'editor', { dir: p.dir })} aria-label={`Open ${p.name}`}>
                  {p.thumbnail ? <img src={p.thumbnail} alt="" className="h-full w-full object-cover" /> : <Film className="m-auto text-muted" />}
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 text-[11px] tabular-nums text-white">{formatTime(p.durationSec, false)}</span>
                </button>
                <div className="flex flex-col gap-1 p-2.5">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" aria-label="select" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
                    {renaming === p.id ? (
                      <TextInput autoFocus defaultValue={p.name} className="h-6 flex-1 text-xs"
                        onBlur={async (e) => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== p.name) { await api.invoke('projects:rename', p.dir, v); void load(); } }}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                    ) : (
                      <button className="flex-1 truncate text-left text-[13px] font-medium" onDoubleClick={() => setRenaming(p.id)} title="Double-click to rename">{p.name}</button>
                    )}
                  </div>
                  <div className="text-[11px] text-muted">Created {fmtDate(p.createdAt)}</div>
                  <div className="text-[11px] text-muted">Last opened {fmtDate(p.lastOpenedAt)} · {fmtSize(p.sizeBytes)}</div>
                  <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
                    <IconButton label="Show in folder" onClick={() => api.invoke('app:showItemInFolder', p.dir)}><FolderOpen size={14} /></IconButton>
                    <IconButton label="Delete" onClick={() => del([p.id])}><Trash2 size={14} /></IconButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}