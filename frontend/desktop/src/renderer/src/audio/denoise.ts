/**
 * Noise reduction pre-pass (task 9.2): decode mic.wav → spectral gating → cache/mic.denoised.wav.
 * Runs once with progress in the Task Center; the result is cached and used by preview and export.
 */
import { api } from '../lib/api';
import { mediaUrl } from '../editor/media';
import { useEditor } from '../editor/store';
import { useTasks } from '../editor/tasks';
import { encodeWav, spectralDenoise } from './dsp';

export async function runDenoise(dir: string): Promise<void> {
  const st = useEditor.getState();
  const p = st.project!;
  const mic = p.source.tracks.mic;
  if (!mic) throw new Error('No microphone track');
  const existing = await api.invoke<Uint8Array | null>('projects:readCache', dir, 'mic.denoised.wav');
  if (existing) return;
  const id = `denoise-${Date.now()}`;
  const tasks = useTasks.getState();
  tasks.upsert({ id, title: 'Noise reduction', kind: 'denoise', progress: 0, status: 'running' });
  try {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buf = await fetch(mediaUrl(st.opened!.mediaBase, mic)).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
    const chans: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
      chans.push(await spectralDenoise(buf.getChannelData(c), { yieldEvery: 200, onProgress: (v) => tasks.upsert({ id, progress: (c + v) / Math.min(2, buf.numberOfChannels) }) }));
    }
    await api.invoke('projects:writeCache', dir, 'mic.denoised.wav', encodeWav(chans, buf.sampleRate));
    tasks.upsert({ id, progress: 1, status: 'done' });
  } catch (e) {
    tasks.upsert({ id, status: 'error', detail: (e as Error).message });
    throw e;
  }
}
