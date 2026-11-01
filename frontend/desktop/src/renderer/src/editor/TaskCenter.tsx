/** Task list (SET-12): exports, captions, noise reduction, enhancement — progress %, ETA, cancel, retry, open result. */
import { X } from 'lucide-react';
import { Button, Empty, IconButton } from '../ui';
import { eta, useTasks } from './tasks';

export function TaskCenter({ onClose }: { onClose: () => void }) {
  const { tasks, remove } = useTasks();
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-panel" aria-label="Task center">
      <header className="flex h-10 items-center justify-between border-b border-line px-3 text-[13px] font-semibold">
        Task center
        <IconButton label="Close" onClick={onClose}><X size={14} /></IconButton>
      </header>
      <div className="flex-1 overflow-auto p-2">
        {tasks.length === 0 && <Empty title="No tasks yet" hint="Exports, captions, noise reduction and AI jobs show up here." />}
        {tasks.map((t) => (
          <div key={t.id} className="mb-2 rounded-lg border border-line bg-panel-2 p-2.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate font-medium">{t.title}</span>
              <span className={t.status === 'error' ? 'text-danger' : t.status === 'done' ? 'text-ok' : 'text-muted'}>{t.status === 'running' && t.progress >= 0 ? `${Math.round(t.progress * 100)}%` : t.status}</span>
            </div>
            {t.status === 'running' && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                <div className={t.progress < 0 ? 'h-full w-1/3 animate-pulse bg-accent' : 'h-full bg-accent transition-[width]'} style={t.progress >= 0 ? { width: `${t.progress * 100}%` } : undefined} />
              </div>
            )}
            {(t.detail || eta(t)) && <div className="mt-1 text-[11px] text-muted">{t.detail} {eta(t)}</div>}
            <div className="mt-1.5 flex gap-1">
              {t.status === 'running' && t.cancel && <Button size="sm" onClick={t.cancel}>Cancel</Button>}
              {t.status === 'error' && t.retry && <Button size="sm" onClick={t.retry}>Retry</Button>}
              {t.status === 'done' && t.result && <Button size="sm" onClick={t.result}>Open</Button>}
              {t.status !== 'running' && <Button size="sm" variant="ghost" onClick={() => remove(t.id)}>Dismiss</Button>}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}