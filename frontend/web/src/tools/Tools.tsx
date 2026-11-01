/**
 * Free online recorders (Phase 15, WEB-01…03): screen + camera / screen only / camera only / mic only; screen, window
 * or tab (+ tab audio) and microphone. Flow: choose the source → live preview with a draggable / resizable area frame
 * (quick presets) → record → mini editor (zooms, MP4 with audio) or save the original. Local processing only (no
 * upload, no account, no watermark). Missing or silent devices are always shown — never a "LIVE" over silence.
 */
import { Circle, Square, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppLink, SiteFooter } from '../components/SiteChrome';
import { PRODUCT } from '../config';
import { navigate } from '../main';
import { CropOverlay } from './CropOverlay';
import { CROP_PRESETS, FULL_FRAME, cropOutputSize, isFullFrame, sameRect, type Rect, type Size } from './geometry';
import { CaptureError, acquireSources, createCompositor, pickMime, trackSize, videoBitrate, type Compositor, type Sources } from './media';
import MiniEditor from './MiniEditor';
import { LevelMeter, StreamVideo } from './widgets';

type Mode = 'screen' | 'camera' | 'mic';
type Sub = 'screen+camera' | 'screen' | 'camera' | 'mic';
type Phase = 'idle' | 'acquiring' | 'ready' | 'recording' | 'stopping';

interface Meter { id: string; label: string; analyser: AnalyserNode; track: MediaStreamTrack; voice: boolean }
interface Session {
  sources: Sources;
  ac: AudioContext;
  /** Mixed audio (mic + tab/system); null when there is no audio source at all. */
  audio: MediaStreamTrack | null;
  compositor: Compositor | null;
  recorder: MediaRecorder | null;
  startedAt: number;
}
interface Recording { id: number; blob: Blob; duration: number; audioOnly: boolean }

const SUBS: readonly Sub[] = ['screen+camera', 'screen', 'camera', 'mic'];
const SUB_LABEL: Record<Sub, string> = { 'screen+camera': 'Screen + camera', screen: 'Screen only', camera: 'Camera only', mic: 'Microphone only' };
const TITLES: Record<Mode, string> = { screen: 'Free online screen recorder', camera: 'Online camera recorder', mic: 'Online microphone recorder' };

