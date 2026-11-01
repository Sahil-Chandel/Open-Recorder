/**
 * Device mode (task 11.6, REC-04, DEV-01…06): Android via USB (adb + scrcpy; adb is downloaded on demand when
 * missing), connection guide, live mirror (WebCodecs decode of the H.264 stream), multi-device switcher,
 * record → device project. Device audio is its own track; the computer's mic + system audio (capture helper)
 * and webcam (MediaRecorder here, streamed into the bundle) are recorded alongside and aligned in main.
 * Main owns the take: Stop, Disconnect, leaving this tab, unplugging and closing the window all finalise it.
 * iPhone/iPad: macOS capture helper (Windows later).
 */
import { AlertTriangle, Circle, Download, RefreshCw, Smartphone, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AudioDevice } from '@rec/shared';
import type { AdbProgress, AdbStatus, AndroidMirrorInfo, AndroidRecordResult, AndroidRecState, AndroidTrack } from '../../../shared/ipc';
import { api, errMsg, isMac } from '../lib/api';
import { useSettings } from '../lib/useSettings';
import { Button, Segmented, Select, toast, Toggle } from '../ui';

interface Dev { serial: string; state: string; model: string }
type Phase = 'idle' | 'starting' | 'recording' | 'saving';

const PLATFORM_TOOLS_INFO = 'https://developer.android.com/tools/releases/platform-tools';
const now = (): number => performance.timeOrigin + performance.now();
const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function openCamera(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false });
}

/** Fallback mic (no capture helper): the helper device chosen in settings, matched to a browser device by name. */
async function openMic(micId?: string): Promise<MediaStream> {
  let deviceId: string | undefined;
  if (micId) {
    const name = (await api.invoke<AudioDevice[]>('devices:audioInputs').catch(() => [] as AudioDevice[])).find((m) => m.id === micId)?.name;
    if (name) {
      const devs = await navigator.mediaDevices.enumerateDevices();
      deviceId = devs.find((d) => d.kind === 'audioinput' && d.label && (d.label.includes(name) || name.includes(d.label.replace(/^Default - /, ''))))?.deviceId;
    }
  }
  // raw like the helper's capture: the editor has its own denoise / levelling
  return navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
}

