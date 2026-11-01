/**
 * Captions (tasks 10.3–10.5, CAP-01/03/04/05/06): local Nano/Basic/Pro (whisper.cpp, runs on this computer),
 * Auto + 11 languages, list editor (seek, edit, Enter = split, Shift+Enter = line break, merge, add, delete,
 * delete all, disable, regenerate), SRT import, SRT/VTT export, 5 styles + full style controls.
 */
import { Download, FileUp, Merge, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  addBlockAt,
  buildCaptionBlocks,
  CAPTION_LANGUAGES,
  captionsFromOutput,
  captionsToOutput,
  defaultCaptionStyleFor,
  formatTime,
  mergeWithNext,
  outToSrc,
  parseSrt,
  splitBlock,
  srcToOut,
  toSrt,
  toVtt,
  updateBlock,
  type CaptionStyle,
  type CaptionWord,
} from '@rec/shared';
import { FONT_CHOICES } from '../../fonts';
import { api, errMsg } from '../../lib/api';
import { Button, ColorPicker, Section, Segmented, Select, Slider, toast, Toggle, useConfirm } from '../../ui';
import { useEditor } from '../store';
import { ChaptersSection } from './ChaptersSection';
import { useTasks } from '../tasks';
import { edit, useP } from './common';

export type AsrModel = 'nano' | 'basic' | 'pro';

/** Run ASR on the mic (or system audio) and return words in SOURCE time. Shared with Smart Cut. */
export async function recognise(model: AsrModel, language: string): Promise<{ words: CaptionWord[]; language: string }> {
  const s = useEditor.getState();
  const p = s.project!;
  const files = p.source.tracks.mic ? [p.audio.mic.denoise ? 'cache/mic.denoised.wav' : p.source.tracks.mic] : p.source.tracks.system ? [p.source.tracks.system] : [];
  if (!files.length) throw new Error('This recording has no microphone audio to transcribe');
  const id = `asr-${Date.now()}`;
  const tasks = useTasks.getState();
  tasks.upsert({ id, title: `Captions (${model})`, kind: 'asr', progress: 0, status: 'running' });
  const off = api.on('asr:progress', (e: { progress?: number; stage?: string }) => e.progress !== undefined && tasks.upsert({ id, progress: e.progress, detail: e.stage ?? '' }));
  try {
    const r = await api.invoke<{ words: CaptionWord[]; language: string }>('asr:transcribe', { dir: s.dir, model, language, files });
    const offset = p.source.trackOffsets.mic ?? 0;
    const words = r.words.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }));
    tasks.upsert({ id, status: 'done', progress: 1 });
    return { words, language: r.language };
  } catch (e) {
    tasks.upsert({ id, status: 'error', detail: errMsg(e) });
    throw e;
  } finally {
    off();
  }
}

const STYLES: Array<{ id: CaptionStyle['styleId']; name: string }> = [
  { id: 'classic', name: 'Classic' }, { id: 'boxed', name: 'Boxed' }, { id: 'minimal', name: 'Minimal' },
  { id: 'highlight-color', name: 'Highlight' }, { id: 'highlight-pop', name: 'Pop' },
];

