/**
 * Analysis service (audit B1 / B11 / B14): every audio file is decoded ONCE per bundle — results live in
 * memory for the session and in `cache/analysis-<file>.bin` (projects:writeCache) validated by byte size.
 * Disk hits load in parallel; fresh computations run one at a time, time-sliced so the 60 fps preview
 * keeps its frames. Consumers: timeline waveforms, PreviewAudio (balance + ducking), export mixdown.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { consoleSink, createLogger } from '@rec/shared';
import { api } from '../lib/api';
import { mediaUrl } from '../editor/media';
import { useEditor } from '../editor/store';
import { AnalysisBuilder, analysisCacheName, decodeAnalysis, encodeAnalysis, type TrackAnalysis } from './analysis';
import { openPcmReader } from './trackReader';

const log = createLogger('renderer.audio.analysis', consoleSink);

export interface AnalysisTarget {
  mediaBase: string;
  /** bundle-relative file, e.g. media/mic.wav */
  file: string;
  /** bundle dir for the disk cache (defaults to the open editor project when its mediaBase matches) */
  dir?: string;
}

interface Entry {
  status: 'loading' | 'ready' | 'missing' | 'error';
  data: TrackAnalysis | null;
  progress: number;
  promise: Promise<TrackAnalysis | null>;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
let computeQueue: Promise<unknown> = Promise.resolve();

const keyOf = (t: AnalysisTarget) => `${t.mediaBase}|${t.file}`;
function notify(): void {
  version++;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getVersion = () => version;

function dirFor(t: AnalysisTarget): string | undefined {
  if (t.dir) return t.dir;
  const o = useEditor.getState().opened;
  return o && o.mediaBase === t.mediaBase ? o.dir : undefined;
}

/** Byte size via a 1-byte range request (rec-media serves ranges); null when the file does not exist. */
export async function mediaFileSize(mediaBase: string, file: string): Promise<number | null> {
  try {
    const r = await fetch(mediaUrl(mediaBase, file), { headers: { Range: 'bytes=0-0' } });
    if (!r.ok) return null;
    const m = /\/(\d+)\s*$/.exec(r.headers.get('Content-Range') ?? '');
    const size = m ? Number(m[1]) : Number(r.headers.get('Content-Length') ?? NaN);
    void r.body?.cancel().catch(() => undefined);
    return Number.isFinite(size) ? size : 0;
  } catch {
    return null;
  }
}

async function compute(t: AnalysisTarget, size: number, entry: Entry): Promise<TrackAnalysis | null> {
  const started = performance.now();
  const reader = await openPcmReader(mediaUrl(t.mediaBase, t.file));
  if (!reader) return null;
  try {
    const b = new AnalysisBuilder(reader.sampleRate, reader.channels);
    let lastNotify = 0;
    await reader.stream((planes, n) => b.push(planes, n), {
      onProgress: (p) => {
        entry.progress = p;
        const now = performance.now();
        if (now - lastNotify > 250) { lastNotify = now; notify(); }
      },
    });
    const a = b.finish(size);
    log.info('analysis.computed', { file: t.file, duration_s: Math.round(a.duration), lufs: Math.round(a.integratedLufs * 10) / 10, latency_ms: Math.round(performance.now() - started) });
    const dir = dirFor(t);
    if (dir) {
      void api.invoke('projects:writeCache', dir, analysisCacheName(t.file), encodeAnalysis(a))
        .catch((e) => log.warn('analysis.cache_write_failed', { file: t.file, error: e instanceof Error ? e.message : String(e) }));
    }
    return a;
  } finally {
    reader.dispose();
  }
}

async function load(t: AnalysisTarget, entry: Entry): Promise<TrackAnalysis | null> {
  const size = await mediaFileSize(t.mediaBase, t.file);
  if (size === null) {
    entry.status = 'missing';
    return null;
  }
  const dir = dirFor(t);
  if (dir) {
    try {
      const cached = decodeAnalysis(await api.invoke<Uint8Array | null>('projects:readCache', dir, analysisCacheName(t.file)));
      if (cached && cached.sourceBytes === size) {
        log.debug('analysis.cache_hit', { file: t.file });
        return cached;
      }
    } catch (e) {
      log.warn('analysis.cache_read_failed', { file: t.file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const run = computeQueue.then(() => compute(t, size, entry));
  computeQueue = run.catch(() => undefined);
  return run;
}

/** Load (memoised per file) — resolves null when the file is missing or undecodable. */
export function loadAnalysis(t: AnalysisTarget): Promise<TrackAnalysis | null> {
  const key = keyOf(t);
  const existing = entries.get(key);
  if (existing) return existing.promise;
  const entry: Entry = { status: 'loading', data: null, progress: 0, promise: Promise.resolve(null) };
  entries.set(key, entry);
  // missing / failed files may appear or be fixed later (e.g. a denoise pass finishing) → forget after a backoff
  const evictLater = () => setTimeout(() => entries.get(key) === entry && entries.delete(key), entry.status === 'missing' ? 5_000 : 60_000);
  entry.promise = load(t, entry).then(
    (a) => {
      if (entries.get(key) === entry) {
        entry.data = a;
        if (entry.status === 'loading') entry.status = a ? 'ready' : 'error';
        if (!a) evictLater();
        notify();
      }
      return a;
    },
    (e) => {
      log.error('analysis.failed', e, { file: t.file });
      if (entries.get(key) === entry) {
        entry.status = 'error';
        evictLater();
        notify();
      }
      return null;
    },
  );
  notify();
  return entry.promise;
}

/** Synchronous peek; never starts work. */
export function peekAnalysis(t: AnalysisTarget): TrackAnalysis | null {
  return entries.get(keyOf(t))?.data ?? null;
}

/** Synchronous peek that starts loading in the background when nothing is known yet (hot paths). */
export function requestAnalysis(t: AnalysisTarget): TrackAnalysis | null {
  const e = entries.get(keyOf(t));
  if (!e) void loadAnalysis(t);
  return e?.data ?? null;
}

export function analysisStatus(t: AnalysisTarget): { status: Entry['status']; progress: number } | null {
  const e = entries.get(keyOf(t));
  return e ? { status: e.status, progress: e.progress } : null;
}

/** Forget a file whose content changed (e.g. re-run vocal enhancement → same name, maybe same size). */
export async function invalidateAnalysis(t: AnalysisTarget): Promise<void> {
  entries.delete(keyOf(t));
  const dir = dirFor(t);
  if (dir) await api.invoke('projects:writeCache', dir, analysisCacheName(t.file), new Uint8Array(0)).catch(() => undefined);
  notify();
}

/** React: analysis of a bundle file of the open project (re-renders when it becomes available). */
export function useTrackAnalysis(file: string | null | undefined, opts: { load?: boolean } = {}): TrackAnalysis | null {
  useSyncExternalStore(subscribe, getVersion);
  const opened = useEditor((s) => s.opened);
  const doLoad = opts.load ?? true;
  useEffect(() => {
    if (file && opened && doLoad) void loadAnalysis({ mediaBase: opened.mediaBase, file, dir: opened.dir });
  }, [file, opened, doLoad]);
  return file && opened ? peekAnalysis({ mediaBase: opened.mediaBase, file }) : null;
}

/** React: lifecycle of a file's analysis ('loading' | 'ready' | 'missing' | 'error'), null before any request. */
export function useAnalysisStatus(file: string | null | undefined): Entry['status'] | null {
  useSyncExternalStore(subscribe, getVersion);
  const opened = useEditor((s) => s.opened);
  if (!file || !opened) return null;
  return analysisStatus({ mediaBase: opened.mediaBase, file })?.status ?? null;
}

/** React: loading progress (0…1) of a file's analysis, or null when idle / done. */
export function useAnalysisProgress(file: string | null | undefined): number | null {
  useSyncExternalStore(subscribe, getVersion);
  const opened = useEditor((s) => s.opened);
  if (!file || !opened) return null;
  const s = analysisStatus({ mediaBase: opened.mediaBase, file });
  return s && s.status === 'loading' ? s.progress : null;
}
