/**
 * Captions (plan §6.12) — CAP-01/04/05/06.
 * Builder: ≤2 lines, ≤42 chars/line (CJK ≈ 18), 1–7 s; break at punctuation or pauses > 0.3 s.
 */
import { uid } from './defaults';
import type { CaptionBlock, CaptionWord, Clip } from './schema';
import { outToSrc, srcRangeToOut, srcToOut } from './time';

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
export const isCjk = (s: string): boolean => CJK.test(s);

export interface BuildOpts {
  maxCharsPerLine?: number;
  maxLines?: number;
  minDur?: number;
  maxDur?: number;
  pauseBreak?: number;
}

export function buildCaptionBlocks(words: readonly CaptionWord[], opts: BuildOpts = {}): CaptionBlock[] {
  const sample = words.slice(0, 20).map((w) => w.w).join('');
  const cjk = isCjk(sample);
  const maxLine = opts.maxCharsPerLine ?? (cjk ? 18 : 42);
  const maxChars = maxLine * (opts.maxLines ?? 2);
  const maxDur = opts.maxDur ?? 7;
  const minDur = opts.minDur ?? 1;
  const pause = opts.pauseBreak ?? 0.3;
  const joiner = cjk ? '' : ' ';
  const blocks: CaptionBlock[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = wrapLines(cur.map((w) => w.w.trim()).filter(Boolean).join(joiner), maxLine, cjk);
    const start = cur[0]!.start;
    const end = Math.max(cur[cur.length - 1]!.end, start + Math.min(minDur, 0.5));
    blocks.push({ id: uid('cap'), start, end, text, words: cur.map((w) => ({ ...w, w: w.w.trim() })) });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!w.w.trim()) continue;
    if (cur.length) {
      const prev = cur[cur.length - 1]!;
      const len = cur.map((x) => x.w.trim()).join(joiner).length + joiner.length + w.w.trim().length;
      const dur = w.end - cur[0]!.start;
      const gap = w.start - prev.end;
      const punct = /[.!?。！？]$/.test(prev.w.trim());
      const softPunct = /[,;:，、]$/.test(prev.w.trim());
      const longEnough = prev.end - cur[0]!.start >= minDur;
      if (len > maxChars || dur > maxDur || gap > pause * 2 || (longEnough && (punct || gap > pause)) || (softPunct && len > maxChars * 0.6)) flush();
    }
    cur.push(w);
  }
  flush();
  return blocks;
}

/** Greedy line wrap into ≤ maxLine chars, max 2 lines balanced roughly. */
export function wrapLines(text: string, maxLine: number, cjk = isCjk(text)): string {
  if (text.length <= maxLine) return text;
  if (cjk) {
    const mid = Math.ceil(text.length / 2);
    return `${text.slice(0, mid)}\n${text.slice(mid)}`;
  }
  const words = text.split(/\s+/);
  const target = text.length / 2;
  let best = 1, bestScore = Infinity, acc = 0;
  for (let i = 0; i < words.length - 1; i++) {
    acc += words[i]!.length + (i ? 1 : 0);
    const score = Math.abs(acc - target);
    if (score < bestScore) { bestScore = score; best = i + 1; }
  }
  return `${words.slice(0, best).join(' ')}\n${words.slice(best).join(' ')}`;
}

// ---------------------------------------------------------------- editing ops (CAP-04)

/** Enter = split block at caret (character offset in text). Word timings split proportionally/by words. */
export function splitBlock(blocks: readonly CaptionBlock[], id: string, caret: number): CaptionBlock[] {
  const out: CaptionBlock[] = [];
  for (const b of blocks) {
    if (b.id !== id || caret <= 0 || caret >= b.text.length) { out.push(b); continue; }
    const leftText = b.text.slice(0, caret).trim();
    const rightText = b.text.slice(caret).trim();
    let tSplit = b.start + (b.end - b.start) * (caret / b.text.length);
    let lw: CaptionWord[] | undefined, rw: CaptionWord[] | undefined;
    if (b.words?.length) {
      const nLeft = leftText.split(/\s+/).filter(Boolean).length;
      lw = b.words.slice(0, nLeft);
      rw = b.words.slice(nLeft);
      if (lw.length && rw.length) tSplit = (lw[lw.length - 1]!.end + rw[0]!.start) / 2;
    }
    out.push({ ...b, text: leftText, end: tSplit, ...(lw ? { words: lw } : {}) });
    out.push({ id: uid('cap'), start: tSplit, end: b.end, text: rightText, ...(rw ? { words: rw } : {}) });
  }
  return out;
}