export function DevicePanel() {
  const [settings, patch] = useSettings();
  const dev = settings?.devices;
  const [platform, setPlatform] = useState<'android' | 'ios'>('android');
  const [adb, setAdb] = useState<AdbStatus | null>(null);
  const [adbRev, setAdbRev] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [adbProgress, setAdbProgress] = useState<AdbProgress | null>(null);
  const [adbError, setAdbError] = useState<string | null>(null);
  const [devices, setDevices] = useState<Dev[]>([]);
  const [serial, setSerial] = useState('');
  const [mirror, setMirror] = useState<AndroidMirrorInfo | null>(null);
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const decoder = useRef<VideoDecoder | null>(null);
  const tracks = useRef(new Map<AndroidTrack, MediaRecorder>());
  const phaseRef = useRef<Phase>('idle');

  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };

  /** stop the renderer-side tracks; each flushes its last chunk, then tells main it is done */
  const stopTracks = () => {
    for (const mr of tracks.current.values()) if (mr.state !== 'inactive') mr.stop();
    tracks.current.clear();
  };

  // ---- adb + device discovery (adb track-devices equivalent: poll, back off while adb is unhappy)
  useEffect(() => {
    if (platform !== 'android') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const st = await api.invoke<AdbStatus>('android:adbStatus').catch(() => null);
      if (stopped) return;
      setAdb(st);
      if (!st?.found) return; // the install card takes over; installing bumps adbRev to resume
      try {
        const d = await api.invoke<Dev[]>('android:devices');
        if (stopped) return;
        setDevices(d);
        setErr(null);
        setSerial((cur) => (cur && d.some((x) => x.serial === cur) ? cur : (d[0]?.serial ?? '')));
        timer = setTimeout(poll, 3000);
      } catch (e) {
        if (stopped) return;
        setErr(errMsg(e));
        timer = setTimeout(poll, 10000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [platform, adbRev]);

  // ---- live mirror decode + take lifecycle events from main
  useEffect(() => {
    const offFrame = api.on('android:frame', (f: { config?: boolean; key?: boolean; pts?: number; data?: Uint8Array; ended?: boolean }) => {
      if (f.ended) {
        setMirror(null);
        return;
      }
      if (!f.data) return;
      if (f.config) {
        if (decoder.current && decoder.current.state !== 'closed') decoder.current.close();
        const sps = [...f.data].findIndex((_, i, a) => a[i] === 0 && a[i + 1] === 0 && a[i + 2] === 1 && ((a[i + 3] ?? 0) & 0x1f) === 7);
        const hex = (n: number) => n.toString(16).padStart(2, '0');
        const codec = sps >= 0 ? `avc1.${hex(f.data[sps + 4]!)}${hex(f.data[sps + 5]!)}${hex(f.data[sps + 6]!)}` : 'avc1.640028';
        const d = new VideoDecoder({
          output: (frame) => {
            const c = canvas.current;
            if (c) {
              if (c.width !== frame.displayWidth) { c.width = frame.displayWidth; c.height = frame.displayHeight; }
              c.getContext('2d')?.drawImage(frame, 0, 0);
            }
            frame.close();
          },
          error: (e) => console.warn('decoder', e),
        });
        d.configure({ codec, optimizeForLatency: true });
        decoder.current = d;
        (decoder.current as VideoDecoder & { pendingConfig?: Uint8Array }).pendingConfig = f.data;
        return;
      }
      const d = decoder.current as (VideoDecoder & { pendingConfig?: Uint8Array }) | null;
      if (!d || d.state !== 'configured') return;
      let data = f.data;
      if (d.pendingConfig) {
        if (!f.key) return;
        const merged = new Uint8Array(d.pendingConfig.length + data.length);
        merged.set(d.pendingConfig);
        merged.set(data, d.pendingConfig.length);
        data = merged;
        d.pendingConfig = undefined;
      }
      if (d.decodeQueueSize > 4 && !f.key) return; // stay real-time
      d.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.pts ?? 0, data }));
    });
    const offState = api.on('android:state', (st: AndroidRecState) => {
      if (st.state === 'finalizing') {
        stopTracks();
        setPhase('saving');
        if (st.reason === 'disconnected') toast('Device disconnected — saving the recording…', 'warning');
      } else if (st.state === 'saved') {
        setPhase('idle');
        toast('Recording saved — opening the editor', 'success');
      } else if (st.state === 'error') {
        setPhase('idle');
        toast(st.error ?? 'The recording could not be saved', 'error');
      }
    });
    return () => {
      offFrame();
      offState();
      if (decoder.current && decoder.current.state !== 'closed') decoder.current.close();
      stopTracks();
      void api.invoke('android:stop').catch(() => undefined); // leaving the tab finalises a running take
    };
  }, []);

  useEffect(() => {
    if (phase !== 'recording') return;
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed((Date.now() - t0) / 1000), 500);
    return () => clearInterval(t);
  }, [phase]);

  const installAdb = async () => {
    setAdbError(null);
    setInstalling(true);
    const off = api.on('android:adbProgress', (p: AdbProgress) => setAdbProgress(p));
    try {
      setAdb(await api.invoke<AdbStatus>('android:installAdb'));
      setAdbRev((n) => n + 1);
      toast('Android platform-tools installed', 'success');
    } catch (e) {
      setAdbError(errMsg(e));
    } finally {
      off();
      setInstalling(false);
      setAdbProgress(null);
    }
  };

  const connect = async () => {
    setBusy(true);
    try {
      setMirror(await api.invoke<AndroidMirrorInfo>('android:start', { serial }));
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** MediaRecorder → main, chunk by chunk (crash-safe, no whole-take blob in memory). */
  const startTrack = (kind: AndroidTrack, stream: MediaStream) => {
    try {
      const video = kind === 'camera';
      const mime = (video ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] : ['audio/webm;codecs=opus', 'audio/webm']).find((m) => MediaRecorder.isTypeSupported(m));
      // a face-cam needs far less than screen content: ~3.5 Mbps at 720p, ~6 Mbps at 1080p+ (as the Recorder route)
      const camH = stream.getVideoTracks()[0]?.getSettings().height ?? 720;
      const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), ...(video ? { videoBitsPerSecond: camH > 800 ? 6_000_000 : 3_500_000 } : { audioBitsPerSecond: 128_000 }) });
      // one ordered chain per track: chunks must reach the file in order, and "done" only after the last one
      let chain: Promise<unknown> = Promise.resolve();
      const send = (fn: () => Promise<unknown>) => { chain = chain.then(fn).catch((e) => console.warn(`android ${kind}`, e)); };
      mr.onstart = () => { const wall = now(); send(() => api.invoke('android:trackStart', kind, wall)); };
      mr.ondataavailable = (ev) => { if (ev.data.size) send(async () => api.invoke('android:trackChunk', kind, await ev.data.arrayBuffer())); };
      mr.onstop = () => {
        send(() => api.invoke('android:trackDone', kind));
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start(1000);
      tracks.current.set(kind, mr);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      toast(`${kind === 'camera' ? 'Camera' : 'Microphone'}: ${errMsg(e)}`, 'warning');
      void api.invoke('android:trackDone', kind); // main must not wait for a track that never started
    }
  };

  const record = async () => {
    if (!dev) return;
    setPhase('starting');
    // open the camera before the take starts: it can take a second, and the take's t=0 is the next key frame
    const cam = dev.cameraEnabled ? await openCamera(dev.cameraId).catch((e: unknown) => { toast(`Camera: ${errMsg(e)}`, 'warning'); return null; }) : null;
    try {
      const r = await api.invoke<AndroidRecordResult>('android:record', { mic: dev.micEnabled, systemAudio: dev.systemAudioEnabled && Boolean(mirror?.systemAudio), camera: Boolean(cam) });
      for (const w of r.warnings) toast(w, 'warning');
      if (phaseRef.current !== 'starting') { // finalised meanwhile (unplugged right at the start)
        cam?.getTracks().forEach((t) => t.stop());
        return;
      }
      if (cam) startTrack('camera', cam);
      if (r.rendererMic) {
        const mic = await openMic(dev.micId).catch((e: unknown) => { toast(`Microphone: ${errMsg(e)}`, 'warning'); return null; });
        if (mic && phaseRef.current === 'starting') startTrack('mic', mic);
        else {
          mic?.getTracks().forEach((t) => t.stop());
          void api.invoke('android:trackDone', 'mic');
        }
      }
      if (phaseRef.current === 'starting') setPhase('recording');
    } catch (e) {
      cam?.getTracks().forEach((t) => t.stop());
      toast(errMsg(e), 'error');
      setPhase('idle');
    }
  };

  const stop = async () => {
    setPhase('saving');
    stopTracks(); // main waits (briefly) for their last chunks
    await api.invoke<string | null>('android:recordStop').catch((e: unknown) => toast(errMsg(e), 'error'));
    if (phaseRef.current === 'saving') setPhase('idle'); // saved/error events normally got here first
  };

  const disconnect = async () => {
    stopTracks();
    setMirror(null);
    await api.invoke('android:stop').catch((e: unknown) => toast(errMsg(e), 'error'));
  };

  const pct = adbProgress?.total ? Math.round((adbProgress.received / adbProgress.total) * 100) : null;
  const installLabel = !adbProgress || adbProgress.phase === 'download' ? `Downloading… ${pct !== null ? `${pct}%` : `${(adbProgress?.received ?? 0) >> 20} MB`}` : adbProgress.phase === 'extract' ? 'Unpacking…' : 'Checking…';
  const idle = phase === 'idle';

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto px-3 pb-3">
      <Segmented value={platform} onChange={setPlatform} options={[{ value: 'android', label: 'Android' }, { value: 'ios', label: 'iPhone / iPad' }]} />
      {platform === 'ios' ? (
        <div className="rounded-xl border border-line bg-panel p-3 text-xs leading-relaxed text-muted">
          {isMac() ? (
            <>Connect your iPhone or iPad with a USB cable, unlock it and tap <b>Trust this computer</b>. It then appears as a camera source in the capture helper (screen + device audio).</>
          ) : (
            <>iPhone/iPad recording on Windows needs Apple’s USB drivers plus a screen-mirroring driver. This is planned for a later release — use a Mac for iOS recording today.</>
          )}
        </div>
      ) : adb && !adb.found ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 text-xs">
          <div className="text-[13px] font-medium text-text">Android platform-tools needed</div>
          <div className="leading-relaxed text-muted">The app talks to your phone through Google’s <b>adb</b> tool, which isn’t installed on this computer.</div>
          {adb.canDownload ? (
            <>
              <Button variant="primary" disabled={installing} onClick={installAdb}><Download size={14} />{installing ? installLabel : 'Download platform-tools (≈ 7 MB)'}</Button>
              {installing && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" role="progressbar" aria-label="platform-tools download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${adbProgress?.phase === 'download' ? (pct ?? 5) : 100}%` }} />
                </div>
              )}
              <div className="text-[11px] leading-relaxed text-muted">
                Downloaded from dl.google.com into the app’s data folder; Google’s{' '}
                <button className="underline hover:text-text" onClick={() => void api.invoke('app:openExternal', PLATFORM_TOOLS_INFO)}>platform-tools terms</button> apply.
                Already have adb? Add it to your PATH or set ANDROID_HOME, then refresh.
              </div>
            </>
          ) : (
            <div className="text-muted">Install Android platform-tools and make sure <b>adb</b> is on your PATH.</div>
          )}
          {adbError && <div className="flex gap-2 rounded-lg bg-danger/10 p-2 text-danger"><AlertTriangle size={14} className="shrink-0" />{adbError}</div>}
          <Button size="sm" variant="ghost" disabled={installing} onClick={() => setAdbRev((n) => n + 1)}><RefreshCw size={13} />Check again</Button>
        </div>
      ) : (
        <>
          {err && (
            <div className="flex gap-2 rounded-xl border border-warn/40 bg-warn/10 p-2.5 text-xs"><AlertTriangle size={15} className="shrink-0 text-warn" />{err}</div>
          )}
          <div className="flex items-end gap-2">
            <Select className="flex-1" label="Device" value={serial} onChange={setSerial} disabled={Boolean(mirror)} options={devices.length ? devices.map((d) => ({ value: d.serial, label: `${d.model || d.serial}${d.state !== 'device' ? ` (${d.state})` : ''}` })) : [{ value: '', label: 'No device detected' }]} />
            <Button onClick={() => setAdbRev((n) => n + 1)} aria-label="Refresh devices"><RefreshCw size={14} /></Button>
          </div>
          {!mirror ? (
            <>
              {phase === 'saving' && <div className="rounded-xl border border-line bg-panel p-2.5 text-xs text-muted">Saving the recording…</div>}
              <ol className="list-decimal space-y-1 rounded-xl border border-line bg-panel p-3 pl-7 text-xs text-muted">
                <li>Android 11 or newer, connected with a USB data cable.</li>
                <li>Settings → About phone → tap <b>Build number</b> 7× to enable Developer options.</li>
                <li>Developer options → turn on <b>USB debugging</b>.</li>
                <li>On the phone, tap <b>Allow</b> on the “Allow USB debugging?” prompt.</li>
                <li>Still stuck? Try another cable/port, set USB mode to “File transfer (MTP)”, install the OEM USB driver.</li>
              </ol>
              <Button variant="primary" disabled={!serial || busy || !idle || devices.find((d) => d.serial === serial)?.state !== 'device'} onClick={connect}><Smartphone size={14} />{busy ? 'Connecting…' : 'Start mirroring'}</Button>
            </>
          ) : (
            <>
              <div className="flex justify-center rounded-xl bg-black p-2"><canvas ref={canvas} className="max-h-72 max-w-full" /></div>
              <div className="text-xs text-muted">{mirror.name} · {mirror.width}×{mirror.height} · device audio {mirror.audio ? 'on' : 'unavailable (Android 11+ only)'}</div>
              {mirror.audio && <div className="text-[11px] text-warn">Note: on Android 11, locking the phone pauses device audio (the gap is kept silent and in sync).</div>}
              {dev && (
                <div className="rounded-xl border border-line bg-panel px-3 py-2">
                  <div className="mb-1 text-[11px] text-muted">Also record from this computer (devices as chosen for screen recording)</div>
                  <Toggle label="Microphone" checked={dev.micEnabled} onChange={(v) => void patch({ devices: { micEnabled: v } })} disabled={!idle} />
                  <Toggle label="System audio" hint={mirror.systemAudio ? undefined : 'Windows only'} checked={dev.systemAudioEnabled && mirror.systemAudio} onChange={(v) => void patch({ devices: { systemAudioEnabled: v } })} disabled={!idle || !mirror.systemAudio} />
                  <Toggle label="Camera" checked={dev.cameraEnabled} onChange={(v) => void patch({ devices: { cameraEnabled: v } })} disabled={!idle} />
                </div>
              )}
              <div className="flex gap-2">
                <Button variant={phase === 'recording' ? 'danger' : 'primary'} className="flex-1" disabled={!dev || phase === 'starting' || phase === 'saving'} onClick={phase === 'recording' ? stop : record}>
                  {phase === 'recording' ? <><Square size={13} />Stop & edit · {clock(elapsed)}</> : phase === 'saving' ? 'Saving…' : phase === 'starting' ? 'Starting…' : <><Circle size={13} className="fill-white" />Record</>}
                </Button>
                <Button disabled={!idle} onClick={disconnect}>Disconnect</Button>
              </div>
              <div className="text-[11px] text-muted">Device recordings have no cursor or keyboard data: auto zoom is off, manual zooms work.</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
