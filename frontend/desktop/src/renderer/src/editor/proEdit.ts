/**
 * One-click Pro Edit (task 13.4), fully local: Smart Cut (local Whisper) → captions → noise reduction →
 * regenerate zooms → default preset. Everything is computed first and applied as ONE edit, so a single
 * Undo reverts it.
 */
import {
  applyPreset,
  applySmartCut,
  autoZooms,
  buildCaptionBlocks,
  buildSmartCut,
  cloneData,
  defaultCaptionStyleFor,
  detectFillers,
  detectSilences,
  detectTypingBursts,
  type CaptionWord,
  type Preset,
} from '@rec/shared';
import { api } from '../lib/api';
import { mediaUrl } from './media';
import { useEditor } from './store';

export async function runProEdit(onStep: (s: string) => void): Promise<string[]> {
  const s = useEditor.getState();
  const p0 = s.project!;
  const summary: string[] = [];
  const { recognise } = await import('./panels/CaptionsPanel');
  let words: CaptionWord[] = p0.captions?.blocks.flatMap((b) => b.words ?? []) ?? [];
  if (!words.length && (p0.source.tracks.mic || p0.source.tracks.system)) {
    onStep('Transcribing');
    words = (await recognise('basic', p0.captions?.language ?? 'auto')).words;
  }
  let silences: Array<{ start: number; end: number }> = [];
  if (p0.source.tracks.mic) {
    onStep('Finding pauses');
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const buf = await fetch(mediaUrl(s.opened!.mediaBase, p0.source.tracks.mic)).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
    silences = detectSilences(buf.getChannelData(0), buf.sampleRate, { minSilence: 0.8 });
  }
  let denoised = false;
  if (p0.source.tracks.mic && !p0.audio.mic.denoise) {
    onStep('Reducing noise');
    const { runDenoise } = await import('../audio/denoise');
    await runDenoise(s.dir);
    denoised = true;
  }
  const presets = await api.invoke<Preset[]>('presets:list');
  const def = (await api.invoke<{ defaultPresetId?: string }>('settings:get')).defaultPresetId;
  const preset = presets.find((x) => x.id === def);
  onStep('Applying');
  s.edit('One-click Pro Edit', (p) => {
    const sc = buildSmartCut(p.captions?.language ?? 'en', silences, detectFillers(words, p.captions?.language ?? 'en'), words);
    if (sc.items.length) {
      const before = cloneData(p.clips);
      const r = applySmartCut(p.clips, sc);
      p.clips = r.clips;
      p.smartCut = { ...r.result, clipsBefore: before };
      summary.push(`Removed ${sc.items.length} pauses/fillers`);
    }
    if (words.length && !p.captions) {
      p.captions = { enabled: true, language: 'auto', model: 'basic', blocks: buildCaptionBlocks(words), style: defaultCaptionStyleFor(p.canvas) };
      summary.push(`Added ${p.captions.blocks.length} captions`);
    }
    if (denoised) { p.audio.mic.denoise = true; summary.push('Noise reduction on'); }
    if (p.source.hasTelemetry) {
      const tel = useEditor.getState().telemetry;
      p.zooms = [...p.zooms.filter((z) => z.source === 'manual'), ...autoZooms(tel.clicks, detectTypingBursts(tel.keys, tel.clicks), { duration: p.source.durationSec })];
      summary.push(`${p.zooms.length} zooms`);
    }
    if (preset) {
      const applied = applyPreset(p as never, preset).project;
      Object.assign(p, { canvas: applied.canvas, cursor: applied.cursor, animation: applied.animation, camera: applied.camera, keys: applied.keys });
      summary.push(`Preset “${preset.name}”`);
    }
  });
  return summary;
}
