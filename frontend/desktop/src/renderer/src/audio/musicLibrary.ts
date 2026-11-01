/**
 * Background-music library (AUD-06): Focus / Business / Tech / Chill. Every track is ORIGINAL music
 * synthesised on-device from a seed (chord progression + bass + drums + pad), so there is nothing to
 * license and exports are royalty-free. Rendered with OfflineAudioContext into a loopable WAV.
 */
import { encodeWav } from './dsp';

export interface LibraryTrack { id: string; name: string; category: 'Focus' | 'Business' | 'Tech' | 'Chill'; bpm: number; key: number; prog: number[][]; drums: 'none' | 'soft' | 'four' | 'break'; wave: OscillatorType; bars: number }

const MAJ = [0, 4, 7], MIN = [0, 3, 7], MAJ7 = [0, 4, 7, 11], MIN7 = [0, 3, 7, 10];
const chord = (root: number, q: number[]) => q.map((n) => root + n);
export const MUSIC_LIBRARY: LibraryTrack[] = [
  { id: 'deep-work', name: 'Deep Work', category: 'Focus', bpm: 80, key: 57, prog: [chord(0, MIN7), chord(5, MAJ7), chord(3, MAJ7), chord(7, MIN7)], drums: 'soft', wave: 'triangle', bars: 8 },
  { id: 'clear-mind', name: 'Clear Mind', category: 'Focus', bpm: 72, key: 60, prog: [chord(0, MAJ7), chord(9, MIN7), chord(5, MAJ7), chord(7, MAJ)], drums: 'none', wave: 'sine', bars: 8 },
  { id: 'flow-state', name: 'Flow State', category: 'Focus', bpm: 90, key: 62, prog: [chord(0, MIN), chord(8, MAJ), chord(3, MAJ), chord(10, MAJ)], drums: 'soft', wave: 'triangle', bars: 8 },
  { id: 'quarterly', name: 'Quarterly Review', category: 'Business', bpm: 110, key: 60, prog: [chord(0, MAJ), chord(7, MAJ), chord(9, MIN), chord(5, MAJ)], drums: 'four', wave: 'triangle', bars: 8 },
  { id: 'onboarding', name: 'Onboarding', category: 'Business', bpm: 100, key: 65, prog: [chord(0, MAJ7), chord(5, MAJ7), chord(2, MIN7), chord(7, MAJ)], drums: 'soft', wave: 'sine', bars: 8 },
  { id: 'pitch-day', name: 'Pitch Day', category: 'Business', bpm: 118, key: 67, prog: [chord(0, MAJ), chord(4, MIN), chord(5, MAJ), chord(7, MAJ)], drums: 'four', wave: 'square', bars: 8 },
  { id: 'circuit', name: 'Circuit', category: 'Tech', bpm: 124, key: 57, prog: [chord(0, MIN), chord(0, MIN), chord(8, MAJ), chord(10, MAJ)], drums: 'four', wave: 'sawtooth', bars: 8 },
  { id: 'deploy', name: 'Deploy', category: 'Tech', bpm: 128, key: 62, prog: [chord(0, MIN7), chord(10, MAJ), chord(8, MAJ7), chord(7, MIN)], drums: 'break', wave: 'square', bars: 8 },
  { id: 'gradient', name: 'Gradient', category: 'Tech', bpm: 115, key: 64, prog: [chord(0, MIN), chord(5, MIN), chord(10, MAJ), chord(3, MAJ)], drums: 'four', wave: 'sawtooth', bars: 8 },
  { id: 'sunday', name: 'Sunday Morning', category: 'Chill', bpm: 84, key: 60, prog: [chord(0, MAJ7), chord(4, MIN7), chord(9, MIN7), chord(5, MAJ7)], drums: 'soft', wave: 'sine', bars: 8 },
  { id: 'lofi-loop', name: 'Lo-fi Loop', category: 'Chill', bpm: 76, key: 63, prog: [chord(0, MIN7), chord(5, MIN7), chord(10, MAJ7), chord(3, MAJ7)], drums: 'break', wave: 'triangle', bars: 8 },
  { id: 'harbor', name: 'Harbor Lights', category: 'Chill', bpm: 70, key: 58, prog: [chord(0, MAJ), chord(9, MIN), chord(4, MIN), chord(5, MAJ)], drums: 'none', wave: 'sine', bars: 8 },
];

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export async function renderLibraryTrack(id: string): Promise<{ bytes: Uint8Array; seconds: number }> {
  const t = MUSIC_LIBRARY.find((x) => x.id === id);
  if (!t) throw new Error('unknown track');
  const beat = 60 / t.bpm;
  const bar = beat * 4;
  const seconds = bar * t.bars;
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const master = ctx.createGain();
  master.gain.value = 0.5;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);
  // simple feedback delay for space
  const delay = ctx.createDelay(1);
  delay.delayTime.value = beat * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.25;
  delay.connect(fb).connect(delay);
  delay.connect(master);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = t.category === 'Tech' ? 3200 : 1800;
  lp.connect(master);
  lp.connect(delay);

  const note = (midi: number, start: number, dur: number, gain: number, wave: OscillatorType, dest: AudioNode) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = wave;
    o.frequency.value = hz(midi);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gain, start + Math.min(0.08, dur * 0.2));
    g.gain.setTargetAtTime(0, start + dur * 0.7, dur * 0.15);
    o.connect(g).connect(dest);
    o.start(start);
    o.stop(start + dur + 0.5);
  };
  let seed = id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  for (let b = 0; b < t.bars; b++) {
    const ch = t.prog[b % t.prog.length]!;
    const t0 = b * bar;
    // pad
    for (const n of ch) note(t.key + n, t0, bar, 0.06, t.wave === 'square' ? 'triangle' : t.wave, lp);
    // bass
    for (let k = 0; k < 4; k++) if (k % 2 === 0 || t.drums === 'four') note(t.key - 24 + ch[0]!, t0 + k * beat, beat * 0.9, 0.18, 'sine', master);
    // arpeggio melody
    for (let k = 0; k < 8; k++) {
      if (rnd() < 0.35) continue;
      const n = ch[Math.floor(rnd() * ch.length)]! + 12 + (rnd() < 0.2 ? 12 : 0);
      note(t.key + n, t0 + k * beat * 0.5, beat * 0.45, 0.05, t.wave, lp);
    }
    // drums
    if (t.drums !== 'none') {
      for (let k = 0; k < 4; k++) {
        const s = t0 + k * beat;
        const kick = t.drums === 'four' || k % 2 === 0;
        if (kick) {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.setValueAtTime(120, s);
          o.frequency.exponentialRampToValueAtTime(40, s + 0.12);
          g.gain.setValueAtTime(t.drums === 'soft' ? 0.25 : 0.45, s);
          g.gain.exponentialRampToValueAtTime(0.001, s + 0.25);
          o.connect(g).connect(master);
          o.start(s);
          o.stop(s + 0.3);
        }
        // hat (noise burst)
        const nb = ctx.createBuffer(1, Math.round(sr * 0.05), sr);
        const d = nb.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (rnd() * 2 - 1) * Math.exp(-i / (sr * 0.01));
        const src = ctx.createBufferSource();
        src.buffer = nb;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 7000;
        const hg = ctx.createGain();
        hg.gain.value = t.drums === 'soft' ? 0.05 : 0.09;
        src.connect(hp).connect(hg).connect(master);
        src.start(s + beat / 2);
      }
    }
  }
  const out = await ctx.startRendering();
  return { bytes: encodeWav([out.getChannelData(0), out.getChannelData(1)], sr), seconds };
}
