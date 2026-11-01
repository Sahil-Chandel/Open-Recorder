/** Background task registry shown in the task list (SET-12): everything runs locally. */
import { create } from 'zustand';

export interface Task {
  id: string;
  title: string;
  kind: 'export' | 'asr' | 'denoise' | 'segmentation' | 'cloud' | 'other';
  progress: number; // 0..1, -1 = indeterminate
  status: 'running' | 'done' | 'error' | 'cancelled' | 'queued';
  detail?: string;
  startedAt: number;
  cancel?: () => void;
  retry?: () => void;
  result?: () => void;
}

interface TaskStore {
  tasks: Task[];
  upsert: (t: Partial<Task> & { id: string }) => void;
  remove: (id: string) => void;
}

export const useTasks = create<TaskStore>((set) => ({
  tasks: [],
  upsert: (t) =>
    set((s) => {
      const i = s.tasks.findIndex((x) => x.id === t.id);
      if (i < 0) return { tasks: [{ title: 'Task', kind: 'other', progress: -1, status: 'running', startedAt: Date.now(), ...t } as Task, ...s.tasks].slice(0, 50) };
      const next = s.tasks.slice();
      next[i] = { ...next[i]!, ...t };
      return { tasks: next };
    }),
  remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
}));

export function eta(t: Task): string {
  if (t.progress <= 0.01 || t.status !== 'running') return '';
  const el = (Date.now() - t.startedAt) / 1000;
  const rem = (el / t.progress) * (1 - t.progress);
  return rem > 60 ? `${Math.round(rem / 60)} min left` : `${Math.round(rem)} s left`;
}