/**
 * Music library preview (audit B5): play / stop a procedural library track before adding it. One shared
 * <audio> element → starting a preview stops any other one; the editor transport pauses while a preview
 * plays and starting editor playback stops the preview. Renders are memoised per track (bytes + blob URL)
 * so "Add" after a preview reuses the same render.
 */
import { create } from 'zustand';
import { consoleSink, createLogger } from '@rec/shared';
import { useEditor } from '../editor/store';
import { renderLibraryTrack } from './musicLibrary';

const log = createLogger('renderer.audio.library', consoleSink);

interface PreviewState {
  playing: string | null;
  loading: string | null;
}
export const useLibraryPreview = create<PreviewState>(() => ({ playing: null, loading: null }));

interface RenderedTrack {
  bytes: Uint8Array;
  seconds: number;
  url: string;
}
const renders = new Map<string, Promise<RenderedTrack>>();

/** Render (once per session) a library track to WAV bytes + a playable blob URL. */
export function renderLibraryTrackCached(id: string): Promise<RenderedTrack> {
  let r = renders.get(id);
  if (!r) {
    r = renderLibraryTrack(id).then(({ bytes, seconds }) => ({ bytes, seconds, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' })) }));
    r.catch(() => renders.delete(id));
    renders.set(id, r);
  }
  return r;
}

let el: HTMLAudioElement | null = null;
let request = 0;
let unsubscribe: (() => void) | null = null;

export function stopLibraryPreview(): void {
  request++;
  if (el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
    el = null;
  }
  useLibraryPreview.setState({ playing: null, loading: null });
}

export async function playLibraryPreview(id: string): Promise<void> {
  stopLibraryPreview();
  const my = ++request;
  useLibraryPreview.setState({ loading: id });
  // previews and the editor transport never play over each other
  if (useEditor.getState().playing) useEditor.getState().setPlaying(false);
  unsubscribe ??= useEditor.subscribe((s, prev) => {
    if (s.playing && !prev.playing && useLibraryPreview.getState().playing) stopLibraryPreview();
  });
  try {
    const t = await renderLibraryTrackCached(id);
    if (my !== request) return;
    const a = new Audio(t.url);
    a.loop = true;
    a.volume = 0.8;
    el = a;
    await a.play();
    if (my !== request) return;
    useLibraryPreview.setState({ playing: id, loading: null });
  } catch (e) {
    if (my === request) {
      stopLibraryPreview();
      log.warn('library.preview_failed', { id, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
}

export function toggleLibraryPreview(id: string): Promise<void> {
  const s = useLibraryPreview.getState();
  if (s.playing === id || s.loading === id) {
    stopLibraryPreview();
    return Promise.resolve();
  }
  return playLibraryPreview(id);
}
