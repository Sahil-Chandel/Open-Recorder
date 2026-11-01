/**
 * Audio control (Phase 9, AUD-01…06): mic (mute, 0–300 %, noise reduction, vocal enhancement, balancing),
 * system & device audio, ducking, background music (library tabs, import, trim, volume, fades, loop, range).
 * Audit TLA: hold-to-compare original vs processed mic (B8), enhanced audio reused instead of a new paid
 * job + explicit Re-run (C20), loudness-measured balancing to −16 LUFS (B11), library preview (B5).
 */
import { Headphones, Music, Play, RotateCcw, Square, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatTime } from '@rec/shared';
import { api, errMsg } from '../../lib/api';
import { Button, cx, Section, Segmented, Slider, toast, Toggle, useConfirm } from '../../ui';
import { MUSIC_LIBRARY } from '../../audio/musicLibrary';
import { runDenoise } from '../../audio/denoise';
import { invalidateAnalysis, mediaFileSize, useAnalysisProgress, useTrackAnalysis } from '../../audio/analysisStore';
import { PreviewAudio } from '../../audio/engine';
import { renderLibraryTrackCached, stopLibraryPreview, toggleLibraryPreview, useLibraryPreview } from '../../audio/libraryPreview';
import { balanceFor, trackFile } from '../../audio/mixModel';
import { MusicTrimModal } from '../MusicTrimModal';
import { useEditor } from '../store';
import { useTasks } from '../tasks';
import { edit, useP } from './common';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ENHANCED = 'cache/mic.enhanced.wav';
/** a WAV header alone is 44 bytes → anything at most that size is an aborted download */
const hasAudioBytes = (size: number | null) => size !== null && size > 44;

