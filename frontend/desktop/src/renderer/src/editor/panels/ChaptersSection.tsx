/**
 * Chapters (RM-03): markers in source time, so cuts and speed changes keep them on the right moment.
 * "Copy YouTube chapters" produces the description block YouTube turns into chapter navigation.
 */
import { BookmarkPlus, ClipboardCopy, Trash2 } from 'lucide-react';
import { formatTime, outToSrc, srcToOut, uid, youtubeChapters } from '@rec/shared';
import { Button, Section, toast } from '../../ui';
import { useEditor } from '../store';
import { edit, useP } from './common';

export function ChaptersSection() {
  const chapters = useP((p) => p.chapters);
  const clips = useP((p) => p.clips);
  const sorted = [...chapters].sort((a, b) => a.t - b.t);
  return (
    <Section title="Chapters">
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={() => {
          const s = useEditor.getState();
          const t = outToSrc(s.project!.clips, s.time).src;
          edit('Add chapter', (p) => { p.chapters.push({ id: uid('ch'), t, title: `Chapter ${p.chapters.length + 1}` }); });
        }}><BookmarkPlus size={13} />Add at playhead</Button>
        <Button size="sm" disabled={!chapters.length} onClick={async () => {
          const text = youtubeChapters(chapters, clips);
          await navigator.clipboard.writeText(text);
          toast('YouTube chapters copied — paste them into the video description', 'success');
        }}><ClipboardCopy size={13} />Copy YouTube chapters</Button>
      </div>
      {sorted.length === 0 && <div className="text-[11px] text-muted">Split a long video into sections. YouTube shows them as chapters when the description lists them.</div>}
      <div className="flex flex-col gap-1">
        {sorted.map((c) => {
          const out = srcToOut(clips, c.t);
          return (
            <div key={c.id} className="flex items-center gap-1.5">
              <button className="w-14 shrink-0 font-mono text-[11px] text-muted hover:text-text" disabled={out === null} onClick={() => out !== null && useEditor.getState().setTime(out)}>{out === null ? 'cut' : formatTime(out, false)}</button>
              <input aria-label="Chapter title" className="h-7 min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 text-[12px] outline-none focus:border-accent"
                value={c.title} maxLength={100} onChange={(e) => { const v = e.target.value; edit('Rename chapter', (p) => { const it = p.chapters.find((x) => x.id === c.id); if (it) it.title = v; }, `ch-${c.id}`); }} />
              <button aria-label="Delete chapter" className="text-muted hover:text-danger" onClick={() => edit('Delete chapter', (p) => { p.chapters = p.chapters.filter((x) => x.id !== c.id); })}><Trash2 size={13} /></button>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
