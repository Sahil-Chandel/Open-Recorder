/**
 * Copy / Paste properties and Reset (EDT-08): works on the selected item kind (clip, zoom, layout,
 * annotation) or, with nothing selected, on the active module's settings.
 */
import { cloneData, DEFAULT_ANIMATION, DEFAULT_AUDIO, DEFAULT_CAMERA, DEFAULT_CANVAS, DEFAULT_CURSOR, DEFAULT_KEYS, type Annotation } from '@rec/shared';
import { makeAnnotation } from './panels/AnnotationPanel';
import { toast } from '../ui';
import { useEditor } from './store';

const MODULE_KEY = { video: 'canvas', cursor: 'cursor', camera: 'camera', animations: 'animation', keys: 'keys', audio: 'audio' } as const;

export function copyProps(): void {
  const s = useEditor.getState();
  const p = s.project;
  if (!p) return;
  const { kind, id } = s.selection;
  let data: unknown = null;
  if (kind === 'clip') data = p.clips.find((c) => c.id === id);
  else if (kind === 'zoom') data = p.zooms.find((z) => z.id === id);
  else if (kind === 'layout') data = p.layouts.find((z) => z.id === id);
  else if (kind === 'annotation') data = p.annotations.find((z) => z.id === id);
  else {
    const key = MODULE_KEY[s.module as keyof typeof MODULE_KEY];
    if (key) data = p[key];
  }
  if (!data) return;
  useEditor.setState({ propsClipboard: { kind: kind ?? (s.module as never), data: cloneData(data) } });
  toast('Properties copied');
}

export function pasteProps(): void {
  const s = useEditor.getState();
  const cb = s.propsClipboard;
  if (!cb) return;
  const { kind, id } = s.selection;
  const d = cb.data as Record<string, unknown>;
  if (cb.kind === 'clip' && kind === 'clip') s.edit('Paste clip properties', (p) => { const c = p.clips.find((x) => x.id === id); if (c) { c.speed = d.speed as number; c.showCursor = d.showCursor as boolean; c.volume = cloneData(d.volume) as typeof c.volume; } });
  else if (cb.kind === 'zoom' && kind === 'zoom') s.edit('Paste zoom properties', (p) => { const z = p.zooms.find((x) => x.id === id); if (z) { z.level = d.level as number; z.mode = d.mode as '2d' | '3d'; z.m3d = cloneData(d.m3d) as typeof z.m3d; } });
  else if (cb.kind === 'layout' && kind === 'layout') s.edit('Paste layout properties', (p) => { const l = p.layouts.find((x) => x.id === id); if (l) { l.layoutId = d.layoutId as string; l.transitionSec = d.transitionSec as number; if (d.custom) l.custom = cloneData(d.custom) as typeof l.custom; else delete l.custom; } });
  else if (cb.kind === 'annotation' && kind === 'annotation') s.edit('Paste annotation style', (p) => { const a = p.annotations.find((x) => x.id === id) as Record<string, unknown> | undefined; if (a && a.type === d.type) for (const k of Object.keys(d)) if (!['id', 'start', 'end', 'lane', 'rect', 'text'].includes(k)) a[k] = cloneData(d[k]); });
  else if (!kind) {
    const key = MODULE_KEY[s.module as keyof typeof MODULE_KEY];
    if (key && cb.kind === (s.module as never)) s.edit('Paste properties', (p) => { (p as Record<string, unknown>)[key] = cloneData(d); });
    else return;
  } else return;
  toast('Properties pasted');
}

export function resetSelection(): void {
  const s = useEditor.getState();
  const { kind, id } = s.selection;
  if (kind === 'clip') return s.edit('Reset clip', (p) => { const c = p.clips.find((x) => x.id === id); if (c) { c.speed = 1; c.showCursor = true; c.volume = { mic: 1, system: 1, device: 1 }; } });
  if (kind === 'zoom') return s.edit('Reset zoom', (p) => { const z = p.zooms.find((x) => x.id === id); if (z) { z.level = 2; z.focus = { type: 'follow' }; z.enabled = true; } });
  if (kind === 'layout') return s.edit('Reset layout', (p) => { const l = p.layouts.find((x) => x.id === id); if (l) { l.transitionSec = 0.4; delete l.custom; } });
  if (kind === 'annotation') {
    return s.edit('Reset annotation style', (p) => {
      const a = p.annotations.find((x) => x.id === id);
      if (!a) return;
      const fresh = defaultAnnotationLike(a);
      if (!fresh) return;
      // keep where/when/what; restore look + animation
      Object.assign(a, { ...fresh, id: a.id, start: a.start, end: a.end, lane: a.lane, rect: a.rect, space: a.space, ...('text' in a ? { text: a.text } : {}) });
    });
  }
  if (kind) return; // captions / music: nothing to reset per item — never fall through to module defaults
  const defaults = { video: ['canvas', DEFAULT_CANVAS], cursor: ['cursor', DEFAULT_CURSOR], camera: ['camera', DEFAULT_CAMERA], animations: ['animation', DEFAULT_ANIMATION], keys: ['keys', DEFAULT_KEYS], audio: ['audio', DEFAULT_AUDIO] } as const;
  const entry = defaults[s.module as keyof typeof defaults];
  if (!entry) return;
  s.edit(`Reset ${s.module}`, (p) => {
    const cur = (p as Record<string, unknown>)[entry[0]] as Record<string, unknown>;
    const keep = entry[0] === 'camera' ? { avatar: cur.avatar, visible: cur.visible } : entry[0] === 'canvas' ? { crop: cur.crop } : {};
    (p as Record<string, unknown>)[entry[0]] = { ...cloneData(entry[1]), ...keep };
  });
}
/** A fresh annotation of the same kind (and shape / text preset) as `a`, for Reset. */
function defaultAnnotationLike(a: Annotation): Annotation | null {
  if (a.type === 'text') return makeAnnotation(a.style.preset === 'outline' ? 'text-outline' : a.style.preset === 'pill' ? 'text-pill' : 'text', a.start, a.end, a.lane);
  if (a.type === 'shape') return makeAnnotation(a.shape, a.start, a.end, a.lane);
  return makeAnnotation(a.type, a.start, a.end, a.lane);
}