export function AudioPanel() {
  const audio = useP((p) => p.audio);
  const tracks = useP((p) => p.source.tracks);
  const music = useP((p) => p.music);
  const micFile = useP((p) => trackFile(p, 'mic', p.audio.mic.denoise));
  const dir = useEditor((s) => s.dir);
  const opened = useEditor((s) => s.opened);
  const duration = useEditor((s) => s.derived?.duration ?? 0);
  const confirm = useConfirm();
  const [tab, setTab] = useState<'Focus' | 'Business' | 'Tech' | 'Chill'>('Focus');
  const [trim, setTrim] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [enhancedReady, setEnhancedReady] = useState(false);
  const preview = useLibraryPreview();

  useEffect(() => () => stopLibraryPreview(), []);
  useEffect(() => {
    if (!opened || !tracks.mic) return;
    let live = true;
    void mediaFileSize(opened.mediaBase, ENHANCED).then((s) => live && setEnhancedReady(hasAudioBytes(s)));
    return () => { live = false; };
  }, [opened, tracks.mic, audio.mic.enhance]);

  const addMusic = (file: string, name: string, len: number) =>
    edit(music ? 'Replace music' : 'Add music', (p) => {
      p.music = { file, name, trimStart: 0, trimEnd: len, volume: 0.35, fadeIn: 1, fadeOut: 2, loop: true, rangeStart: 0, rangeEnd: duration };
    });

  /** Local ffmpeg chain; on a re-run the file keeps its name, so caches and the preview element are refreshed. */
  const runEnhance = async (rerun: boolean) => {
    if (!tracks.mic) return;
    setBusy('enhance');
    const taskId = `enhance-${Date.now()}`;
    const tasks = useTasks.getState();
    tasks.upsert({ id: taskId, title: 'Vocal enhancement', kind: 'other', progress: 0, status: 'running' });
    const off = api.on('audio:progress', (e: { progress: number }) => tasks.upsert({ id: taskId, progress: e.progress }));
    try {
      await api.invoke('audio:enhanceVoice', dir, tracks.mic);
      edit('Vocal enhancement', (p) => { p.audio.mic.enhance = true; });
      tasks.upsert({ id: taskId, status: 'done', progress: 1 });
      if (rerun && opened) {
        await invalidateAnalysis({ mediaBase: opened.mediaBase, file: ENHANCED, dir });
        PreviewAudio.reloadFile(ENHANCED);
      }
      setEnhancedReady(true);
      toast(rerun ? 'Vocal enhancement re-run' : 'Vocal enhancement applied', 'success');
    } catch (e) {
      tasks.upsert({ id: taskId, status: 'error', detail: errMsg(e) });
      toast(errMsg(e), 'error');
    } finally {
      off();
      setBusy(null);
    }
  };

  const onEnhance = async (v: boolean) => {
    if (!v) return edit('Vocal enhancement off', (p) => { p.audio.mic.enhance = false; });
    if (!opened) return;
    // an earlier result is reused instantly; only an explicit Re-run processes the audio again
    if (hasAudioBytes(await mediaFileSize(opened.mediaBase, ENHANCED))) {
      edit('Vocal enhancement', (p) => { p.audio.mic.enhance = true; });
      setEnhancedReady(true);
      toast('Using your existing enhanced audio', 'success');
      return;
    }
    await runEnhance(false);
  };

  return (
    <>
      {tracks.mic && (
        <Section title="Microphone">
          <Toggle label="Mute" checked={audio.mic.mute} onChange={(v) => edit('Mute mic', (p) => { p.audio.mic.mute = v; })} />
          <Slider label="Volume" value={audio.mic.volume} min={0} max={3} onChange={(v) => edit('Mic volume', (p) => { p.audio.mic.volume = v; }, 'micvol')} format={pct} disabled={audio.mic.mute} />
          <Toggle label="Noise reduction" hint="Removes fan hum, hiss and keyboard noise (free, on-device)" checked={audio.mic.denoise} onChange={async (v) => {
            if (v) {
              setBusy('denoise');
              try { await runDenoise(dir); edit('Noise reduction', (p) => { p.audio.mic.denoise = true; }); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
            } else edit('Noise reduction off', (p) => { p.audio.mic.denoise = false; });
          }} disabled={busy === 'denoise'} />
          <Toggle label="Vocal enhancement" hint={enhancedReady ? 'Studio voice · enhanced audio is ready' : 'Studio voice: de-noise, de-ess, EQ, compression and level — runs on this computer'} checked={audio.mic.enhance}
            onChange={(v) => void onEnhance(v)} disabled={busy === 'enhance'} />
          {busy === 'enhance' && <div className="text-[11px] text-muted">Enhancing on this computer — progress in the task list…</div>}
          {enhancedReady && busy !== 'enhance' && (
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
              <span>Enhanced audio saved in this project</span>
              <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent-2 hover:bg-panel-2" onClick={async () => {
                if (await confirm('Re-run vocal enhancement? The current enhanced audio will be replaced.', { ok: 'Re-run' })) void runEnhance(true);
              }}><RotateCcw size={11} />Re-run…</button>
            </div>
          )}
          {(audio.mic.denoise || audio.mic.enhance) && <CompareButton processed={audio.mic.enhance ? 'enhanced' : 'denoised'} />}
          <Toggle label="Smart volume balancing" hint="Measures your voice and levels it to −16 LUFS" checked={audio.mic.balance} onChange={(v) => edit('Volume balancing', (p) => { p.audio.mic.balance = v; })} />
          {audio.mic.balance && <BalanceSummary file={micFile} />}
        </Section>
      )}
      {tracks.system && (
        <Section title="System audio">
          <Toggle label="Mute" checked={audio.system.mute} onChange={(v) => edit('Mute system audio', (p) => { p.audio.system.mute = v; })} />
          <Slider label="Volume" value={audio.system.volume} min={0} max={3} onChange={(v) => edit('System volume', (p) => { p.audio.system.volume = v; }, 'sysvol')} format={pct} disabled={audio.system.mute} />
        </Section>
      )}
      {tracks.device && (
        <Section title="Device audio">
          <Toggle label="Mute" checked={audio.device.mute} onChange={(v) => edit('Mute device audio', (p) => { p.audio.device.mute = v; })} />
          <Slider label="Volume" value={audio.device.volume} min={0} max={3} onChange={(v) => edit('Device volume', (p) => { p.audio.device.volume = v; }, 'devvol')} format={pct} />
        </Section>
      )}
      {!tracks.mic && !tracks.system && !tracks.device && <Section title="Audio"><div className="text-xs text-muted">This recording has no audio tracks.</div></Section>}
      <Section title="Background music">
        {music ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-lg bg-panel-2 p-2 text-xs"><Music size={14} className="text-accent-2" /><span className="flex-1 truncate">{music.name || 'Music'}</span>
              <button className="text-danger" onClick={() => edit('Remove music', (p) => { delete p.music; })}>Delete</button></div>
            <Slider label="Volume" value={music.volume} min={0} max={1} onChange={(v) => edit('Music volume', (p) => { p.music!.volume = v; }, 'musvol')} format={pct} />
            <Slider label="Fade in" value={music.fadeIn} min={0} max={10} step={0.1} onChange={(v) => edit('Music fade in', (p) => { p.music!.fadeIn = v; }, 'musfi')} format={(v) => `${v.toFixed(1)} s`} />
            <Slider label="Fade out" value={music.fadeOut} min={0} max={10} step={0.1} onChange={(v) => edit('Music fade out', (p) => { p.music!.fadeOut = v; }, 'musfo')} format={(v) => `${v.toFixed(1)} s`} />
            <Toggle label="Loop" checked={music.loop} onChange={(v) => edit('Music loop', (p) => { p.music!.loop = v; })} />
            <Toggle label="Lower music under voice" hint={tracks.mic ? 'Auto-ducking from speech detected on the mic track' : 'Needs a microphone track'} checked={audio.ducking && !!tracks.mic} disabled={!tracks.mic}
              onChange={(v) => edit('Ducking', (p) => { p.audio.ducking = v; })} />
            <div className="text-[11px] text-muted">Plays {formatTime(music.rangeStart)} → {formatTime(Math.min(music.rangeEnd, duration))} (drag on the Music track to change)</div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setTrim(true)}>Trim…</Button>
              <Button size="sm" onClick={() => edit('Music full length', (p) => { p.music!.rangeStart = 0; p.music!.rangeEnd = duration; })}>Whole video</Button>
            </div>
          </div>
        ) : null}
        <Segmented size="sm" value={tab} onChange={setTab} options={(['Focus', 'Business', 'Tech', 'Chill'] as const).map((v) => ({ value: v, label: v }))} />
        <div className="flex flex-col gap-1">
          {MUSIC_LIBRARY.filter((t) => t.category === tab).map((t) => {
            const playing = preview.playing === t.id;
            const loading = preview.loading === t.id;
            return (
              <div key={t.id} className={cx('flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-panel-2', playing && 'bg-accent/10')}>
                <button aria-label={playing || loading ? `Stop preview of ${t.name}` : `Preview ${t.name}`} aria-pressed={playing}
                  className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition', playing ? 'bg-accent text-white' : 'bg-panel-2 text-muted hover:text-text', loading && 'animate-pulse')}
                  onClick={() => void toggleLibraryPreview(t.id).catch((e) => toast(`Preview failed: ${errMsg(e)}`, 'error'))}>
                  {playing || loading ? <Square size={10} fill="currentColor" /> : <Play size={11} className="ml-px" fill="currentColor" />}
                </button>
                <span className="flex-1 text-xs">{t.name}<span className="ml-1 text-muted">· {t.bpm} bpm</span></span>
                <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={async () => {
                  setBusy(t.id);
                  try {
                    const { bytes, seconds } = await renderLibraryTrackCached(t.id);
                    await api.invoke('projects:writeCache', dir, `music-${t.id}.wav`, bytes);
                    addMusic(`cache/music-${t.id}.wav`, t.name, seconds);
                  } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
                }}>{busy === t.id ? '…' : 'Add'}</Button>
              </div>
            );
          })}
        </div>
        <Button size="sm" onClick={async () => {
          try {
            const r = await api.invoke<{ file: string; url: string; name: string } | null>('projects:importAsset', dir, 'music');
            if (!r) return;
            const len = await new Promise<number>((res) => { const a = new Audio(r.url); a.onloadedmetadata = () => res(a.duration || 60); a.onerror = () => res(60); });
            addMusic(r.file, r.name, len);
          } catch (e) { toast(errMsg(e), 'error'); }
        }}><Upload size={13} />Import MP3 / M4A / AAC / WAV</Button>
      </Section>
      {trim && music && <MusicTrimModal onClose={() => setTrim(false)} />}
    </>
  );
}

