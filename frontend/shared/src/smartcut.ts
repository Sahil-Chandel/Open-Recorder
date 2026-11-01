/**
 * Smart Cut (plan §6.11) — CUT-01…04: silence + filler detection and ripple removal.
 * Silence: RMS < −40 dBFS runs ≥ 0.6 s, keep 0.15 s padding. Fillers: per-language lexicon on ASR words.
 * Because everything is stored in SOURCE time, applying a cut is a plain clip edit.
 */
import { cloneData, uid } from './defaults';
import type { CaptionWord, Clip, SmartCutItem, SmartCutResult } from './schema';
import { removeSourceRanges } from './time';

export const FILLERS: Record<string, string[]> = {
  en: ['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'ah', 'hmm', 'mm', 'uhm'],
  fr: ['euh', 'heu', 'bah', 'ben', 'hum'],
  de: ['äh', 'ähm', 'öhm', 'hm', 'äh'],
  es: ['eh', 'em', 'este', 'mmm'],
  it: ['ehm', 'eh', 'mmm', 'cioè'],
  pt: ['é', 'hã', 'hum', 'tipo', 'né'],
  ja: ['えー', 'えーと', 'あの', 'あのー', 'まあ', 'えっと'],
  'zh-Hans': ['嗯', '呃', '那个', '就是'],
  'zh-Hant': ['嗯', '呃', '那個', '就是'],
  ko: ['음', '어', '그', '저기'],
  hi: ['अं', 'उम्म', 'मतलब', 'तो'],
};
export const FILLER_PROMPT = 'Umm, uh, so, hmm, like, you know, er, ah.';

/**
 * Initial prompt that biases Whisper to keep disfluencies (it drops them by default, §6.11) — written in the
 * target language, since an English prompt nudges other languages towards English output.
 */
export function fillerPrompt(language: string): string {
  if (language === 'en' || language === 'auto') return FILLER_PROMPT;
  const words = FILLERS[language];
  if (!words?.length) return '';
  const cjk = /^(ja|zh|ko)/.test(language);
  return words.join(cjk ? '、' : ', ') + (cjk ? '…' : '...');
}

/** RMS per window (dBFS) from mono PCM. Vectorisable single pass; O(n). */
export function rmsDb(pcm: Float32Array, sampleRate: number, windowSec = 0.02): Float32Array {
  const win = Math.max(1, Math.round(sampleRate * windowSec));
  const n = Math.floor(pcm.length / win);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const o = i * win;
    for (let j = 0; j < win; j++) {
      const v = pcm[o + j]!;
      acc += v * v;
    }
    const rms = Math.sqrt(acc / win);
    out[i] = rms > 1e-9 ? 20 * Math.log10(rms) : -120;
  }
  return out;
}

export interface SilenceOpts {
  thresholdDb?: number;
  minSilence?: number;
  padding?: number;
  windowSec?: number;
}

export function detectSilences(pcm: Float32Array, sampleRate: number, opts: SilenceOpts = {}): Array<{ start: number; end: number }> {
  const thr = opts.thresholdDb ?? -40;
  const minLen = opts.minSilence ?? 0.6;
  const pad = opts.padding ?? 0.15;
  const win = opts.windowSec ?? 0.02;
  const db = rmsDb(pcm, sampleRate, win);
  const out: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  const total = pcm.length / sampleRate;
  for (let i = 0; i <= db.length; i++) {
    const quiet = i < db.length && db[i]! < thr;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      const s = runStart * win;
      const e = i * win;
      if (e - s >= minLen) {
        const a = s === 0 ? 0 : s + pad;
        const b = i >= db.length ? total : e - pad;
        if (b - a > 0.05) out.push({ start: a, end: b });
      }
      runStart = -1;
    }
  }
  return out;
}

const norm = (w: string) => w.toLowerCase().replace(/[.,!?;:"'“”‘’。，！？、…-]/g, '').trim();

export function detectFillers(words: readonly CaptionWord[], language: string): Array<{ start: number; end: number; text: string }> {
  const base = language === 'auto' ? 'en' : language;
  const lex = new Set(FILLERS[base] ?? FILLERS[base.split('-')[0]!] ?? FILLERS.en!);
  return words.filter((w) => lex.has(norm(w.w))).map((w) => ({ start: w.start, end: w.end, text: w.w.trim() }));
}

export function buildSmartCut(
  language: string,
  silences: ReadonlyArray<{ start: number; end: number }>,
  fillers: ReadonlyArray<{ start: number; end: number; text: string }>,
  transcript: readonly CaptionWord[] = [],
): SmartCutResult {
  const items: SmartCutItem[] = [
    ...silences.map((s) => ({ id: uid('cut'), kind: 'silence' as const, start: s.start, end: s.end, selected: true, deleted: false })),
    ...fillers.map((f) => ({ id: uid('cut'), kind: 'filler' as const, start: f.start, end: f.end, text: f.text, selected: true, deleted: false })),
  ].sort((a, b) => a.start - b.start);
  return { language, items, transcript: [...transcript], initialItems: cloneData(items) };
}

export const selectedCount = (r: SmartCutResult): number => r.items.filter((i) => i.selected && !i.deleted).length;

/** CUT-03: remove selected items from clips (ripple) and mark them deleted. */
export function applySmartCut(clips: readonly Clip[], result: SmartCutResult): { clips: Clip[]; result: SmartCutResult } {
  const ranges = result.items.filter((i) => i.selected && !i.deleted);
  return {
    clips: removeSourceRanges(clips, ranges),
    result: { ...result, items: result.items.map((i) => (i.selected && !i.deleted ? { ...i, deleted: true } : i)) },
  };
}

/** CUT-04: reset to the initial recognition state. */
export const resetSmartCut = (r: SmartCutResult): SmartCutResult => ({ ...r, items: cloneData(r.initialItems) });