export function CaptionsPanel() {
  const captions = useP((p) => p.captions);
  const clips = useP((p) => p.clips);
  const time = useEditor((s) => s.time);
  const [model, setModel] = useState<AsrModel>(captions && captions.model !== 'srt' && captions.model !== 'advanced' ? captions.model : 'basic');
  const [lang, setLang] = useState(captions?.language ?? 'auto');
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const srcNow = outToSrc(clips, time).src;

  const generate = async () => {
    setBusy(true);
    try {
      const r = await recognise(model, lang);
      if (!r.words.length) return toast('No speech was detected', 'warning');
      const blocks = buildCaptionBlocks(r.words);
      edit('Generate captions', (p) => { p.captions = { enabled: true, language: r.language, model, blocks, style: p.captions?.style ?? defaultCaptionStyleFor(p.canvas) }; });
      toast(`${blocks.length} captions created`, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const importSrt = async () => {
    const r = await api.invoke<{ text?: string } | null>('dialog:openFile', [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }]);
    if (!r?.text) return;
    // subtitle files are timed against the edited timeline (output time); captions are stored in source time
    const blocks = captionsFromOutput(parseSrt(r.text), useEditor.getState().project!.clips);
    if (!blocks.length) return toast('No captions found in that file', 'error');
    edit('Import SRT', (p) => { p.captions = { enabled: true, language: p.captions?.language ?? 'en', model: 'srt', blocks, style: p.captions?.style ?? defaultCaptionStyleFor(p.canvas) }; });
  };

  const modelSelect = (
    <Select label="Model" value={model} onChange={setModel} options={[
      { value: 'nano', label: 'Local · Nano (fastest)' }, { value: 'basic', label: 'Local · Basic (recommended)' }, { value: 'pro', label: 'Local · Pro (most accurate)' },
    ]} />
  );
  const langs = CAPTION_LANGUAGES;
  const langSelect = <Select label="Language" value={langs.some((l) => l.code === lang) ? lang : 'auto'} onChange={setLang} options={langs.map((l) => ({ value: l.code, label: l.name }))} />;

  if (!captions) {
    return (
      <>
      <Section title="Auto captions">
        {modelSelect}
        {langSelect}
        <div className="text-[11px] text-muted">Captions are generated from your microphone. Local models run on this computer and are free; they download once (30–190 MB).</div>
        <Button variant="primary" disabled={busy} onClick={generate}>{busy ? 'Generating…' : 'Generate captions'}</Button>
        <Button onClick={importSrt}><FileUp size={14} />Import SRT</Button>
      </Section>
      <ChaptersSection />
      </>
    );
  }

  const st = captions.style;
  const setStyle = (label: string, f: (s: CaptionStyle) => void, key?: string) => edit(label, (p) => { if (p.captions) f(p.captions.style); }, key);
  const highlightOk = captions.model !== 'srt';
  return (
    <>
      <Section title="Captions" right={<Toggle checked={captions.enabled} onChange={(v) => edit(v ? 'Enable captions' : 'Disable captions', (p) => { p.captions!.enabled = v; })} />}>
        <div className="grid grid-cols-2 gap-1.5">{modelSelect}{langSelect}</div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => edit('Add caption', (p) => { p.captions!.blocks = addBlockAt(p.captions!.blocks, srcNow); })}><Plus size={13} />Add</Button>
          <Button size="sm" disabled={busy} onClick={async () => { if (await confirm('Regenerate captions? Your edits will be replaced.', { ok: 'Regenerate' })) void generate(); }}><RotateCcw size={13} />Regenerate</Button>
          <Button size="sm" onClick={importSrt}><FileUp size={13} />SRT</Button>
          <Button size="sm" onClick={async () => toast(`Saved ${await api.invoke<string>('export:writeText', `${useEditor.getState().project!.name}.srt`, toSrt(captionsToOutput(captions.blocks, clips)))}`, 'success')}><Download size={13} />SRT</Button>
          <Button size="sm" onClick={async () => toast(`Saved ${await api.invoke<string>('export:writeText', `${useEditor.getState().project!.name}.vtt`, toVtt(captionsToOutput(captions.blocks, clips)))}`, 'success')}><Download size={13} />VTT</Button>
          <Button size="sm" variant="danger" onClick={async () => { if (await confirm('Delete all captions?', { danger: true, ok: 'Delete all' })) edit('Delete all captions', (p) => { delete p.captions; }); }}><Trash2 size={13} />All</Button>
        </div>
        <div className="flex max-h-[340px] flex-col gap-1 overflow-auto pr-1">
          {captions.blocks.map((b) => {
            const out = srcToOut(clips, b.start);
            const outEnd = srcToOut(clips, Math.max(b.start, b.end - 1e-3));
            // timing is edited in OUTPUT seconds (what the timeline shows) and stored in source seconds
            const setTiming = (edge: 'start' | 'end', v: number) => {
              if (!Number.isFinite(v)) return;
              const src = outToSrc(clips, Math.max(0, v)).src;
              edit('Caption timing', (p) => { p.captions!.blocks = updateBlock(p.captions!.blocks, b.id, edge === 'start' ? { start: src } : { end: Math.max(src, b.start + 0.1) }); }, `c${edge[0]}-${b.id}`);
            };
            const active = srcNow >= b.start && srcNow < b.end;
            return (
              <div key={b.id} className={`rounded-lg border p-1.5 ${active ? 'border-accent bg-accent/10' : 'border-line'}`}>
                <div className="mb-1 flex items-center gap-1 text-[11px] text-muted">
                  <button className="font-mono hover:text-text" onClick={() => out !== null && useEditor.getState().setTime(out)}>{out === null ? 'cut' : formatTime(out)}</button>
                  <input aria-label="start (s)" type="number" step={0.1} disabled={out === null} className="w-14 rounded bg-panel-2 px-1 disabled:opacity-40" value={out === null ? '' : out.toFixed(1)} onChange={(e) => setTiming('start', parseFloat(e.target.value))} />
                  →
                  <input aria-label="end (s)" type="number" step={0.1} disabled={outEnd === null} className="w-14 rounded bg-panel-2 px-1 disabled:opacity-40" value={outEnd === null ? '' : outEnd.toFixed(1)} onChange={(e) => setTiming('end', parseFloat(e.target.value))} />
                  <span className="flex-1" />
                  <button title="Merge with next" onClick={() => edit('Merge captions', (p) => { p.captions!.blocks = mergeWithNext(p.captions!.blocks, b.id); })}><Merge size={12} /></button>
                  <button title="Delete" onClick={() => edit('Delete caption', (p) => { p.captions!.blocks = p.captions!.blocks.filter((x) => x.id !== b.id); })}><Trash2 size={12} /></button>
                </div>
                <textarea rows={Math.max(1, b.text.split('\n').length)} className="w-full resize-none rounded bg-transparent text-[13px] outline-none focus:bg-panel-2"
                  value={b.text}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      const caret = (e.target as HTMLTextAreaElement).selectionStart;
                      edit('Split caption', (p) => { p.captions!.blocks = splitBlock(p.captions!.blocks, b.id, caret); });
                    }
                  }}
                  onChange={(e) => edit('Edit caption', (p) => { p.captions!.blocks = updateBlock(p.captions!.blocks, b.id, { text: e.target.value }); }, `ct-${b.id}`)} />
              </div>
            );
          })}
        </div>
        <div className="text-[11px] text-muted">Enter splits a caption · Shift+Enter adds a line break</div>
      </Section>
      <Section title="Style">
        <div className="grid grid-cols-5 gap-1">
          {STYLES.map((s) => (
            <button key={s.id} disabled={!highlightOk && s.id.startsWith('highlight')} onClick={() => setStyle('Caption style', (x) => { x.styleId = s.id; })}
              className={`rounded-md border py-1.5 text-[10px] disabled:opacity-30 ${st.styleId === s.id ? 'border-accent bg-accent/15' : 'border-line'}`}>{s.name}</button>
          ))}
        </div>
        {!highlightOk && <div className="text-[11px] text-muted">Highlight styles need word timing (not available for imported SRT).</div>}
        <Select label="Font" value={st.font} onChange={(v) => setStyle('Caption font', (x) => { x.font = v; })} options={FONT_CHOICES.map((f) => ({ value: f, label: f }))} />
        <Slider label="Size" value={st.size} min={16} max={120} step={1} onChange={(v) => setStyle('Caption size', (x) => { x.size = v; }, 'capsize')} format={(v) => `${v}`} />
        <ColorPicker label="Word color" value={st.wordColor} onChange={(v) => setStyle('Caption color', (x) => { x.wordColor = v; }, 'capcolor')} />
        <ColorPicker label="Stroke color" value={st.strokeColor} onChange={(v) => setStyle('Stroke color', (x) => { x.strokeColor = v; }, 'capstroke')} />
        <Slider label="Stroke width" value={st.strokeWidth} min={0} max={10} step={0.5} onChange={(v) => setStyle('Stroke width', (x) => { x.strokeWidth = v; }, 'capsw')} format={(v) => `${v}`} />
        <ColorPicker label="Shadow color" value={st.shadow.color} onChange={(v) => setStyle('Shadow color', (x) => { x.shadow.color = v; }, 'capshc')} />
        <Slider label="Shadow size" value={st.shadow.size} min={0} max={30} step={1} onChange={(v) => setStyle('Shadow size', (x) => { x.shadow.size = v; }, 'capshs')} format={(v) => `${v}`} />
        <div className="grid grid-cols-2 gap-2">
          <Slider label="Shadow X" value={st.shadow.x} min={-10} max={10} step={1} onChange={(v) => setStyle('Shadow offset', (x) => { x.shadow.x = v; }, 'capshx')} format={(v) => `${v}`} />
          <Slider label="Shadow Y" value={st.shadow.y} min={-10} max={10} step={1} onChange={(v) => setStyle('Shadow offset', (x) => { x.shadow.y = v; }, 'capshy')} format={(v) => `${v}`} />
        </div>
        <Slider label="Shadow opacity" value={st.shadow.opacity} min={0} max={1} onChange={(v) => setStyle('Shadow opacity', (x) => { x.shadow.opacity = v; }, 'capsho')} format={(v) => `${Math.round(v * 100)}%`} />
        {st.styleId.startsWith('highlight') && (
          <>
            <ColorPicker label="Highlight color" value={st.highlightColor} onChange={(v) => setStyle('Highlight color', (x) => { x.highlightColor = v; }, 'caphc')} />
            <Slider label="Highlight opacity" value={st.highlightOpacity} min={0} max={1} onChange={(v) => setStyle('Highlight opacity', (x) => { x.highlightOpacity = v; }, 'capho')} format={(v) => `${Math.round(v * 100)}%`} />
          </>
        )}
        <Slider label="Position (higher = up)" value={st.position} min={0} max={0.9} onChange={(v) => setStyle('Caption position', (x) => { x.position = v; }, 'cappos')} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Line spacing" value={st.spacing} min={0.9} max={2.5} step={0.05} onChange={(v) => setStyle('Caption spacing', (x) => { x.spacing = v; }, 'capsp')} format={(v) => v.toFixed(2)} />
      </Section>
      <ChaptersSection />
    </>
  );
}

export function useCaptionWords(): CaptionWord[] {
  const blocks = useP((p) => p.captions?.blocks ?? []);
  const [w, setW] = useState<CaptionWord[]>([]);
  useEffect(() => setW(blocks.flatMap((b) => b.words ?? [])), [blocks]);
  return w;
}
