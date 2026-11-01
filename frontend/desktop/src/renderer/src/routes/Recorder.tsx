/**
 * Recorder window (task 2.1, SET-01, REC-01…09/13): modes, device pickers, live meters, camera bubble,
 * teleprompter, settings, projects. Also records the camera track (MediaRecorder) while a recording runs.
 */
import { AppWindow, Camera, Crop, FolderOpen, Mic, Monitor, ScrollText, Settings as Cog, Smartphone, Upload, Volume2, AlertTriangle, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AudioApp, AudioDevice, DisplayInfo, WindowInfo } from '@rec/shared';
import type { RecState } from '../../../shared/ipc';
import { api, errMsg, route } from '../lib/api';
import { useSettings } from '../lib/useSettings';
import { Button, cx, IconButton, Meter, Modal, Segmented, Select, TextInput, TitleBar, toast, Toggle } from '../ui';
import { DevicePanel } from './DevicePanel';

type Mode = 'display' | 'window' | 'area' | 'device';

export default function Recorder() {
  const { t } = useTranslation();
  const [settings, patch] = useSettings();
  const [mode, setMode] = useState<Mode>('display');
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [displayId, setDisplayId] = useState('');
  const [mics, setMics] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [apps, setApps] = useState<AudioApp[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  const [helperState, setHelperState] = useState<string>('starting');
  const [pickWindow, setPickWindow] = useState(false);
  const [rec, setRec] = useState<RecState>({ state: 'idle', elapsedSec: 0, micMuted: false });
  const [busy, setBusy] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  // bumps when a camera stream becomes available (recording may already be running) or should be re-acquired
  const [camLive, setCamLive] = useState(0);
  const [camEpoch, setCamEpoch] = useState(0);
  const [micBlocked, setMicBlocked] = useState(false);
  const [errorShown, setErrorShown] = useState<string | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  const dev = settings?.devices;

  // ---- device discovery + hot-plug (task 2.11)
  const refreshDevices = async () => {
    try {
      const [d, m, o] = await Promise.all([
        api.invoke<DisplayInfo[]>('devices:displays'),
        api.invoke<AudioDevice[]>('devices:audioInputs'),
        api.invoke<AudioDevice[]>('devices:audioOutputs'),
      ]);
      setDisplays(d);
      setDisplayId((cur) => cur || d.find((x) => x.primary)?.id || d[0]?.id || '');
      setMics(m);
      setOutputs(o);
      api.invoke<AudioApp[]>('devices:audioApps').then(setApps).catch(() => undefined);
    } catch (e) {
      setHelperState('unavailable');
      console.warn(e);
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setCams(all.filter((x) => x.kind === 'videoinput'));
    } catch {
      setCams([]);
    }
  };

  useEffect(() => {
    void api.invoke<{ state: string }>('helper:status').then((s) => {
      setHelperState(s.state);
      if (s.state === 'ready') void refreshDevices();
    });
    const offs = [
      api.on('helper:state', (s: string) => {
        setHelperState(s);
        if (s === 'ready') void refreshDevices();
      }),
      api.on('rec:levels', (l: { mic: number; system: number }) => setLevels(l)),
      api.on('rec:state', (s: RecState) => setRec(s)),
      api.on('hotkey', (a: string) => a === 'pickWindow' && setPickWindow(true)),
    ];
    // a re-plugged camera keeps its id, so retry acquisition on any device change
    const onDeviceChange = () => { void refreshDevices(); setCamEpoch((n) => n + 1); };
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    if (route().query.get('pick') === 'window') { setMode('window'); setPickWindow(true); }
    void api.invoke<Record<string, string>>('permissions:status').then((st) => setMicBlocked(st.microphone === 'denied')).catch(() => undefined);
    return () => {
      offs.forEach((o) => o());
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    };
  }, []);

  useEffect(() => setErrorShown(rec.state === 'idle' ? rec.error : undefined), [rec.state, rec.error]);

  useEffect(() => {
    if (settings) setMode((m) => (m === 'display' ? settings.devices.lastMode : m));
  }, [settings?.devices.lastMode]);

  // ---- level meters while idle
  useEffect(() => {
    if (helperState !== 'ready' || !dev || rec.state !== 'idle' || route().query.get('meters') === '0') return;
    void api.invoke('devices:startLevels', { ...(dev.micId ? { micId: dev.micId } : {}), ...(dev.outputId ? { outputId: dev.outputId } : {}) }).catch(() => undefined);
    return () => void api.invoke('devices:stopLevels').catch(() => undefined);
  }, [helperState, dev?.micId, dev?.outputId, rec.state]);

  // ---- camera preview bubble (REC-05)
  useEffect(() => {
    let cancelled = false;
    const stop = () => {
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
    if (!dev?.cameraEnabled) {
      stop();
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { ...(dev.cameraId ? { deviceId: { exact: dev.cameraId } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((tr) => tr.stop());
        stop();
        streamRef.current = s;
        setCamError(null);
        setCamLive((n) => n + 1);
        if (videoRef.current) videoRef.current.srcObject = s;
        s.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (streamRef.current !== s) return;
          setCamError('Camera disconnected — plug it back in or pick another camera.');
          stop();
        });
      })
      .catch((e: DOMException) => {
        setCamError(e.name === 'NotAllowedError' ? 'Camera permission denied — open privacy settings to allow it.' : e.name === 'NotReadableError' ? 'Camera is busy in another app.' : e.name === 'NotFoundError' ? 'Camera unplugged or not found.' : e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [dev?.cameraEnabled, dev?.cameraId, camEpoch]);

  // ---- camera recording follows the recording state (§4.4.2)
  useEffect(() => {
    const r = recorderRef.current;
    if (rec.state === 'recording') {
      if (!r && streamRef.current && dev?.cameraEnabled) {
        const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
        // a face-cam needs far less than screen content: ~3.5 Mbps at 720p, ~6 Mbps at 1080p+ (was a flat 8 Mbps)
        const camH = streamRef.current.getVideoTracks()[0]?.getSettings().height ?? 720;
        const mr = new MediaRecorder(streamRef.current, { mimeType: mime, videoBitsPerSecond: camH > 800 ? 6_000_000 : 3_500_000 });
        mr.ondataavailable = async (ev) => {
          if (ev.data.size) await api.invoke('rec:cameraChunk', await ev.data.arrayBuffer());
        };
        mr.onstop = () => setTimeout(() => void api.invoke('rec:cameraDone'), 300);
        mr.onstart = () => void api.invoke('rec:cameraStarted', performance.timeOrigin + performance.now());
        mr.start(1000);
        recorderRef.current = mr;
      } else if (r?.state === 'paused') r.resume();
    } else if (rec.state === 'paused' && r?.state === 'recording') r.pause();
    else if ((rec.state === 'stopping' || rec.state === 'idle' || rec.state === 'error') && r) {
      if (r.state !== 'inactive') r.stop();
      recorderRef.current = null;
    }
  }, [rec.state, camLive]);

  const start = async (override?: { windowId?: string }) => {
    if (!settings || !dev) return;
    setBusy(true);
    try {
      let area;
      // a picked window always records that window, whatever mode the recorder shows (tray / hotkey path)
      let m: 'display' | 'window' | 'area' = override?.windowId ? 'window' : mode === 'device' ? 'display' : mode;
      if (mode === 'window' && !override?.windowId) {
        setPickWindow(true);
        return;
      }
      if (mode === 'area') {
        area = await api.invoke<{ x: number; y: number; width: number; height: number; displayId: string } | null>('area:select');
        if (!area) return;
        m = 'area';
      }
      await api.invoke('rec:start', {
        mode: m,
        displayId: area?.displayId ? (displays.find((d) => sameDisplay(d, area))?.id ?? displayId) : displayId,
        ...(override?.windowId ? { windowId: override.windowId } : {}),
        ...(area ? { area } : {}),
        camera: { enabled: dev.cameraEnabled && !camError, ...(dev.cameraId ? { deviceId: dev.cameraId } : {}) },
        mic: { enabled: dev.micEnabled, ...(dev.micId ? { deviceId: dev.micId } : {}) },
        systemAudio: { enabled: dev.systemAudioEnabled, ...(dev.outputId ? { deviceId: dev.outputId } : {}), ...(dev.appPid ? { appPid: dev.appPid } : {}) },
        zoomMode: settings.record.zoomMode,
      });
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const modes = useMemo(
    () => [
      { v: 'display' as const, label: t('recorder.fullScreen'), icon: <Monitor size={20} /> },
      { v: 'window' as const, label: t('recorder.window'), icon: <AppWindow size={20} /> },
      { v: 'area' as const, label: t('recorder.custom'), icon: <Crop size={20} /> },
      { v: 'device' as const, label: t('recorder.device'), icon: <Smartphone size={20} /> },
    ],
    [t],
  );

  if (!settings || !dev) return <div className="h-full bg-bg" />;
  const ready = helperState === 'ready';

  return (
    <div className="flex h-full flex-col bg-bg">
      <TitleBar title={<span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-accent" />Open-Recorder</span>}>
        <IconButton label={t('recorder.projects')} onClick={() => api.invoke('win:open', 'library')}><FolderOpen size={16} /></IconButton>
        <IconButton label={t('recorder.settings')} onClick={() => api.invoke('win:open', 'settings')}><Cog size={16} /></IconButton>
      </TitleBar>

      {!ready && (
        <div className="m-3 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
          <div>
            Capture engine is <b>{helperState}</b>.{' '}
            {helperState === 'unavailable' ? 'The native helper binary was not found — build backend/native/win-helper (dotnet build -c Release).' : 'Starting…'}
          </div>
        </div>
      )}

      {errorShown && (
        <div role="alert" className="mx-3 mt-3 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
          <div className="flex-1">{errorShown}</div>
          <button aria-label="Dismiss" onClick={() => setErrorShown(undefined)}><X size={14} /></button>
        </div>
      )}
      {micBlocked && dev.micEnabled && (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs">
          <AlertTriangle size={16} className="shrink-0 text-warn" />
          <div className="flex-1">Microphone access is blocked in your privacy settings, so your voice won't be recorded.</div>
          <Button size="sm" onClick={() => api.invoke('permissions:open', 'microphone')}>Fix</Button>
        </div>
      )}

      <div className="grid grid-cols-4 gap-2 p-3">
        {modes.map((m) => (
          <button key={m.v} onClick={() => setMode(m.v)} aria-pressed={mode === m.v}
            className={cx('flex flex-col items-center gap-1.5 rounded-xl border py-3 text-xs transition', mode === m.v ? 'border-accent bg-accent/15 text-text' : 'border-line bg-panel text-muted hover:text-text')}>
            {m.icon}
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'device' ? (
        <DevicePanel />
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-auto px-3 pb-3">
          {mode === 'display' && displays.length > 1 && (
            <Select label="Display" value={displayId} onChange={setDisplayId}
              options={displays.map((d) => ({ value: d.id, label: `${d.primary ? '★ ' : ''}Display ${d.index + 1} — ${d.width}×${d.height}` }))} />
          )}

          <div className="rounded-xl border border-line bg-panel p-3">
            <Toggle label={<span className="flex items-center gap-2"><Camera size={15} />{t('recorder.camera')}</span>} checked={dev.cameraEnabled} onChange={(v) => patch({ devices: { cameraEnabled: v } })} />
            {dev.cameraEnabled && (
              <div className="mt-2 flex flex-col gap-2">
                {cams.length === 0 ? (
                  <div className="text-xs text-muted">{t('recorder.noDevice')}</div>
                ) : (
                  <Select value={dev.cameraId ?? cams[0]?.deviceId ?? ''} onChange={(v) => patch({ devices: { cameraId: v } })} options={cams.map((c, i) => ({ value: c.deviceId, label: c.label || `Camera ${i + 1}` }))} />
                )}
                {camError ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-danger/10 p-2 text-xs text-danger">
                    {camError}
                    <Button size="sm" onClick={() => api.invoke('permissions:open', 'camera')}>Fix</Button>
                  </div>
                ) : (
                  <div className="flex justify-center">
                    <video ref={videoRef} autoPlay muted playsInline className="h-28 w-28 rounded-full object-cover ring-2 ring-accent/60" style={{ transform: 'scaleX(-1)' }} />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-panel p-3">
            <Toggle label={<span className="flex items-center gap-2"><Mic size={15} />{t('recorder.microphone')}</span>} checked={dev.micEnabled} onChange={(v) => patch({ devices: { micEnabled: v } })} />
            {dev.micEnabled && (
              <div className="mt-2 flex flex-col gap-2">
                {mics.length === 0 ? <div className="text-xs text-muted">{t('recorder.noDevice')}</div> : (
                  <Select value={dev.micId ?? mics.find((m) => m.isDefault)?.id ?? ''} onChange={(v) => patch({ devices: { micId: v } })} options={mics.map((m) => ({ value: m.id, label: m.name }))} />
                )}
                <Meter value={levels.mic} label="Microphone level" />
                <MicTest label={mics.find((m) => m.id === dev.micId)?.name} />
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-panel p-3">
            <Toggle label={<span className="flex items-center gap-2"><Volume2 size={15} />{t('recorder.systemAudio')}</span>} checked={dev.systemAudioEnabled} onChange={(v) => patch({ devices: { systemAudioEnabled: v } })} />
            {dev.systemAudioEnabled && (
              <div className="mt-2 flex flex-col gap-2">
                <Select value={dev.outputId ?? outputs.find((m) => m.isDefault)?.id ?? ''} onChange={(v) => patch({ devices: { outputId: v } })} options={outputs.map((m) => ({ value: m.id, label: m.name }))} />
                <Select value={String(dev.appPid ?? '')} onChange={(v) => patch({ devices: { appPid: v ? Number(v) : undefined } })}
                  options={[{ value: '', label: t('recorder.allApps') }, ...apps.map((a) => ({ value: String(a.pid), label: `${t('recorder.thisAppOnly')}: ${a.name}` }))]} />
                <Meter value={levels.system} label="System audio level" />
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-xl border border-line bg-panel px-3 py-2">
            <span className="text-xs text-muted">{t('recorder.zoomEffect')}</span>
            <Segmented size="sm" value={settings.record.zoomMode} onChange={(v) => patch({ record: { zoomMode: v } })} options={[{ value: '2d', label: '2D Zoom' }, { value: '3d', label: '3D Motion' }]} />
          </div>
        </div>
      )}

      {mode !== 'device' && (
        <div className="flex items-center gap-2 border-t border-line p-3">
          <IconButton label={t('recorder.import')} onClick={async () => {
            try {
              const dir = await api.invoke<string | null>('projects:import');
              if (dir) await api.invoke('win:open', 'editor', { dir });
            } catch (e) { toast(errMsg(e), 'error'); }
          }}><Upload size={16} /></IconButton>
          <button disabled={!ready || busy || rec.state !== 'idle'} onClick={() => start()}
            className="no-drag flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-accent text-sm font-semibold text-white shadow-lg shadow-accent/30 transition hover:bg-accent-2 disabled:opacity-40">
            <span className="h-3 w-3 rounded-full bg-white" />
            {rec.state === 'countdown' ? 'Get ready…' : rec.state === 'recording' ? 'Recording…' : t('recorder.record')}
          </button>
          <IconButton label={t('recorder.teleprompter')} onClick={() => api.invoke('win:open', 'teleprompter')}><ScrollText size={16} /></IconButton>
        </div>
      )}

      <WindowPicker open={pickWindow} onClose={() => setPickWindow(false)} onPick={(w) => { setPickWindow(false); void start({ windowId: w.id }); }} />
    </div>
  );
}

/** RM-05: record 3 s from the selected microphone and play it back before recording. */
function MicTest({ label }: { label?: string }) {
  const [phase, setPhase] = useState<'idle' | 'rec' | 'play'>('idle');
  const run = async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const match = label ? devs.find((d) => d.kind === 'audioinput' && label.includes(d.label.replace(/^Default - /, '').slice(0, 20))) : undefined;
      const s = await navigator.mediaDevices.getUserMedia({ audio: match ? { deviceId: { exact: match.deviceId } } : true });
      const mr = new MediaRecorder(s);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      setPhase('rec');
      mr.start();
      await new Promise((r) => setTimeout(r, 3000));
      await new Promise<void>((r) => { mr.onstop = () => r(); mr.stop(); });
      s.getTracks().forEach((t) => t.stop());
      setPhase('play');
      const a = new Audio(URL.createObjectURL(new Blob(chunks, { type: mr.mimeType })));
      a.onended = () => setPhase('idle');
      await a.play();
    } catch (e) {
      toast(errMsg(e), 'error');
      setPhase('idle');
    }
  };
  return <Button size="sm" variant="ghost" disabled={phase !== 'idle'} onClick={run}>{phase === 'rec' ? 'Speak now… (3 s)' : phase === 'play' ? 'Playing back…' : 'Test microphone'}</Button>;
}

function sameDisplay(d: DisplayInfo, a: { x: number; y: number }): boolean {
  const sf = d.scaleFactor || 1;
  const x = d.x / sf, y = d.y / sf, w = d.width / sf, h = d.height / sf;
  return a.x >= x && a.x < x + w && a.y >= y && a.y < y + h;
}

function WindowPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (w: WindowInfo) => void }) {
  const [wins, setWins] = useState<WindowInfo[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!open) return;
    void api.invoke('win:setSize', 860, 640);
    void api.invoke<WindowInfo[]>('devices:windows').then((ws) => {
      setWins(ws);
      for (const w of ws.slice(0, 40)) {
        void api.invoke<{ png: string | null }>('devices:windowThumbnail', w.id).then((r) => r.png && setThumbs((t) => ({ ...t, [w.id]: `data:image/png;base64,${r.png}` }))).catch(() => undefined);
      }
    });
    return () => void api.invoke('win:setSize', 420, 640);
  }, [open]);
  const shown = wins.filter((w) => `${w.title} ${w.app}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title="Choose a window" width={820}>
      <TextInput autoFocus placeholder="Search windows…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3 w-full" />
      <div className="grid grid-cols-3 gap-3">
        {shown.map((w) => (
          <button key={w.id} onClick={() => onPick(w)} className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel-2 p-2 text-left hover:border-accent">
            <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-black/40">
              {thumbs[w.id] ? <img src={thumbs[w.id]} alt="" className="max-h-full max-w-full object-contain" /> : <AppWindow className="text-muted" />}
            </div>
            <div className="truncate text-xs font-medium">{w.title}</div>
            <div className="truncate text-[11px] text-muted">{w.app} · {w.width}×{w.height}</div>
          </button>
        ))}
      </div>
    </Modal>
  );
}
