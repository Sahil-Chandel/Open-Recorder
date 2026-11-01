/**
 * Smart Cut (task 10.6/10.7, CUT-01…04): recognition (free when captions exist), transcript with silence
 * chips and highlighted fillers (all pre-selected), toggle items, "Delete (N)" ripple cut, filter deleted,
 * Reset to the initial recognition state. Fully undoable.
 */
import { useState } from 'react';
import { applySmartCut, buildSmartCut, cloneData, CAPTION_LANGUAGES, detectFillers, detectSilences, formatTime, srcRangeToOut, srcToOut, type CaptionWord } from '@rec/shared';
import { api, errMsg } from '../../lib/api';
import { Button, Section, Select, Slider, toast, Toggle } from '../../ui';
import { mediaUrl } from '../media';
import { useEditor } from '../store';
import { edit, useP } from './common';
import { recognise } from './CaptionsPanel';

async function micPcm(): Promise<{ pcm: Float32Array; sr: number; offset: number } | null> {
  const s = useEditor.getState();
  const p = s.project!;
  const rel = p.source.tracks.mic ?? p.source.tracks.system;
  if (!rel) return null;
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await fetch(mediaUrl(s.opened!.mediaBase, rel)).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
  return { pcm: buf.getChannelData(0), sr: buf.sampleRate, offset: p.source.trackOffsets[p.source.tracks.mic ? 'mic' : 'system'] ?? 0 };
}

export function SmartCutPanel() {
  const sc = useP((p) => p.smartCut);
  const captions = useP((p) => p.captions);
  const clips = useP((p) => p.clips);
  const [lang, setLang] = useState(captions?.language ?? 'auto');
  const [busy, setBusy] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [minPause, setMinPause] = useState(0.6);

  const start = async () => {
    setBusy(true);
    try {
      let words: CaptionWord[] = captions?.blocks.flatMap((b) => b.words ?? []) ?? [];
      if (!words.length) words = (await recognise('basic', lang)).words; // free when captions already exist
      const audio = await micPcm();
      const silences = audio ? detectSilences(audio.pcm, audio.sr, { minSilence: minPause }).map((r) => ({ start: r.start + audio.offset, end: r.end + audio.offset })) : [];
      const fillers = detectFillers(words, lang);
      edit('Smart Cut recognition', (p) => { p.smartCut = buildSmartCut(lang, silences, fillers, words); });
      toast(`Found ${silences.length} pauses and ${fillers.length} filler words`, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!sc) {
    return (
      <Section title="Smart Cut">
        <div className="text-xs text-muted">Find silences and filler words (“um”, “uh”…) and remove them in one click. Zooms, captions and annotations stay in sync.</div>
        <Select label="Language" value={lang} onChange={setLang} options={CAPTION_LANGUAGES.map((l) => ({ value: l.code, label: l.name }))} />
        <Slider label="Minimum pause" value={minPause} min={0.3} max={3} step={0.1} onChange={setMinPause} format={(v) => `${v.toFixed(1)} s`} />
        {captions && <div className="text-[11px] text-ok">Uses your existing captions — no extra processing.</div>}
        <Button variant="primary" disabled={busy} onClick={start}>{busy ? 'Recognising…' : 'Start recognition'}</Button>
      </Section>
    );
  }

  const n = sc.items.filter((i) => i.selected && !i.deleted && srcRangeToOut(clips, i.start, i.end).length > 0).length;
  // merge transcript words and silence items into one chronological stream
  const stream: Array<{ kind: 'word'; w: CaptionWord; item?: (typeof sc.items)[number] } | { kind: 'pause'; item: (typeof sc.items)[number] }> = [];
  const fillerAt = new Map(sc.items.filter((i) => i.kind === 'filler').map((i) => [`${i.start.toFixed(3)}`, i]));
  const pauses = sc.items.filter((i) => i.kind === 'silence');
  let pi = 0;
  for (const w of sc.transcript) {
    while (pi < pauses.length && pauses[pi]!.start <= w.start) stream.push({ kind: 'pause', item: pauses[pi++]! });
    const f = fillerAt.get(w.start.toFixed(3));
    stream.push(f ? { kind: 'word', w, item: f } : { kind: 'word', w });
  }
  while (pi < pauses.length) stream.push({ kind: 'pause', item: pauses[pi++]! });
  const toggle = (id: string) => edit('Toggle cut item', (p) => { const it = p.smartCut?.items.find((x) => x.id === id); if (it && !it.deleted) it.selected = !it.selected; });

  return (
    <Section title="Smart Cut">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="danger" disabled={n === 0} onClick={() => edit(`Smart Cut: delete ${n}`, (p) => {
          const before = p.smartCut!.clipsBefore ?? cloneData(p.clips);
          const r = applySmartCut(p.clips, p.smartCut!);
          p.clips = r.clips;
          p.smartCut = { ...r.result, clipsBefore: before };
        })}>Delete ({n})</Button>
        <Button size="sm" onClick={() => edit('Select all cuts', (p) => { p.smartCut!.items.forEach((i) => { if (!i.deleted) i.selected = true; }); })}>Select all</Button>
        <Button size="sm" onClick={() => edit('Deselect cuts', (p) => { p.smartCut!.items.forEach((i) => { if (!i.deleted) i.selected = false; }); })}>None</Button>
        <Button size="sm" onClick={() => edit('Reset Smart Cut', (p) => {
          if (p.smartCut?.clipsBefore) p.clips = p.smartCut.clipsBefore;
          p.smartCut = { ...p.smartCut!, items: cloneData(p.smartCut!.initialItems), clipsBefore: undefined };
        })}>Reset</Button>
        <Toggle label="Show deleted" checked={showDeleted} onChange={setShowDeleted} />
      </div>
      <div className="max-h-[420px] overflow-auto rounded-lg bg-panel-2 p-2 text-[13px] leading-7">
        {stream.length === 0 && <span className="text-xs text-muted">Nothing to cut.</span>}
        {stream.map((s, i) => {
          if (s.kind === 'pause') {
            if (s.item.deleted && !showDeleted) return null;
            return (
              <button key={s.item.id} onClick={() => toggle(s.item.id)} title={formatTime(srcToOut(clips, s.item.start) ?? s.item.start)}
                className={`mx-0.5 rounded px-1.5 text-[11px] ${s.item.deleted ? 'bg-line text-muted line-through' : s.item.selected ? 'bg-danger/30 text-danger' : 'bg-line text-muted'}`}>
                [pause {(s.item.end - s.item.start).toFixed(1)} s]
              </button>
            );
          }
          if (s.item) {
            if (s.item.deleted && !showDeleted) return null;
            return <button key={`w${i}`} onClick={() => toggle(s.item!.id)} className={`mx-0.5 rounded px-1 ${s.item.deleted ? 'text-muted line-through' : s.item.selected ? 'bg-warn/30 text-warn' : 'underline decoration-warn decoration-dotted'}`}>{s.w.w}</button>;
          }
          return <span key={`w${i}`} className="mx-0.5 cursor-pointer hover:text-accent-2" onClick={() => { const o = srcToOut(clips, s.w.start); if (o !== null) useEditor.getState().setTime(o); }}>{s.w.w}</span>;
        })}
      </div>
      <Button size="sm" variant="ghost" onClick={() => edit('Clear Smart Cut', (p) => { delete p.smartCut; })}>Start over</Button>
    </Section>
  );
}