export function mergeWithNext(blocks: readonly CaptionBlock[], id: string): CaptionBlock[] {
  const i = blocks.findIndex((b) => b.id === id);
  if (i < 0 || i >= blocks.length - 1) return blocks.slice();
  const a = blocks[i]!, b = blocks[i + 1]!;
  const merged: CaptionBlock = {
    id: a.id,
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    text: `${a.text.replace(/\n/g, ' ')} ${b.text.replace(/\n/g, ' ')}`.trim(),
    ...(a.words && b.words ? { words: [...a.words, ...b.words] } : {}),
  };
  return [...blocks.slice(0, i), merged, ...blocks.slice(i + 2)];
}

export function addBlockAt(blocks: readonly CaptionBlock[], t: number, text = 'New caption', dur = 2): CaptionBlock[] {
  const nb: CaptionBlock = { id: uid('cap'), start: t, end: t + dur, text };
  return [...blocks, nb].sort((a, b) => a.start - b.start);
}

export function updateBlock(blocks: readonly CaptionBlock[], id: string, patch: Partial<Omit<CaptionBlock, 'id'>>): CaptionBlock[] {
  return blocks.map((b) => {
    if (b.id !== id) return b;
    const nb = { ...b, ...patch };
    if (patch.text !== undefined && patch.text.replace(/\s+/g, ' ') !== b.text.replace(/\s+/g, ' ')) delete nb.words; // edited text invalidates word timing
    if (nb.end < nb.start + 0.1) nb.end = nb.start + 0.1;
    return nb;
  });
}

export const deleteBlock = (blocks: readonly CaptionBlock[], id: string): CaptionBlock[] => blocks.filter((b) => b.id !== id);

export function blockAt(blocks: readonly CaptionBlock[], s: number): CaptionBlock | null {
  for (const b of blocks) if (s >= b.start && s < b.end) return b;
  return null;
}

/** Index of the active word at source time s (highlight styles). -1 if none/unknown. */
export function activeWordIndex(block: CaptionBlock, s: number): number {
  if (!block.words) return -1;
  for (let i = block.words.length - 1; i >= 0; i--) if (s >= block.words[i]!.start) return i;
  return -1;
}

// ---------------------------------------------------------------- SRT / VTT (CAP-06)

function ts(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}

function parseTs(s: string): number {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(s.trim());
  if (!m) throw new Error(`Invalid timestamp: ${s}`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0')) / 1000;
}

export function parseSrt(text: string): CaptionBlock[] {
  const blocks: CaptionBlock[] = [];
  const chunks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const chunk of chunks) {
    const lines = chunk.split('\n').filter((l) => l.trim() !== '');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx]!.split('-->');
    try {
      const start = parseTs(a!);
      const end = parseTs(b!.trim().split(/\s+/)[0]!);
      const body = lines.slice(timeIdx + 1).join('\n').replace(/<[^>]+>/g, '');
      if (end > start) blocks.push({ id: uid('cap'), start, end, text: body });
    } catch {
      /* skip malformed cue */
    }
  }
  return blocks.sort((x, y) => x.start - y.start);
}

/**
 * Caption blocks live in SOURCE time; subtitle files must follow the exported video. Blocks inside removed
 * ranges are dropped, blocks straddling a cut are shortened, speed changes are applied.
 */
export function captionsToOutput(blocks: readonly CaptionBlock[], clips: readonly Clip[]): CaptionBlock[] {
  const out: CaptionBlock[] = [];
  for (const b of blocks) {
    const ranges = srcRangeToOut(clips, b.start, b.end);
    if (!ranges.length) continue;
    const start = ranges[0]![0], end = ranges[ranges.length - 1]![1];
    if (end - start >= 0.05) out.push({ id: b.id, start, end, text: b.text });
  }
  return out;
}

/** Inverse of captionsToOutput for imported subtitle files, which are timed against the edited timeline. */
export function captionsFromOutput(blocks: readonly CaptionBlock[], clips: readonly Clip[]): CaptionBlock[] {
  return blocks.map((b) => ({ ...b, start: outToSrc(clips, b.start).src, end: Math.max(outToSrc(clips, Math.max(b.start, b.end - 1e-6)).src, outToSrc(clips, b.start).src + 0.05) }));
}

