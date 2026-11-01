/**
 * Editor shortcuts (SET-06, task 3.11): customisable combos from settings ("Mod" = Ctrl/⌘).
 */
import { useEffect } from 'react';
import { makeZoom, outToSrc, splitAt, splitZoom } from '@rec/shared';
import { api } from '../lib/api';
import { toast } from '../ui';
import { useEditor } from './store';
import { copyProps, pasteProps, resetSelection } from './props';
import { deleteSelection } from './Timeline';

export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const k = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) parts.push(k === '+' ? '=' : k);
  return parts.join('+');
}

export function useEditShortcuts(map: Record<string, string>, ui: { openExport: () => void }): void {
  useEffect(() => {
    const byCombo = new Map(Object.entries(map).map(([action, combo]) => [combo, action]));
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const action = byCombo.get(comboFromEvent(e));
      if (!action) return;
      e.preventDefault();
      const s = useEditor.getState();
      const d = s.derived;
      switch (action) {
        case 'playPause': s.setPlaying(!s.playing); break;
        case 'split': {
          // "Clip" splits what is selected: a zoom at the playhead, otherwise the clip track
          const sel = s.selection;
          if (sel.kind === 'zoom' && sel.id) {
            const src = outToSrc(s.project!.clips, s.time).src;
            const z = s.project!.zooms.find((x) => x.id === sel.id);
            if (z && src > z.start && src < z.end) { s.edit('Split zoom', (p) => { p.zooms = splitZoom(p.zooms, sel.id!, src); }); break; }
          }
          s.edit('Split clip', (p) => { p.clips = splitAt(p.clips, s.time); });
          break;
        }
        case 'crop': window.dispatchEvent(new CustomEvent('editor:crop')); break;
        case 'addZoom': {
          const src = outToSrc(s.project!.clips, s.time).src;
          const z = makeZoom(src, Math.min(s.project!.source.durationSec, src + 3), 2, { type: 'follow' }, 'manual');
          s.edit('Add zoom', (p) => { p.zooms.push(z); });
          s.select('zoom', z.id);
          break;
        }
        case 'save': void s.save().then(() => toast('Saved', 'success')); break;
        case 'saveAs': void api.invoke<string | null>('projects:saveAs', s.dir, s.project).then((d2) => d2 && api.invoke('win:open', 'editor', { dir: d2 })); break;
        case 'toStart': s.setTime(0); break;
        case 'toEnd': s.setTime(d?.duration ?? 0); break;
        case 'zoomInTimeline': s.setTimelineZoom(s.timelineZoom * 1.4); break;
        case 'zoomOutTimeline': s.setTimelineZoom(s.timelineZoom / 1.4); break;
        case 'copyProps': copyProps(); break;
        case 'pasteProps': pasteProps(); break;
        case 'history': void api.invoke('win:open', 'library'); break;
        case 'undo': s.undo(); break;
        case 'redo': s.redo(); break;
        case 'reset': resetSelection(); break;
        case 'delete': deleteSelection(); break;
        case 'export': ui.openExport(); break;
        case 'addText': void import('./panels/AnnotationPanel').then((m) => m.addAnnotation('text')); break;
        case 'addBlur': void import('./panels/AnnotationPanel').then((m) => m.addAnnotation('blur')); break;
        case 'addSpotlight': void import('./panels/AnnotationPanel').then((m) => m.addAnnotation('spotlight')); break;
        case 'addArrow': void import('./panels/AnnotationPanel').then((m) => m.addAnnotation('arrow')); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [map, ui]);
}