const support = {
  secure: typeof window === 'undefined' || window.isSecureContext,
  display: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia,
  recorder: typeof MediaRecorder !== 'undefined',
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function Tools({ mode }: { mode: Mode }) {
  const [sub, setSub] = useState<Sub>(mode === 'screen' ? 'screen+camera' : mode);
  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [crop, setCrop] = useState<Rect>(FULL_FRAME);
  const [src, setSrc] = useState<Size | null>(null);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [bubble, setBubble] = useState<MediaStream | null>(null);
  const [meters, setMeters] = useState<Meter[]>([]);
  const [summary, setSummary] = useState('');
  const [audioNote, setAudioNote] = useState<string | null>(null);
  const [backgroundNote, setBackgroundNote] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Recording | null>(null);

  const session = useRef<Session | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const mounted = useRef(true);
  const cropRef = useRef(crop);
  const srcRef = useRef(src);
  useEffect(() => { cropRef.current = crop; }, [crop]);
  useEffect(() => { srcRef.current = src; }, [src]);

  const wantScreen = sub === 'screen' || sub === 'screen+camera';
  const wantCam = sub === 'camera' || sub === 'screen+camera';
  const go = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);
  const addWarning = useCallback((w: string) => setWarnings((all) => (all.includes(w) ? all : [...all, w])), []);

  const teardown = useCallback(() => {
    const s = session.current;
    session.current = null;
    if (!s) return;
    s.compositor?.stop();
    s.sources.stop();
    void s.ac.close().catch(() => undefined);
    setPreview(null);
    setBubble(null);
    setMeters([]);
    setBackgroundNote(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const r = session.current?.recorder;
      if (r && r.state !== 'inactive') { r.onstop = null; r.ondataavailable = null; r.stop(); }
      teardown();
    };
  }, [teardown]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const id = window.setInterval(() => { const s = session.current; if (s?.startedAt) setElapsed((performance.now() - s.startedAt) / 1000); }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  const stop = useCallback(() => {
    const r = session.current?.recorder;
    if (r && r.state !== 'inactive') { go('stopping'); r.stop(); }
  }, [go]);

  const cancel = () => { teardown(); go('idle'); };

  /** A source went away: finish an ongoing recording, or reset the preview. */
  const sourceEnded = (why: string) => {
    if (phaseRef.current === 'recording') { addWarning(why); stop(); }
    else if (phaseRef.current === 'ready') { teardown(); go('idle'); setInfo(`${why} Choose a source to start again.`); }
  };

  const begin = () => {
    const s = session.current;
    if (!s || s.recorder) return;
    setErr(null);
    void s.ac.resume().catch(() => undefined);
    const screen = s.sources.display?.getVideoTracks()[0] ?? null;
    const primary = screen ?? s.sources.camera;
    try {
      let video: MediaStreamTrack | null = null;
      if (primary && primary.readyState === 'live') {
        const overlay = screen && s.sources.camera?.readyState === 'live' ? s.sources.camera : null;
        const area = cropRef.current;
        if (overlay || !isFullFrame(area)) {
          s.compositor = createCompositor(primary, overlay, area, srcRef.current ?? trackSize(primary));
          video = s.compositor.track;
          setBackgroundNote(s.compositor.kind === 'canvas');
        } else video = primary;
      }
      if (!video && !s.audio) throw new Error('there is no video or audio source left to record');
      const stream = new MediaStream([...(video ? [video] : []), ...(s.audio ? [s.audio] : [])]);
      const mimeType = pickMime(Boolean(video), Boolean(s.audio));
      const size = video ? (s.compositor?.size ?? srcRef.current ?? trackSize(video)) : null;
      const rec = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        ...(size ? { videoBitsPerSecond: videoBitrate(size) } : {}),
        ...(s.audio ? { audioBitsPerSecond: 128_000 } : {}),
      });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstart = () => { s.startedAt = performance.now(); setElapsed(0); };
      rec.onerror = (e) => {
        const why = (e as Event & { error?: { message?: string } }).error?.message;
        setErr(`Recording failed: ${why || 'the browser stopped the recorder'}.`);
      };
      rec.onstop = () => {
        const duration = s.startedAt ? (performance.now() - s.startedAt) / 1000 : 0;
        const blob = new Blob(chunks, { type: rec.mimeType || mimeType || (video ? 'video/webm' : 'audio/webm') });
        teardown();
        go('idle');
        if (blob.size > 0) setResult({ id: Date.now(), blob, duration, audioOnly: !video });
        else setErr('The browser produced an empty recording. Please try again.');
      };
      rec.start(1000);
      s.recorder = rec;
      setResult(null);
      go('recording');
    } catch (e) {
      s.compositor?.stop();
      s.compositor = null;
      setBackgroundNote(false);
      setErr(`Couldn’t start recording: ${(e as Error).message}`);
      if (!primary) { teardown(); go('idle'); }
    }
  };

  const prepare = async () => {
    if (phaseRef.current !== 'idle') return;
    setErr(null);
    setInfo(null);
    setWarnings([]);
    setAudioNote(null);
    let ac: AudioContext;
    try {
      ac = new AudioContext(); // created inside the click (before any await) so it starts running
    } catch {
      setErr('Audio recording isn’t supported in this browser.');
      return;
    }
    go('acquiring');
    let sources: Sources;
    try {
      sources = await acquireSources({ screen: wantScreen, camera: wantCam, mic: true }, { camera: sub === 'camera', mic: sub === 'mic' });
    } catch (e) {
      void ac.close().catch(() => undefined);
      if (!mounted.current) return;
      go('idle');
      if (e instanceof CaptureError && e.cancelled) setInfo(e.message);
      else setErr((e as Error).message);
      return;
    }
    if (!mounted.current) { sources.stop(); void ac.close().catch(() => undefined); return; }

    // One mixed audio track for the recording; analysers drive the level meters.
    const dest = ac.createMediaStreamDestination();
    const meterList: Meter[] = [];
    const addAudio = (track: MediaStreamTrack, id: string, label: string, voice: boolean) => {
      const node = ac.createMediaStreamSource(new MediaStream([track]));
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      node.connect(dest);
      node.connect(analyser);
      meterList.push({ id, label, analyser, track, voice });
    };
    if (sources.mic) addAudio(sources.mic, 'mic', 'Microphone', true);
    const system = sources.display?.getAudioTracks()[0];
    if (system) addAudio(system, 'system', 'Tab / system audio', false);
    session.current = { sources, ac, audio: meterList.length ? dest.stream.getAudioTracks()[0] ?? null : null, compositor: null, recorder: null, startedAt: 0 };

    const screen = sources.display?.getVideoTracks()[0] ?? null;
    const parts = [screen && 'screen', sources.camera && 'camera', sources.mic && 'microphone', system && 'tab/system audio'].filter(Boolean);
    setSummary(parts.length ? `Recording ${parts.join(' + ')}` : '');
    setWarnings(sources.warnings);
    setAudioNote(screen && !system ? 'No tab or system audio is shared. To include it, share a tab or your entire screen with “Share audio” turned on.' : null);
    setMeters(meterList);

    screen?.addEventListener('ended', () => sourceEnded('Screen sharing ended.')); // "Stop sharing" in the browser bar
    sources.camera?.addEventListener('ended', () => {
      if (sub === 'camera') { sourceEnded('The camera was disconnected.'); return; }
      setBubble(null);
      addWarning('The camera was disconnected — the rest of the recording has no camera bubble.');
    });
    sources.mic?.addEventListener('ended', () => addWarning('The microphone was disconnected — the rest of the recording has no voice.'));

    if (sub === 'mic') { begin(); return; } // nothing to frame: record right away
    const primary = screen ?? sources.camera;
    if (!primary) { teardown(); go('idle'); setErr('There is no video source to record.'); return; }
    setSrc(trackSize(primary));
    setPreview(new MediaStream([primary]));
    setBubble(screen && sources.camera ? new MediaStream([sources.camera]) : null);
    go('ready');
  };

  const live = phase === 'ready' || phase === 'recording' || phase === 'stopping';
  const outSize = src ? cropOutputSize(crop, src) : null;
  const startLabel = sub === 'mic' ? 'Start recording' : wantScreen ? 'Choose what to share' : 'Turn on camera';
  const btn = 'flex items-center gap-2 rounded-full px-6 py-2.5 font-semibold text-white disabled:opacity-40';

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <button onClick={() => navigate('/')} className="text-sm text-muted">← {PRODUCT}</button>
      <h1 className="mt-3 text-3xl font-bold">{TITLES[mode]}</h1>
      <p className="mt-1 text-sm text-muted">Runs entirely in your browser — nothing is uploaded. No account, no watermark.</p>
      {!support.secure && <div className="mt-4 rounded-lg bg-danger/10 p-3 text-sm">Recording needs a secure (https) page. Open this recorder over https.</div>}
      {mode === 'screen' && !support.display && <div className="mt-4 rounded-lg bg-danger/10 p-3 text-sm">This browser cannot record the screen. Try Chrome, Edge, Firefox, Safari or Opera on a computer.</div>}
      {!support.recorder && <div className="mt-4 rounded-lg bg-danger/10 p-3 text-sm">Recording is not supported in this browser.</div>}

      {mode === 'screen' && (
        <div role="radiogroup" aria-label="What to record" className="mt-6 flex flex-wrap gap-2">
          {SUBS.map((s) => (
            <button key={s} role="radio" aria-checked={sub === s} disabled={phase !== 'idle'} onClick={() => setSub(s)}
              className={`rounded-lg border px-3 py-1.5 text-sm disabled:opacity-60 ${sub === s ? 'border-accent bg-accent/15' : 'border-line'}`}>{SUB_LABEL[s]}</button>
          ))}
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-black">
        {sub === 'mic' ? (
          <div className="flex aspect-[4/1] items-center justify-center text-muted">{phase === 'recording' ? 'Recording audio…' : 'Microphone recording'}</div>
        ) : (
          <div className="relative aspect-video w-full">
            {preview ? (
              <>
                <StreamVideo stream={preview} onSize={setSrc} className="absolute inset-0 h-full w-full object-contain" />
                {src && <CropOverlay src={src} rect={crop} onChange={setCrop} locked={phase !== 'ready'} recording={phase === 'recording'} bubble={bubble} />}
              </>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">
                {phase === 'acquiring' ? 'Waiting for your browser…'
                  : wantScreen ? 'Choose a screen, window or tab to see a live preview — then drag the frame to pick the area you want to record.'
                  : 'Turn on your camera to see a live preview and choose the area to record.'}
              </div>
            )}
          </div>
        )}
      </div>

      {sub !== 'mic' && live && src && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Area:</span>
          {CROP_PRESETS.map((p) => {
            const on = sameRect(crop, p.rect);
            return (
              <button key={p.id} disabled={phase !== 'ready'} onClick={() => setCrop(p.rect)} aria-pressed={on}
                className={`rounded border px-2 py-0.5 disabled:opacity-50 ${on ? 'border-accent bg-accent/15' : 'border-line'}`}>{p.label}</button>
            );
          })}
          {outSize && <span className="ml-auto text-muted">{outSize.w} × {outSize.h} px</span>}
          {phase === 'ready' && <span className="basis-full text-muted">Drag the frame or its handles to choose the area, or drag across the preview to draw a new one.</span>}
        </div>
      )}

      {live && meters.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {meters.map((m) => <LevelMeter key={m.id} label={m.label} analyser={m.analyser} track={m.track} warnOnSilence={m.voice} />)}
        </div>
      )}
      {live && audioNote && <div className="mt-2 text-xs text-muted">{audioNote}</div>}
      {warnings.length > 0 && (live || phase === 'idle') && (
        <ul className="mt-3 space-y-2">
          {warnings.map((w) => (
            <li key={w} role="alert" className="flex gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" />{w}
            </li>
          ))}
        </ul>
      )}
      {backgroundNote && phase === 'recording' && (
        <div className="mt-3 text-xs text-muted">Tip: this browser may slow cropped or camera recordings down while this tab is in the background — switch to other windows rather than other tabs, or use Chrome or Edge.</div>
      )}
      {err && <div role="alert" className="mt-3 text-sm text-danger">{err}</div>}
      {info && <div role="status" className="mt-3 text-sm text-muted">{info}</div>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {phase === 'idle' && (
          <button onClick={() => void prepare()} disabled={!support.recorder} className={`${btn} bg-accent`}><Circle size={14} className="fill-white" />{startLabel}</button>
        )}
        {phase === 'acquiring' && <span className="text-sm text-muted">Waiting for permission…</span>}
        {phase === 'ready' && (
          <>
            <button onClick={begin} className={`${btn} bg-accent`}><Circle size={14} className="fill-white" />Start recording</button>
            <button onClick={cancel} className="text-sm text-muted hover:text-text">Cancel</button>
          </>
        )}
        {(phase === 'recording' || phase === 'stopping') && (
          <>
            <span className="flex items-center gap-2 text-sm" aria-live="polite"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />LIVE {clock(elapsed)}</span>
            <button onClick={stop} disabled={phase === 'stopping'} className={`${btn} bg-danger`}><Square size={14} />{phase === 'stopping' ? 'Finishing…' : 'Stop'}</button>
          </>
        )}
        {live && summary && <span className="text-xs text-muted">{summary}</span>}
      </div>

      {result && <MiniEditor key={result.id} blob={result.blob} durationHint={result.duration} audioOnly={result.audioOnly} />}
      <div className="mt-10 rounded-2xl border border-accent/40 bg-accent/10 p-5 text-sm">
        Want automatic zoom on every click, a smooth cursor, local captions and 4K export? <AppLink to="/#download" className="font-semibold text-accent-2 underline decoration-accent-2/40 underline-offset-2 hover:decoration-accent-2">Get the free desktop app</AppLink> — open source, no account.
      </div>
      <SiteFooter />
    </div>
  );
}