/**
 * Hold-to-compare (B8): while pressed, the preview plays the unprocessed mic instead of the denoised /
 * enhanced one (both stay in sync, so the switch is instant). Starts playback if paused and stops it again.
 */
function CompareButton({ processed }: { processed: 'denoised' | 'enhanced' }) {
  const [holding, setHolding] = useState(false);
  const startedPlayback = useRef(false);
  const begin = () => {
    const pa = PreviewAudio.active;
    if (!pa?.canCompare) {
      toast('The preview is still loading the original audio — try again in a moment');
      return;
    }
    pa.setCompare(true);
    setHolding(true);
    const st = useEditor.getState();
    if (!st.playing) {
      startedPlayback.current = true;
      st.setPlaying(true);
    }
  };
  const end = () => {
    PreviewAudio.active?.setCompare(false);
    setHolding(false);
    if (startedPlayback.current) {
      startedPlayback.current = false;
      useEditor.getState().setPlaying(false);
    }
  };
  useEffect(() => () => PreviewAudio.active?.setCompare(false), []);
  return (
    <button type="button" aria-pressed={holding} title={`Hold to hear the original microphone, release for the ${processed} version`}
      onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); begin(); }}
      onPointerUp={() => holding && end()} onPointerCancel={() => holding && end()}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); if (!holding) begin(); } }}
      onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (holding) end(); } }}
      onBlur={() => holding && end()}
      className={cx('no-drag flex h-7 select-none items-center justify-center gap-1.5 rounded-[var(--radius-ui)] border text-xs transition', holding ? 'border-accent bg-accent/20 text-accent-2' : 'border-line bg-panel-2 text-muted hover:text-text')}>
      <Headphones size={13} />{holding ? `Original — release for ${processed}` : 'Hold to compare with original'}
    </button>
  );
}

/** Measured loudness + applied gain; the identical curve drives preview and export. */
function BalanceSummary({ file }: { file: string | undefined }) {
  const a = useTrackAnalysis(file);
  const progress = useAnalysisProgress(file);
  if (!a) return <div className="text-[11px] text-muted">Measuring loudness…{progress !== null ? ` ${Math.round(progress * 100)}%` : ''}</div>;
  const b = balanceFor(a);
  if (b.measuredLufs <= -69.5) return <div className="text-[11px] text-muted">No voice found on the microphone track.</div>;
  return (
    <div className="text-[11px] text-muted">
      Voice measured {b.measuredLufs.toFixed(1)} LUFS → {b.normDb >= 0 ? '+' : ''}{b.normDb.toFixed(1)} dB, levelled to {b.targetLufs} LUFS (preview = export)
    </div>
  );
}
