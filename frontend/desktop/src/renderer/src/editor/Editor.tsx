/**
 * Editor window (task 3.1, EDT-01/02): top bar (File, name, Preset, Pro Edit, Export, tasks),
 * left module rail, properties panel, player, timeline. Global edit shortcuts (SET-06).
 */
import { AudioLines, Captions, FileVideo, Keyboard, MousePointer2, Pause, Play, Redo2, Scissors, Shapes, SkipBack, SkipForward, Sparkles, Stamp, Undo2, Video, ListTodo } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTime } from '@rec/shared';
import type { Settings } from '../../../shared/ipc';
import { api, errMsg, modKey } from '../lib/api';
import { Button, cx, IconButton, TitleBar, toast } from '../ui';
import { CanvasInteraction } from './CanvasInteraction';
import { CropModal, type CropTarget } from './CropModal';
import { EditorTour } from './Tour';
import { ExportDialog } from './ExportDialog';
import { FileMenu } from './FileMenu';
import { PresetMenu } from './PresetMenu';
import { TaskCenter } from './TaskCenter';
import { Player } from './Player';
import { SelectionPanel } from './panels/SelectionPanel';
import { ModulePanel } from './panels/ModulePanel';
import { useEditor, type ModuleId } from './store';
import { Timeline } from './Timeline';
import { AudioMeter } from './AudioMeter';
import { useEditShortcuts } from './shortcuts';
import { attachCachedMask } from './segmentation';
import { runSmokeExport } from '../export/smokeExport';
import { SafeZoneOverlay } from './SafeZoneOverlay';

const MODULES: Array<{ id: ModuleId; icon: React.ReactNode }> = [
  { id: 'video', icon: <FileVideo size={18} /> },
  { id: 'cursor', icon: <MousePointer2 size={18} /> },
  { id: 'camera', icon: <Video size={18} /> },
  { id: 'animations', icon: <Sparkles size={18} /> },
  { id: 'keys', icon: <Keyboard size={18} /> },
  { id: 'annotation', icon: <Shapes size={18} /> },
  { id: 'audio', icon: <AudioLines size={18} /> },
  { id: 'captions', icon: <Captions size={18} /> },
  { id: 'smartcut', icon: <Scissors size={18} /> },
  { id: 'watermark', icon: <Stamp size={18} /> },
];

