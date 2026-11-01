/**
 * First-run editor tour (task 14.7): a few coach marks anchored to `data-tour` elements, shown once
 * (settings.general.tourDone). Purely visual; never blocks editing — Skip / Esc closes it.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import type { Settings } from '../../../shared/ipc';
import { api } from '../lib/api';
import { Button } from '../ui';

const STEPS: Array<{ target: string; title: string; body: string }> = [
  { target: 'modules', title: 'Style your video', body: 'Each module edits one part of the look: canvas & background, cursor, camera, animations, captions, Smart Cut and more.' },
  { target: 'made-for', title: 'Made for YouTube, Reels, LinkedIn…', body: 'Pick a platform here and the canvas, export size and safe areas are set up for it. Your recording is never re-recorded.' },
  { target: 'timeline', title: 'Your auto zooms', body: 'Zooms were created from your clicks and typing. Drag them, stretch the edges, or click an empty spot on the zoom track to add one.' },
  { target: 'export', title: 'Export or share', body: 'Export MP4 or GIF up to 4K 60 fps, or upload a share link with an optional password.' },
];

export function EditorTour() {
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.hash.split('?')[1]).get('tour') === '0') return; // automated runs
    void api.invoke<Settings>('settings:get').then((s) => { if (!s.general.tourDone) setStep(0); }).catch(() => undefined);
  }, []);

  const finish = () => {
    setStep(null);
    void api.invoke('settings:set', { general: { tourDone: true } }).catch(() => undefined);
  };

  useLayoutEffect(() => {
    if (step === null) return;
    const find = () => setRect(document.querySelector(`[data-tour="${STEPS[step]!.target}"]`)?.getBoundingClientRect() ?? null);
    find();
    window.addEventListener('resize', find);
    const t = setInterval(find, 500); // panels mount lazily
    return () => { window.removeEventListener('resize', find); clearInterval(t); };
  }, [step]);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  if (step === null) return null;
  const s = STEPS[step]!;
  const W = 300;
  // card beside the target, kept on screen
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = rect ? rect.right + 12 : vw / 2 - W / 2;
  let top = rect ? rect.top : vh / 2 - 80;
  if (rect && left + W > vw - 12) left = Math.max(12, rect.left - W - 12);
  if (rect && rect.height > vh * 0.5) top = rect.top + 40;
  if (rect && rect.top > vh * 0.6) top = rect.top - 170;
  top = Math.min(Math.max(12, top), vh - 190);

  return (
    <div className="pointer-events-none fixed inset-0 z-50" aria-live="polite">
      {rect && <div className="absolute rounded-xl ring-2 ring-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.35)] transition-all" style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }} />}
      <div role="dialog" aria-label={s.title} className="pointer-events-auto absolute rounded-xl border border-line bg-panel p-4 shadow-2xl" style={{ left, top, width: W }}>
        <div className="mb-1 text-[11px] text-muted">{step + 1} / {STEPS.length}</div>
        <div className="mb-1 text-sm font-semibold">{s.title}</div>
        <div className="mb-3 text-xs leading-relaxed text-muted">{s.body}</div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={finish}>Skip</Button>
          <Button size="sm" variant="primary" onClick={() => (step + 1 < STEPS.length ? setStep(step + 1) : finish())}>{step + 1 < STEPS.length ? 'Next' : 'Done'}</Button>
        </div>
      </div>
    </div>
  );
}
