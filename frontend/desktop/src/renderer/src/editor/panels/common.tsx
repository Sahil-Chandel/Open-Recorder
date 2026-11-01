import type { Draft } from 'immer';
import type { Project } from '@rec/shared';
import { useEditor } from '../store';

/** Select a slice of the project (re-renders only when it changes). */
export function useP<T>(sel: (p: Project) => T): T {
  return useEditor((s) => sel(s.project!));
}

/** Edit helper; `key` coalesces rapid edits (slider drags) into one undo step. */
export function edit(label: string, recipe: (d: Draft<Project>) => void, key?: string): void {
  useEditor.getState().edit(label, recipe, key);
}

export function Swatch({ active, onClick, style, title, children }: { active: boolean; onClick: () => void; style?: React.CSSProperties; title: string; children?: React.ReactNode }) {
  return (
    <button title={title} aria-label={title} aria-pressed={active} onClick={onClick} style={style}
      className={`relative h-12 overflow-hidden rounded-lg border text-[10px] ${active ? 'border-accent ring-2 ring-accent/50' : 'border-line hover:border-muted'}`}>
      {children}
    </button>
  );
}