export default function Editor({ dir: initialDir }: { dir: string }) {
  const { t } = useTranslation();
  const project = useEditor((s) => s.project);
  const module = useEditor((s) => s.module);
  const playing = useEditor((s) => s.playing);
  const time = useEditor((s) => s.time);
  const duration = useEditor((s) => s.derived?.duration ?? 0);
  const dirty = useEditor((s) => s.dirty);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const selKind = useEditor((s) => s.selection.kind);
  const [dir, setDir] = useState(initialDir);
  const [exportOpen, setExportOpen] = useState(false);
  const [proBusy, setProBusy] = useState<string | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropTarget | null>(null);

  useEffect(() => {
    void api.invoke<Settings>('settings:get').then(setSettings);
    const offs = [api.on('project:opened', (d: string) => setDir(d)), api.on('settings:changed', setSettings)];
    const onCrop = (e: Event) => setCrop((e as CustomEvent<CropTarget | undefined>).detail ?? 'screen');
    window.addEventListener('editor:crop', onCrop);
    offs.push(() => window.removeEventListener('editor:crop', onCrop));
    return () => offs.forEach((o) => o());
  }, []);

  useEffect(() => {
    if (!dir) return;
    setLoadError(null);
    void useEditor.getState().load(dir).then(async () => {
      void attachCachedMask();
      const q = new URLSearchParams(window.location.hash.split('?')[1]);
      if (q.get('smokeAsr')) await (await import('../export/smokeAsr')).runSmokeAsr();
      if (q.get('smokeExport')) return void runSmokeExport();
      // read settings here: the component's settings state may still be loading on first open
      const st = await api.invoke<Settings>('settings:get');
      if (st.general.autoplayInEditor) useEditor.getState().setPlaying(true);
    }).catch((e) => setLoadError(errMsg(e)));
  }, [dir]);

  useEditShortcuts(settings?.shortcuts.edit ?? {}, { openExport: () => setExportOpen(true) });

  if (loadError) return <div className="flex h-full flex-col"><TitleBar title="Editor" /><div className="m-auto max-w-md text-center text-sm text-danger">Could not open project: {loadError}</div></div>;
  if (!project) return <div className="flex h-full flex-col"><TitleBar title="Editor" /><div className="m-auto text-sm text-muted">Loading…</div></div>;
  const { undo, redo, setPlaying, setTime, setModule } = useEditor.getState();

  return (
    <div className="flex h-full flex-col bg-bg">
      <TitleBar title={
        <div className="flex items-center gap-2">
          <FileMenu dir={dir} onExport={() => setExportOpen(true)} />
          <span className="max-w-72 truncate text-[13px]">{project.name}</span>
          <span className="text-[11px] text-muted">{dirty ? 'Saving…' : 'Saved'}</span>
        </div>
      }>
        <IconButton label={`Undo (${modKey()}+Z)`} disabled={!canUndo} onClick={undo}><Undo2 size={16} /></IconButton>
        <IconButton label={`Redo (${modKey()}+Shift+Z)`} disabled={!canRedo} onClick={redo}><Redo2 size={16} /></IconButton>
        <PresetMenu />
        <IconButton label="Tasks" onClick={() => setTasksOpen(!tasksOpen)}><ListTodo size={16} /></IconButton>
        <Button size="sm" variant="ghost" disabled={!!proBusy} title="One-click Pro Edit: Smart Cut, captions, noise reduction, zooms and your default preset — one Undo reverts it" onClick={async () => {
          setProBusy('Starting');
          try {
            const m = await import('./proEdit');
            const done = await m.runProEdit((s) => setProBusy(s));
            toast(done.length ? `Pro Edit: ${done.join(' · ')}` : 'Nothing to change', 'success', { label: 'Undo', run: () => useEditor.getState().undo() });
          } catch (err) { toast(errMsg(err), 'error'); } finally { setProBusy(null); }
        }}><Sparkles size={14} />{proBusy ?? 'Pro Edit'}</Button>
        <Button size="sm" variant="primary" data-tour="export" onClick={() => setExportOpen(true)}>{t('editor.export')}</Button>
      </TitleBar>

      <div className="flex min-h-0 flex-1">
        <nav className="scrollbar-none flex w-[72px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden border-r border-line bg-panel py-1.5" aria-label="Modules" data-tour="modules">
          {MODULES.map((m) => (
            <button key={m.id} onClick={() => setModule(m.id)} aria-pressed={module === m.id}
              className={cx('flex w-16 shrink-0 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] leading-tight transition', module === m.id ? 'bg-accent/20 text-accent-2' : 'text-muted hover:bg-panel-2 hover:text-text')}>
              {m.icon}
              {t(`editor.modules.${m.id}`)}
            </button>
          ))}
        </nav>
        <aside className="w-[300px] shrink-0 overflow-y-auto border-r border-line bg-panel" aria-label="Properties">
          {selKind ? <SelectionPanel /> : <ModulePanel module={module} />}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 p-4">
            <Player>{(g) => <><SafeZoneOverlay box={g.box} /><CanvasInteraction geom={g} /></>}</Player>
          </div>
          <div className="flex h-11 items-center justify-center gap-2 border-t border-line bg-panel">
            <IconButton label="Go to start" onClick={() => setTime(0)}><SkipBack size={16} /></IconButton>
            <button aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!playing)} className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white hover:bg-accent-2">
              {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
            </button>
            <IconButton label="Go to end" onClick={() => setTime(duration)}><SkipForward size={16} /></IconButton>
            <span className="ml-2 font-mono text-xs tabular-nums text-muted">{formatTime(time)} / {formatTime(duration)}</span>
            <span className="ml-3"><AudioMeter /></span>
          </div>
        </main>
        {tasksOpen && <TaskCenter onClose={() => setTasksOpen(false)} />}
      </div>
      <div className="h-[230px] shrink-0" data-tour="timeline">
        <Timeline />
      </div>
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {crop && <CropModal target={crop} onClose={() => setCrop(null)} />}
      <EditorTour />
    </div>
  );
}

export function useSaveShortcutToast(): void {
  useEffect(() => {
    const off = api.on('menu', (m: string) => m === 'saved' && toast('Saved', 'success'));
    return off;
  }, []);
}
