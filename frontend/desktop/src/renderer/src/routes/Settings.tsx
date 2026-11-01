/**
 * Settings window (task 2.7, SET-03…08): General · Record · Shortcut keys (record + edit) · Export · About.
 */
import { useEffect, useState } from 'react';
import { FPS_OPTIONS, QUALITIES, RESOLUTIONS } from '@rec/shared';
import { LANGUAGES } from '../i18n';
import { api, errMsg, isMac, route } from '../lib/api';
import { useSettings } from '../lib/useSettings';
import { Button, Field, Section, Segmented, Select, Slider, Tabs, TextInput, TitleBar, Toggle, toast } from '../ui';
import { PROJECT_URL } from '../../../shared/project';

type Tab = 'general' | 'record' | 'shortcuts' | 'export' | 'about';

const RECORD_LABELS: Record<string, string> = {
  newRecording: 'New recording', fullScreen: 'Record full screen', custom: 'Record custom area', window: 'Record window', pauseResume: 'Pause / Continue', finish: 'Finish recording', pauseKeys: 'Pause keystroke capture',
};
const EDIT_LABELS: Record<string, string> = {
  split: 'Clip (split)', crop: 'Crop', addZoom: 'Add zoom', save: 'Save', saveAs: 'Save as', toStart: 'Move to timeline start', toEnd: 'Move to timeline end',
  zoomInTimeline: 'Zoom in timeline', zoomOutTimeline: 'Zoom out timeline', copyProps: 'Copy properties', pasteProps: 'Paste properties', history: 'Open history',
  undo: 'Undo', redo: 'Redo', reset: 'Reset', playPause: 'Play / Pause', delete: 'Delete selection',
  addText: 'Add text', addBlur: 'Add blur', addSpotlight: 'Add spotlight', addArrow: 'Add arrow',
};

/** Accelerator → readable label (⌘⌥⇧ on macOS). */
function prettyAccel(v: string): string {
  if (!v) return 'Not set';
  const mac = isMac();
  const map: Record<string, string> = mac
    ? { CommandOrControl: '⌘', Command: '⌘', Mod: '⌘', Alt: '⌥', Shift: '⇧', Control: '⌃' }
    : { CommandOrControl: 'Ctrl', Mod: 'Ctrl', Control: 'Ctrl' };
  return v.split('+').map((p) => map[p] ?? p).join(mac ? '' : '+');
}

/** Capture a key combo as an Electron accelerator ("CommandOrControl+Shift+1") or editor combo ("Mod+Z"). */
function ShortcutInput({ value, onChange, electron }: { value: string; onChange: (v: string) => void; electron: boolean }) {
  const [rec, setRec] = useState(false);
  return (
    <button
      className={`no-drag h-8 min-w-40 rounded-lg border px-2 text-xs ${rec ? 'border-accent text-accent-2' : 'border-line bg-panel-2'}`}
      onClick={() => setRec(true)}
      onBlur={() => setRec(false)}
      onKeyDown={(e) => {
        if (!rec) return;
        e.preventDefault();
        if (e.key === 'Escape') return setRec(false);
        if (e.key === 'Backspace') { onChange(''); return setRec(false); }
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        const parts: string[] = [];
        if (e.ctrlKey || e.metaKey) parts.push(electron ? 'CommandOrControl' : 'Mod');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        const k = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
        parts.push(k);
        onChange(parts.join('+'));
        setRec(false);
      }}
    >
      {rec ? 'Press keys…' : prettyAccel(value)}
    </button>
  );
}

