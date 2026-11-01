/**
 * Mini editor for online recordings: preview, manual zooms (double-click), export MP4 with zooms + recorded audio,
 * or save the original file. MediaRecorder WebM files report duration = Infinity, so the real length is found with the
 * seek-to-end trick, falling back to the measured recording time.
 */
import { Download, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { clamp, fitContain, type Zoom } from './geometry';
import { extensionFor, recordingName, saveBlob } from './media';

type Exporter = typeof import('./exportMp4');
const ZOOM_SECONDS = 3;
const PROBE_TIMEOUT_MS = 3000;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function MiniEditor({ blob, durationHint, audioOnly }: { blob: Blob; durationHint: number; audioOnly: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  const saveOriginal = () => saveBlob(blob, recordingName(extensionFor(blob.type)));
  if (!url) return null;
  if (audioOnly) {
    return (
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <audio src={url} controls />
        <button onClick={saveOriginal} className="rounded-lg border border-line px-3 py-1.5 text-sm"><Download size={14} className="inline" /> Save</button>
      </div>
    );
  }
  return <VideoEditor blob={blob} url={url} durationHint={durationHint} onSaveOriginal={saveOriginal} />;
}

function VideoEditor({ blob, url, durationHint, onSaveOriginal }: { blob: Blob; url: string; durationHint: number; onSaveOriginal: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const probing = useRef(false);
  const exporter = useRef<Exporter | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [duration, setDuration] = useState(durationHint > 0 ? durationHint : 0);
  const [zooms, setZooms] = useState<Zoom[]>([]);
  const [mp4, setMp4] = useState<'checking' | 'ok' | 'unsupported'>('checking');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const exporting = progress !== null;

  useEffect(() => {
    let alive = true;
    import('./exportMp4')
      .then(async (m) => {
        exporter.current = m;
        const ok = await m.canExportMp4();
        if (alive) setMp4(ok ? 'ok' : 'unsupported');
      })
      .catch(() => { if (alive) setMp4('unsupported'); });
    return () => { alive = false; abort.current?.abort(); };
  }, []);

  const endProbe = (v: HTMLVideoElement) => { probing.current = false; v.currentTime = 0; };
  const onMetadata = () => {
    const v = video.current;
    if (!v) return;
    if (Number.isFinite(v.duration) && v.duration > 0) { setDuration(v.duration); return; }
    // No duration header (MediaRecorder WebM): seeking far past the end makes the browser scan the file, after which
    // `durationchange` reports the real length. If it never does, keep the measured recording time.
    probing.current = true;
    v.currentTime = Number.MAX_SAFE_INTEGER;
    window.setTimeout(() => { if (probing.current && video.current) endProbe(video.current); }, PROBE_TIMEOUT_MS);
  };
  const onDurationKnown = () => {
    const v = video.current;
    if (!v || !probing.current || !Number.isFinite(v.duration) || v.duration <= 0) return;
    setDuration(v.duration);
    endProbe(v);
  };

  const addZoom = (e: MouseEvent<HTMLVideoElement>) => {
    e.preventDefault(); // no fullscreen toggle on double-click
    const v = video.current;
    if (!v || exporting || !v.videoWidth) return;
    const r = v.getBoundingClientRect();
    const fit = fitContain({ w: v.videoWidth, h: v.videoHeight }, { w: r.width, h: r.height }); // object-contain box
    if (!fit.width || !fit.height) return;
    const x = clamp((e.clientX - r.left - fit.left) / fit.width, 0, 1);
    const y = clamp((e.clientY - r.top - fit.top) / fit.height, 0, 1);
    const start = v.currentTime;
    const end = duration > 0 ? Math.min(duration, start + ZOOM_SECONDS) : start + ZOOM_SECONDS;
    if (end - start < 0.25) return;
    setZooms((z) => [...z, { id: Date.now(), start, end, x, y, level: 2 }].sort((a, b) => a.start - b.start));
  };

  const runExport = async () => {
    const m = exporter.current;
    if (!m || exporting) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setError(null);
    setNote(null);
    setProgress(0);
    try {
      const res = await m.exportMp4(blob, zooms, { duration, signal: ctl.signal, onProgress: setProgress });
      saveBlob(res.blob, recordingName('mp4'));
      if (res.warnings.length) setNote(res.warnings.join(' '));
    } catch (e) {
      if (!ctl.signal.aborted) setError(`Export failed: ${(e as Error).message || 'unknown error'}. You can still save the original recording.`);
    } finally {
      abort.current = null;
      setProgress(null); // the button can never stay stuck on "Exporting…"
    }
  };

  return (
    <div className="mt-8 rounded-2xl border border-line bg-panel p-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-semibold">Mini editor</span>
        {duration > 0 && <span className="text-xs text-muted">{fmt(duration)}</span>}
      </div>
      <video ref={video} src={url} controls controlsList="nofullscreen" disablePictureInPicture playsInline preload="metadata"
        onLoadedMetadata={onMetadata} onDurationChange={onDurationKnown} onTimeUpdate={onDurationKnown} onDoubleClick={addZoom}
        className="max-h-[70vh] w-full rounded-lg bg-black object-contain" />
      <div className="mt-1 text-xs text-muted">Double-click the video at any moment to add a 2× zoom on that spot ({ZOOM_SECONDS} seconds).</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {zooms.map((z) => (
          <span key={z.id} className="flex items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-xs">{z.start.toFixed(1)}–{z.end.toFixed(1)} s · {z.level}×
            <button aria-label={`Remove the zoom at ${z.start.toFixed(1)} seconds`} disabled={exporting} onClick={() => setZooms((x) => x.filter((y) => y.id !== z.id))}><Trash2 size={11} /></button>
          </span>
        ))}
        {zooms.length === 0 && <span className="flex items-center gap-1 text-xs text-muted"><Plus size={12} />No zooms yet</span>}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={onSaveOriginal} className="rounded-lg border border-line px-3 py-1.5 text-sm"><Download size={14} className="inline" /> Save original</button>
        <button disabled={mp4 !== 'ok' || exporting} onClick={() => void runExport()} aria-busy={exporting}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
          {exporting ? <><LoaderCircle size={14} className="animate-spin" />Exporting {Math.round((progress ?? 0) * 100)}%</> : mp4 === 'checking' ? 'Preparing MP4 export…' : 'Export MP4 with zooms'}
        </button>
        {exporting && <button onClick={() => abort.current?.abort()} className="text-sm text-muted hover:text-text">Cancel</button>}
        {mp4 === 'unsupported' && <span className="text-xs text-muted">MP4 export needs a browser with WebCodecs H.264 encoding (Chrome, Edge, Opera, Safari 17+).</span>}
      </div>
      {error && <div role="alert" className="mt-2 text-sm text-danger">{error}</div>}
      {note && <div role="status" className="mt-2 text-xs text-warn">{note}</div>}
    </div>
  );
}
