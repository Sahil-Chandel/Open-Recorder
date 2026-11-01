/**
 * Streaming PCM access to recorded / imported audio (audit B1, C22) without decoding whole files:
 * mediabunny demuxes + decodes on demand (WAV PCM in JS, AAC / Opus / MP3 via WebCodecs), so an hour-long
 * mic track is read in bounded memory — sequentially for analysis, or by frame range for the chunked
 * export. Falls back to a one-shot WebAudio decode when mediabunny cannot handle a file.
 * Frame positions are integers at the file's own sample rate → reads are deterministic and overlap exactly.
 */
import { ALL_FORMATS, AudioSampleSink, Input, UrlSource, type Source } from 'mediabunny';
import { consoleSink, createLogger } from '@rec/shared';

const log = createLogger('renderer.audio.reader', consoleSink);

export interface PcmReader {
  readonly sampleRate: number;
  readonly channels: number;
  /** total frames (from the container duration; streaming may deliver slightly more/less) */
  readonly frames: number;
  /** planar float PCM for file frames [start, start + count); zero-filled where the file has no data */
  readFrames(start: number, count: number): Promise<Float32Array[]>;
  /** one sequential pass; `planes` is scratch memory reused between calls (copy what you keep) */
  stream(onBlock: (planes: Float32Array[], frames: number) => void, opts?: StreamOptions): Promise<void>;
  dispose(): void;
}

export interface StreamOptions {
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
  /** main-thread budget per slice before yielding to rendering (ms); 0 = never yield */
  sliceMs?: number;
}

const zeros = (channels: number, n: number): Float32Array[] => Array.from({ length: channels }, () => new Float32Array(Math.max(0, n)));

/** Yield to the event loop / renderer (scheduler.yield when available; MessageChannel avoids the 4 ms timer clamp). */
export function yieldToUi(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) return s.yield();
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') return void setTimeout(resolve, 0);
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

class MediabunnyReader implements PcmReader {
  private disposed = false;
  constructor(
    private readonly input: Input,
    private readonly sink: AudioSampleSink,
    readonly sampleRate: number,
    readonly channels: number,
    readonly frames: number,
  ) {}

  async readFrames(start: number, count: number): Promise<Float32Array[]> {
    const out = zeros(this.channels, count);
    if (count <= 0 || start + count <= 0 || this.disposed) return out;
    const sr = this.sampleRate;
    const end = start + count;
    for await (const s of this.sink.samples(Math.max(0, start) / sr, end / sr)) {
      try {
        const sf = Math.round(s.timestamp * sr);
        const a = Math.max(start, sf), b = Math.min(end, sf + s.numberOfFrames);
        if (b <= a) continue;
        for (let c = 0; c < this.channels; c++) {
          s.copyTo(out[c]!.subarray(a - start, b - start), { planeIndex: Math.min(c, s.numberOfChannels - 1), format: 'f32-planar', frameOffset: a - sf, frameCount: b - a });
        }
      } finally {
        s.close();
      }
    }
    return out;
  }