export default function SettingsPage() {
  const [s, patch] = useSettings();
  const [tab, setTab] = useState<Tab>((route().query.get('tab') as Tab) ?? 'general');
  const [info, setInfo] = useState<Record<string, unknown>>({});
  useEffect(() => void api.invoke<Record<string, unknown>>('app:info').then(setInfo), []);
  const [hotkeysFailed, setHotkeysFailed] = useState<string[]>([]);
  const recordShortcuts = JSON.stringify(s?.shortcuts.record ?? {});
  useEffect(() => void api.invoke<{ failed: string[] }>('hotkeys:status').then((r) => setHotkeysFailed(r.failed)).catch(() => undefined), [recordShortcuts]);
  if (!s) return null;
  const set = (p: Record<string, unknown>) => patch(p).catch((e) => toast(errMsg(e), 'error'));

  return (
    <div className="flex h-full flex-col bg-bg">
      <TitleBar title="Settings" />
      <div className="px-4 pt-2">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'general', label: 'General' }, { value: 'record', label: 'Record' }, { value: 'shortcuts', label: 'Shortcut keys' },
          { value: 'export', label: 'Export' }, { value: 'about', label: 'About' },
        ]} />
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'general' && (
          <>
            <Section title="Locations">
              <Field label="Save location (recordings)">
                <div className="flex gap-2">
                  <TextInput readOnly value={s.general.saveDir} className="flex-1" />
                  <Button onClick={async () => { const d = await api.invoke<string | null>('export:chooseDir', s.general.saveDir); if (d) void set({ general: { saveDir: d } }); }}>Change…</Button>
                </div>
              </Field>
              <Field label="Export location">
                <div className="flex gap-2">
                  <TextInput readOnly value={s.general.exportDir} className="flex-1" />
                  <Button onClick={async () => { const d = await api.invoke<string | null>('export:chooseDir', s.general.exportDir); if (d) void set({ general: { exportDir: d } }); }}>Change…</Button>
                </div>
              </Field>
            </Section>
            <Section title="App">
              <Toggle label="Launch at startup" checked={s.general.launchAtLogin} onChange={(v) => set({ general: { launchAtLogin: v } })} />
              <Toggle label="Auto-play video when entering the editor" checked={s.general.autoplayInEditor} onChange={(v) => set({ general: { autoplayInEditor: v } })} />
              <Select label="Language" value={s.general.language} onChange={(v) => set({ general: { language: v } })} options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))} />
              <Select label="Preview quality" value={s.general.previewQuality} onChange={(v) => set({ general: { previewQuality: v } })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'high', label: 'High (1080p)' }, { value: 'low', label: 'Low-end mode (540p)' }]} />
              <Select label="Theme" value={s.general.theme} onChange={(v) => set({ general: { theme: v } })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
              {isMac() && (
                <Select label="Recording engine" value={s.general.recordingEngine} onChange={(v) => set({ general: { recordingEngine: v } })}
                  options={[{ value: 'modern', label: 'Modern (ScreenCaptureKit)' }, { value: 'traditional', label: 'Traditional (compatibility)' }]} />
              )}
              <Toggle label="Share anonymous usage statistics" hint="Opt-in. No screen content, keystrokes or file names are ever sent." checked={s.analyticsOptIn} onChange={(v) => set({ analyticsOptIn: v })} />
            </Section>
          </>
        )}
        {tab === 'record' && (
          <Section title="Recording">
            <Toggle label="Auto-add zoom effects" hint="Generate zooms from clicks and typing after recording" checked={s.record.autoZoom} onChange={(v) => set({ record: { autoZoom: v } })} />
            <Field label="Default zoom effect">
              <Segmented value={s.record.zoomMode} onChange={(v) => set({ record: { zoomMode: v } })} options={[{ value: '2d', label: '2D Zoom' }, { value: '3d', label: '3D Motion' }]} />
            </Field>
            <Toggle label="Hide desktop icons while recording" checked={s.record.hideDesktopIcons} onChange={(v) => set({ record: { hideDesktopIcons: v } })} />
            <Toggle label={isMac() ? 'Hide Dock while recording' : 'Hide taskbar while recording'} checked={s.record.hideTaskbar} onChange={(v) => set({ record: { hideTaskbar: v } })} />
            <Select label="Recording quality" value={s.record.quality} onChange={(v) => set({ record: { quality: v } })}
              options={[{ value: 'low', label: 'Low (small files)' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High (recommended)' }, { value: 'lossless', label: 'Very high' }]} />
            <Select label="Frame rate" value={String(s.record.fps)} onChange={(v) => set({ record: { fps: Number(v) } })} options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]} />
            <Select label="Encoder" value={s.record.encoder} onChange={(v) => set({ record: { encoder: v } })}
              options={[{ value: 'auto', label: 'Automatic (hardware first)' }, { value: 'nvenc', label: 'NVIDIA NVENC' }, { value: 'qsv', label: 'Intel Quick Sync' }, { value: 'amf', label: 'AMD AMF' }, { value: 'x264', label: 'Software (x264)' }]} />
            <Slider label="Countdown before recording" value={s.record.countdown} min={0} max={10} step={1} onChange={(v) => set({ record: { countdown: v } })} format={(v) => `${v}`} suffix=" s" />
          </Section>
        )}
        {tab === 'shortcuts' && (
          <>
            <Section title="Record (global)">
              {Object.entries(RECORD_LABELS).map(([k, label]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <span>
                    {label}
                    {hotkeysFailed.includes(k) && <span className="block text-[11px] text-danger">Already used by another app (or duplicated) — press a different combo</span>}
                  </span>
                  <ShortcutInput electron value={s.shortcuts.record[k] ?? ''} onChange={(v) => set({ shortcuts: { record: { [k]: v } } })} />
                </div>
              ))}
            </Section>
            <Section title="Edit (in editor)">
              {Object.entries(EDIT_LABELS).map(([k, label]) => (
                <div key={k} className="flex items-center justify-between">
                  <span>{label}</span>
                  <ShortcutInput electron={false} value={s.shortcuts.edit[k] ?? ''} onChange={(v) => set({ shortcuts: { edit: { [k]: v } } })} />
                </div>
              ))}
            </Section>
          </>
        )}
        {tab === 'export' && (
          <Section title="Default export settings (SET-07)">
            <Segmented value={s.export.format} onChange={(v) => set({ export: { format: v } })} options={[{ value: 'mp4', label: 'MP4' }, { value: 'gif', label: 'GIF' }]} />
            <Select label="Resolution" value={s.export.resolution} onChange={(v) => set({ export: { resolution: v } })} options={RESOLUTIONS.map((r) => ({ value: r, label: r === 'original' ? 'Original' : r.toUpperCase() }))} />
            <Select label="Frame rate" value={String(s.export.fps)} onChange={(v) => set({ export: { fps: Number(v) } })} options={FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` }))} />
            <Select label="Quality" value={s.export.quality} onChange={(v) => set({ export: { quality: v } })} options={QUALITIES.map((q) => ({ value: q, label: q[0]!.toUpperCase() + q.slice(1) }))} />
            <Button onClick={() => set({ export: { format: 'mp4', resolution: '1080p', fps: 60, quality: 'high' } })}>Use recommended settings</Button>
          </Section>
        )}
        {tab === 'about' && (
          <Section title="About">
            <div className="text-sm">Open-Recorder <span className="text-muted">v{String(info.version ?? '')} · free and open source</span></div>
            <div className="text-xs text-muted">Electron {String(info.electron ?? '')} · {String(info.platform ?? '')}/{String(info.arch ?? '')} · capture helper: {String(info.helperState ?? '')}</div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={async () => {
                try {
                  const r = await api.invoke<{ configured?: boolean }>('app:checkUpdates');
                  if (r.configured === false) {
                    if (PROJECT_URL) void api.invoke('app:openExternal', `${PROJECT_URL}/releases`);
                    else toast('This build has no update feed — download new versions from the project page.');
                  }
                } catch (e) { toast(errMsg(e), 'error'); }
              }}>Check for updates</Button>
              <Button onClick={() => api.invoke('win:open', 'onboarding')}>Permissions</Button>
              {PROJECT_URL && <Button onClick={() => api.invoke('app:openExternal', PROJECT_URL)}>Project page & guide</Button>}
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
              <div className="text-xs font-semibold">Report a problem</div>
              <div className="text-xs text-muted">Describe what happened and attach the log file. Logs contain no screen content and no typed text.</div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => api.invoke('app:openLogs')}>Show log file</Button>
                {PROJECT_URL && <Button size="sm" onClick={() => api.invoke('app:openExternal', `${PROJECT_URL}/issues/new`)}>Open an issue</Button>}
              </div>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

