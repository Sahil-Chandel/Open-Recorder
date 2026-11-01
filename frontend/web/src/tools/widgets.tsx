/** Small recorder widgets: a <video> bound to a MediaStream and an input level meter that flags dead inputs. */
import { useEffect, useRef, useState } from 'react';
import type { Size } from './geometry';

/** <video> showing a live MediaStream (srcObject can't be set through JSX); reports the intrinsic size. */
export function StreamVideo({ stream, className, onSize }: { stream: MediaStream | null; className?: string; onSize?: (s: Size) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
    return () => { v.srcObject = null; };
  }, [stream]);
  const report = () => {
    const v = ref.current;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) onSize?.({ w: v.videoWidth, h: v.videoHeight });
  };
  return <video ref={ref} muted playsInline autoPlay className={className} onLoadedMetadata={report} onResize={report} />;
}

type MeterState = 'ok' | 'silent' | 'muted' | 'ended';
/** Digital silence (≈ −100 dBFS): a muted or dead input — a quiet room with noise suppression still sits well above it. */
const SILENCE_RMS = 1e-5;
const SILENCE_MS = 3000;
const NOTES: Record<MeterState, string | null> = {
  ok: null,
  silent: 'No signal — is the microphone muted (hardware switch or system settings)?',
  muted: 'Muted by the system',
  ended: 'Disconnected',
};

/**
 * Live level of one audio source. Animates the bar through a ref (no React re-render per frame) and only re-renders
 * when the state changes, so a silent or muted microphone is visible instead of a reassuring "LIVE" over silence.
 */
export function LevelMeter({ label, analyser, track, warnOnSilence }: { label: string; analyser: AnalyserNode; track: MediaStreamTrack; warnOnSilence: boolean }) {
  const bar = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<MeterState>('ok');
  useEffect(() => {
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    let shown = 0;
    let soundAt = performance.now();
    let last: MeterState = 'ok';
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const level = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-9) + 60) / 60)); // −60…0 dBFS → 0…1
      shown = Math.max(level, shown - 0.03); // fast attack, slow release
      if (bar.current) bar.current.style.width = `${(shown * 100).toFixed(1)}%`;
      const now = performance.now();
      if (rms > SILENCE_RMS) soundAt = now;
      const next: MeterState = track.readyState === 'ended' ? 'ended' : track.muted ? 'muted' : warnOnSilence && now - soundAt > SILENCE_MS ? 'silent' : 'ok';
      if (next !== last) { last = next; setState(next); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [analyser, track, warnOnSilence]);

  const note = NOTES[state];
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <div aria-hidden className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
        <div ref={bar} className={`h-full w-0 rounded-full ${state === 'ok' ? 'bg-accent-2' : 'bg-warn'}`} />
      </div>
      {note && <span role="status" className="text-warn">{note}</span>}
    </div>
  );
}
