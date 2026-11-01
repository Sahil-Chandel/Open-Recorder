/**
 * Export dialog (tasks 4.1, 4.4, 4.5; EXP-01…07): name, folder, MP4/GIF, resolution, fps, quality,
 * save as default; progress with ETA + cancel; after export: copy file, open folder, share.
 */
import { CheckCircle2, ClipboardCopy, FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { applySocialTarget, canvasAspect, cloneData, croppedSourceSize, durationWarning, estimateGifBytes, exportDimensions, FPS_OPTIONS, QUALITIES, RESOLUTIONS, SOCIAL_TARGETS, socialTarget, type ExportSettings, type Project } from '@rec/shared';
import type { Settings } from '../../../shared/ipc';
import { startExport, type ExportJob } from '../export/exporter';
import { api, errMsg } from '../lib/api';
import { Button, Field, Modal, Segmented, Select, TextInput, toast, Toggle } from '../ui';
import { useEditor } from './store';
import { useTasks } from './tasks';

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)!;
  const duration = useEditor((s) => s.derived?.duration ?? 0);
  const [s, setS] = useState<ExportSettings | null>(null);
  const [saveDefault, setSaveDefault] = useState(false);
  const [phase, setPhase] = useState<'form' | 'running' | 'done' | 'error'>('form');
  const [progress, setProgress] = useState({ p: 0, stage: '' });
  const [result, setResult] = useState<{ path: string; bytes: number } | null>(null);
  const [error, setError] = useState('');
  // "record once, reach all": extra platform versions rendered after the main export
  const [extra, setExtra] = useState<string[]>([]);
  const [done, setDone] = useState<Array<{ path: string; bytes: number }>>([]);
  const job = useRef<ExportJob | null>(null);
  const started = useRef(0);

  useEffect(() => {
    void api.invoke<Settings>('settings:get').then((st) => {
      // a social target overrides the saved defaults with the platform's recommended upload size / fps
      const t = socialTarget(project.canvas.target);
      setS(t
        ? { ...st.export, format: 'mp4', resolution: '1080p', fps: t.fps, name: `${project.name} - ${t.name}`, dir: st.general.exportDir }
        : { ...st.export, name: project.name, dir: st.general.exportDir });
    });
  }, []);
  if (!s) return null;
  const aspect = canvasAspect(project.canvas, project.source.width, project.source.height);
  const dims = exportDimensions(s.resolution, aspect, Math.min(project.source.width, project.source.height), s.format);
  const gifBytes = s.format === 'gif' ? estimateGifBytes(dims.width, dims.height, s.fps, duration) : 0;
  const target = socialTarget(project.canvas.target);
  const tooLong = durationWarning(target, duration);

  const run = async () => {
    if (saveDefault) {
      try { await api.invoke('settings:set', { export: { format: s.format, resolution: s.resolution, fps: s.fps, quality: s.quality } }); }
      catch (e) { toast(`Couldn't save these as defaults: ${errMsg(e)}`, 'warning'); }
    }
    const st = useEditor.getState();
    setPhase('running');
    started.current = Date.now();
    const taskId = `export-${started.current}`;
    const tasks = useTasks.getState();
    const proj = st.project!;
    // the main export first, then one per extra platform (same edit, re-framed for that platform)
    const versions: Array<{ project: Project; settings: ExportSettings; label: string }> = [{ project: proj, settings: s, label: s.name }];
    if (s.format === 'mp4') {
      for (const id of extra) {
        const t = socialTarget(id);
        if (!t) continue;
        const v = cloneData(proj);
        const src = croppedSourceSize(v.source.width, v.source.height, v.canvas.crop);
        applySocialTarget(t, v.canvas, { sourceAspect: src.w / src.h, hasCamera: !!v.source.tracks.camera && v.camera.visible, ...(v.captions ? { captionStyle: v.captions.style } : {}) });
        versions.push({ project: v, settings: { ...s, name: `${project.name} - ${t.name}`, resolution: '1080p', fps: t.fps }, label: t.name });
      }
    }
    const results: Array<{ path: string; bytes: number }> = [];
    try {
      for (const [i, ver] of versions.entries()) {
        const n = versions.length > 1 ? `${i + 1}/${versions.length} · ${ver.label} · ` : '';
        job.current = startExport({
          project: ver.project,
          opened: st.opened!,
          telemetry: st.telemetry,
          settings: ver.settings,
          onProgress: (p, stage) => {
            const total = (i + p) / versions.length;
            setProgress({ p: total, stage: n + stage });
            tasks.upsert({ id: taskId, title: `Export ${s.name}${versions.length > 1 ? ` (+${versions.length - 1} versions)` : `.${s.format}`}`, kind: 'export', progress: total, status: 'running', detail: n + stage, cancel: () => job.current?.cancel() });
          },
        });
        results.push(await job.current.promise);
      }
      const r = results[0]!;
      setResult(r);
      setDone(results);
      setPhase('done');
      tasks.upsert({ id: taskId, status: 'done', progress: 1, result: () => api.invoke('app:showItemInFolder', r.path) });
    } catch (e) {
      if (results.length) setDone(results);
      const msg = errMsg(e);
      if ((e as DOMException).name === 'AbortError') { setPhase('form'); tasks.upsert({ id: taskId, status: 'cancelled' }); return; }
      setError(msg);
      setPhase('error');
      tasks.upsert({ id: taskId, status: 'error', detail: msg });
    }
  };

  const elapsed = (Date.now() - started.current) / 1000;
  const etaS = progress.p > 0.02 ? (elapsed / progress.p) * (1 - progress.p) : 0;

  return (
    <Modal open onClose={() => (phase === 'running' ? undefined : onClose())} title="Export" width={500}
      footer={phase === 'form' ? <><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={run}>Export</Button></>
        : phase === 'running' ? <Button onClick={() => job.current?.cancel()}>Cancel export</Button>
          : <Button variant="primary" onClick={onClose}>Close</Button>}>
      {phase === 'form' && (
        <div className="flex flex-col gap-3">
          <Field label="Name"><TextInput value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field>
          <Field label="Save to">
            <div className="flex gap-2"><TextInput readOnly value={s.dir} className="flex-1" /><Button onClick={async () => { const d = await api.invoke<string | null>('export:chooseDir', s.dir); if (d) setS({ ...s, dir: d }); }}>Browse…</Button></div>
          </Field>
          <Field label="Format"><Segmented value={s.format} onChange={(v) => setS({ ...s, format: v, ...(v === 'gif' ? { fps: 10, resolution: s.resolution === '4k' || s.resolution === '2k' || s.resolution === '1080p' ? '720p' : s.resolution } : {}) })} options={[{ value: 'mp4', label: 'MP4' }, { value: 'gif', label: 'GIF' }]} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Select label="Resolution" value={s.resolution} onChange={(v) => setS({ ...s, resolution: v })} options={RESOLUTIONS.map((r) => ({ value: r, label: r === 'original' ? 'Original' : r.toUpperCase() }))} />
            <Select label="Frame rate" value={String(s.fps)} onChange={(v) => setS({ ...s, fps: Number(v) })} options={FPS_OPTIONS.filter((f) => s.format === 'mp4' || f <= 20).map((f) => ({ value: String(f), label: `${f} fps` }))} />
            <Select label="Quality" value={s.quality} onChange={(v) => setS({ ...s, quality: v })} options={QUALITIES.map((q) => ({ value: q, label: q[0]!.toUpperCase() + q.slice(1) }))} />
          </div>
          <div className="text-xs text-muted">{dims.width} × {dims.height} · {Math.round(duration)} s{s.format === 'gif' ? ` · ≈ ${(gifBytes / 1e6).toFixed(1)} MB` : ''}</div>
          {s.format === 'gif' && gifBytes > 25e6 && <div className="rounded-lg bg-warn/10 p-2 text-xs text-warn">This GIF will be large. Try a lower resolution, fps or a shorter clip.</div>}
          {target && <div className="text-xs text-muted">Set up for <b className="text-text">{target.name}</b> — recommended {target.width}×{target.height} at {target.fps} fps.</div>}
          {tooLong && <div className="rounded-lg bg-warn/10 p-2 text-xs text-warn">{tooLong}</div>}
          {s.format === 'mp4' && (
            <Field label="Also export for (record once, reach all)">
              <div className="flex flex-wrap gap-1">
                {SOCIAL_TARGETS.filter((t) => t.id !== project.canvas.target).map((t) => {
                  const on = extra.includes(t.id);
                  return (
                    <button key={t.id} aria-pressed={on} onClick={() => setExtra(on ? extra.filter((x) => x !== t.id) : [...extra, t.id])}
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? 'border-accent bg-accent/20 text-accent-2' : 'border-line hover:border-muted'}`}>
                      {t.name} <span className="text-muted">{t.aspect}</span>
                    </button>
                  );
                })}
              </div>
              {extra.length > 0 && <div className="mt-1 text-[11px] text-muted">{extra.length} extra version{extra.length > 1 ? 's' : ''} at 1080p, re-framed for each platform. The current edit is not changed.</div>}
            </Field>
          )}
          <Toggle label="Use these settings for future exports" checked={saveDefault} onChange={setSaveDefault} />
        </div>
      )}
      {phase === 'running' && (
        <div className="flex flex-col gap-3">
          <div className="h-2 overflow-hidden rounded-full bg-line"><div className="h-full bg-accent transition-[width]" style={{ width: `${progress.p * 100}%` }} /></div>
          <div className="flex justify-between text-xs text-muted"><span>{progress.stage}</span><span>{Math.round(progress.p * 100)}%{etaS > 0 ? ` · ${Math.ceil(etaS)} s left` : ''}</span></div>
        </div>
      )}
      {phase === 'done' && result && (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 size={40} className="text-ok" />
          <div className="text-sm">{done.length > 1 ? `Exported ${done.length} videos` : `Exported ${(result.bytes / 1e6).toFixed(1)} MB`}</div>
          {done.length > 1
            ? <ul className="max-w-full text-left text-xs text-muted">{done.map((d) => <li key={d.path} className="truncate">{d.path.split(/[\\/]/).pop()} · {(d.bytes / 1e6).toFixed(1)} MB</li>)}</ul>
            : <div className="max-w-full truncate text-xs text-muted">{result.path}</div>}
          <div className="flex gap-2">
            <Button onClick={() => api.invoke('app:copyFileToClipboard', result.path).then(() => toast('File copied — paste it anywhere', 'success')).catch((e) => toast(errMsg(e), 'error'))}><ClipboardCopy size={14} />Copy file</Button>
            <Button onClick={() => api.invoke('app:showItemInFolder', result.path)}><FolderOpen size={14} />Open folder</Button>
          </div>
        </div>
      )}
      {phase === 'error' && <div className="rounded-lg bg-danger/10 p-3 text-xs text-danger">Export failed: {error}</div>}
    </Modal>
  );
}