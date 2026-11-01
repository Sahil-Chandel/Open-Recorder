import { describe, expect, it } from 'vitest';
import { approxLoudnessDb, encodeWav, fft, spectralDenoise } from '../src/renderer/src/audio/dsp';
import { wsolaStretch } from '../src/renderer/src/audio/wsola';
import { CAMERA_FILTERS, CLICK_EFFECTS, CURSOR_STYLES, cursorSvg, GRADIENTS, hexToRgb, SHAPES, WALLPAPERS } from '../src/renderer/src/compositor/assets';
import { MUSIC_LIBRARY } from '../src/renderer/src/audio/musicLibrary';
import { DEVICE_FRAMES, pickFrame } from '../src/renderer/src/editor/deviceFrames';

const sr = 16000;
const tone = (n: number, f = 440, a = 0.4) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr));
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('dsp', () => {
  it('fft → ifft round-trips', () => {
    const re = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 7) + 0.3 * Math.cos(i / 3));
    const orig = re.slice();
    const im = new Float32Array(256);
    fft(re, im);
    fft(re, im, true);
    for (let i = 0; i < 256; i++) expect(re[i]).toBeCloseTo(orig[i]!, 4);
  });

  it('spectral gating removes stationary noise but keeps speech-like tone bursts', async () => {
    let seed = 7;
    const noise = () => (((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1) * 0.05;
    const n = sr * 3;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = noise() + (i > sr && i < 2 * sr ? 0.4 * Math.sin((2 * Math.PI * 300 * i) / sr) : 0);
    const y = await spectralDenoise(x);
    const quietIn = rms(x.subarray(0, sr * 0.8)), quietOut = rms(y.subarray(0, sr * 0.8));
    const loudIn = rms(x.subarray(sr * 1.2, sr * 1.8)), loudOut = rms(y.subarray(sr * 1.2, sr * 1.8));
    expect(quietOut).toBeLessThan(quietIn * 0.5); // ≥ 6 dB on the noise floor (≈10 dB on pure noise)
    expect(loudOut).toBeGreaterThan(loudIn * 0.8); // tone preserved
  });

  it('encodes a valid 16-bit WAV header', () => {
    const w = encodeWav([tone(100), tone(100)], 48000);
    const dv = new DataView(w.buffer);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe('RIFF');
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint32(24, true)).toBe(48000);
    expect(w.byteLength).toBe(44 + 100 * 2 * 2);
  });

  it('estimates loudness monotonically', () => {
    expect(approxLoudnessDb(tone(sr * 2, 440, 0.5), sr)).toBeGreaterThan(approxLoudnessDb(tone(sr * 2, 440, 0.05), sr) + 15);
  });

  it('WSOLA stretches length by 1/speed and keeps energy', () => {
    const x = tone(sr * 2);
    for (const s of [1.5, 2]) {
      const y = wsolaStretch(x, s, sr);
      expect(Math.abs(y.length - x.length / s)).toBeLessThan(2);
      expect(rms(y.subarray(1000, y.length - 1000))).toBeGreaterThan(rms(x) * 0.8);
    }
  });
});

describe('original assets', () => {
  it('ships 40 cursor styles × 14 shapes, 8 click effects, 12 filters', () => {
    expect(CURSOR_STYLES).toHaveLength(40);
    expect(SHAPES).toHaveLength(14);
    expect(CLICK_EFFECTS).toHaveLength(8);
    expect(CAMERA_FILTERS).toHaveLength(12);
    for (const s of CURSOR_STYLES.slice(0, 5)) for (const sh of SHAPES) expect(cursorSvg(s, sh).svg).toMatch(/^<svg[\s\S]+<\/svg>$/);
  });
  it('has valid colors and unique ids everywhere', () => {
    const ids = [...GRADIENTS, ...WALLPAPERS].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GRADIENTS) for (const c of g.colors) expect(hexToRgb(c).every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(new Set(MUSIC_LIBRARY.map((m) => m.category)).size).toBe(4);
  });
  it('picks phone vs tablet device frames by aspect', () => {
    expect(pickFrame(1080, 2400, 'android')).toBe('phone-punch');
    expect(pickFrame(2048, 1536, 'ios')).toBe('tablet');
    expect(DEVICE_FRAMES.some((f) => f.id === 'phone-island')).toBe(true);
  });
});

describe('canvas snapping', () => {
  it('snaps a box centre to the canvas centre and reports the guide', async () => {
    const { snapBox } = await import('../src/renderer/src/editor/snap');
    const r = snapBox({ x: 447, y: 100, w: 100, h: 40 }, 1000, 600, []);
    expect(r.box.x).toBe(450);
    expect(r.guides.v).toEqual([500]);
    expect(r.guides.h).toEqual([]);
  });
  it('aligns to another item edge and leaves far boxes alone', async () => {
    const { snapBox } = await import('../src/renderer/src/editor/snap');
    expect(snapBox({ x: 203, y: 303, w: 50, h: 50 }, 1000, 600, [{ x: 100, y: 300, w: 100, h: 20 }]).box).toEqual({ x: 200, y: 300, w: 50, h: 50 });
    expect(snapBox({ x: 130, y: 130, w: 50, h: 50 }, 1000, 600, []).box).toEqual({ x: 130, y: 130, w: 50, h: 50 });
  });
});