export function toSrt(blocks: readonly CaptionBlock[]): string {
  return blocks.map((b, i) => `${i + 1}\n${ts(b.start, ',')} --> ${ts(b.end, ',')}\n${b.text}\n`).join('\n');
}

export function toVtt(blocks: readonly CaptionBlock[]): string {
  return `WEBVTT\n\n${blocks.map((b) => `${ts(b.start, '.')} --> ${ts(b.end, '.')}\n${b.text}\n`).join('\n')}`;
}

/** Advanced (cloud) model languages — CAP-02. Codes are ISO 639-1 (+ script variants for Chinese). */
export const CLOUD_CAPTION_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'auto', name: 'Auto detect' },
  ...[
    ['af', 'Afrikaans'], ['ar', 'العربية'], ['hy', 'Հայերեն'], ['az', 'Azərbaycan'], ['be', 'Беларуская'], ['bn', 'বাংলা'], ['bs', 'Bosanski'],
    ['bg', 'Български'], ['ca', 'Català'], ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'], ['hr', 'Hrvatski'], ['cs', 'Čeština'], ['da', 'Dansk'],
    ['nl', 'Nederlands'], ['en', 'English'], ['et', 'Eesti'], ['fi', 'Suomi'], ['fr', 'Français'], ['gl', 'Galego'], ['de', 'Deutsch'],
    ['el', 'Ελληνικά'], ['gu', 'ગુજરાતી'], ['he', 'עברית'], ['hi', 'हिन्दी'], ['hu', 'Magyar'], ['is', 'Íslenska'], ['id', 'Bahasa Indonesia'],
    ['it', 'Italiano'], ['ja', '日本語'], ['kn', 'ಕನ್ನಡ'], ['kk', 'Қазақ'], ['ko', '한국어'], ['lv', 'Latviešu'], ['lt', 'Lietuvių'],
    ['mk', 'Македонски'], ['ms', 'Bahasa Melayu'], ['ml', 'മലയാളം'], ['mr', 'मराठी'], ['ne', 'नेपाली'], ['no', 'Norsk'], ['fa', 'فارسی'],
    ['pl', 'Polski'], ['pt', 'Português'], ['pa', 'ਪੰਜਾਬੀ'], ['ro', 'Română'], ['ru', 'Русский'], ['sr', 'Српски'], ['sk', 'Slovenčina'],
    ['sl', 'Slovenščina'], ['es', 'Español'], ['sw', 'Kiswahili'], ['sv', 'Svenska'], ['tl', 'Tagalog'], ['ta', 'தமிழ்'], ['te', 'తెలుగు'],
    ['th', 'ไทย'], ['tr', 'Türkçe'], ['uk', 'Українська'], ['ur', 'اردو'], ['vi', 'Tiếng Việt'], ['cy', 'Cymraeg'],
  ].map(([code, name]) => ({ code: code!, name: name! })),
];

export const CAPTION_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'auto', name: 'Auto detect' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
  { code: 'zh-Hans', name: '简体中文' },
  { code: 'zh-Hant', name: '繁體中文' },
  { code: 'ko', name: '한국어' },
  { code: 'pt', name: 'Português' },
  { code: 'hi', name: 'हिन्दी' },
];

/**
 * Chapters as a YouTube description block ("00:00 Intro"). Chapters are stored in source time; cut-out
 * ones are dropped. YouTube requires the list to start at 0:00 — an "Intro" line is added when needed.
 */
export function youtubeChapters(chapters: ReadonlyArray<{ t: number; title: string }>, clips: readonly Clip[]): string {
  const rows = chapters
    .map((c) => ({ out: srcToOut(clips, c.t), title: c.title.trim() || 'Chapter' }))
    .filter((c): c is { out: number; title: string } => c.out !== null)
    .sort((a, b) => a.out - b.out);
  if (!rows.length) return '';
  if (rows[0]!.out > 0.5) rows.unshift({ out: 0, title: 'Intro' });
  else rows[0]!.out = 0;
  const fmt = (s: number) => {
    const t = Math.floor(s);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  return rows.map((r) => `${fmt(r.out)} ${r.title}`).join('\n');
}