  async stream(onBlock: (planes: Float32Array[], frames: number) => void, opts: StreamOptions = {}): Promise<void> {
    const sr = this.sampleRate;
    const slice = opts.sliceMs ?? 8;
    let scratch = zeros(this.channels, 8192);
    let expected = 0;
    let t0 = performance.now();
    const emitSilence = (n: number) => {
      for (let left = n; left > 0; ) {
        const k = Math.min(left, scratch[0]!.length);
        for (const p of scratch) p.fill(0, 0, k);
        onBlock(scratch, k);
        left -= k;
      }
    };
    for await (const s of this.sink.samples()) {
      try {
        if (opts.signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
        const sf = Math.round(s.timestamp * sr);
        if (sf > expected) {
          // container gap → keep the timeline aligned with silence
          emitSilence(sf - expected);
          expected = sf;
        }
        const skip = Math.max(0, expected - sf); // overlap / negative (priming) timestamps
        const n = s.numberOfFrames - skip;
        if (n <= 0) continue;
        if (scratch[0]!.length < n) scratch = zeros(this.channels, n);
        for (let c = 0; c < this.channels; c++) {
          s.copyTo(scratch[c]!.subarray(0, n), { planeIndex: Math.min(c, s.numberOfChannels - 1), format: 'f32-planar', frameOffset: skip, frameCount: n });
        }
        onBlock(scratch, n);
        expected += n;
      } finally {
        s.close();
      }
      if (slice > 0 && performance.now() - t0 > slice) {
        opts.onProgress?.(this.frames > 0 ? Math.min(1, expected / this.frames) : 0);
        await yieldToUi();
        t0 = performance.now();
      }
    }
    opts.onProgress?.(1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.dispose();
  }
}

/** Fully decoded buffer (WebAudio fallback / tests). */
export class BufferReader implements PcmReader {
  readonly channels: number;
  readonly frames: number;
  constructor(private readonly planes: Float32Array[], readonly sampleRate: number) {
    this.channels = Math.max(1, planes.length);
    this.frames = planes[0]?.length ?? 0;
  }
  async readFrames(start: number, count: number): Promise<Float32Array[]> {
    const out = zeros(this.channels, count);
    const a = Math.max(0, start), b = Math.min(this.frames, start + count);
    if (b > a) for (let c = 0; c < this.channels; c++) out[c]!.set((this.planes[c] ?? this.planes[0]!).subarray(a, b), a - start);
    return out;
  }
  async stream(onBlock: (planes: Float32Array[], frames: number) => void, opts: StreamOptions = {}): Promise<void> {
    const block = 1 << 15;
    let t0 = performance.now();
    for (let i = 0; i < this.frames; i += block) {
      if (opts.signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
      const n = Math.min(block, this.frames - i);
      onBlock(this.planes.map((p) => p.subarray(i, i + n)), n);
      if ((opts.sliceMs ?? 8) > 0 && performance.now() - t0 > (opts.sliceMs ?? 8)) {
        opts.onProgress?.(i / this.frames);
        await yieldToUi();
        t0 = performance.now();
      }
    }
    opts.onProgress?.(1);
  }
  dispose(): void {
    /* buffers are GC'd */
  }
}

/** Open any mediabunny Source (UrlSource in the app, BufferSource in tests). */
export async function openPcmReaderFromSource(source: Source): Promise<PcmReader | null> {
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      return null;
    }
    const sink = new AudioSampleSink(track);
    // the decoded format wins over the container's (e.g. HE-AAC doubles the rate)
    const first = await sink.getSample(await track.getFirstTimestamp());
    const sampleRate = first?.sampleRate ?? track.sampleRate;
    const channels = Math.max(1, first?.numberOfChannels ?? track.numberOfChannels);
    first?.close();
    const duration = await track.computeDuration();
    return new MediabunnyReader(input, sink, sampleRate, channels, Math.max(0, Math.round(duration * sampleRate)));
  } catch (e) {
    input.dispose();
    throw e;
  }
}

/** Open a rec-media:// (or any fetchable) URL. null when the file is missing or has no decodable audio. */
export async function openPcmReader(url: string): Promise<PcmReader | null> {
  try {
    const r = await openPcmReaderFromSource(new UrlSource(url));
    if (r) return r;
  } catch (e) {
    log.warn('reader.mediabunny_failed', { url, error: e instanceof Error ? e.message : String(e) });
  }
  if (typeof OfflineAudioContext === 'undefined') return null;
  try {
    const bytes = await fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))));
    const buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes);
    log.info('reader.fallback_webaudio', { url, duration_s: Math.round(buf.duration) });
    return new BufferReader(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), buf.sampleRate);
  } catch (e) {
    log.warn('reader.open_failed', { url, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
