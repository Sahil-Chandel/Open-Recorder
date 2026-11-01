/**
 * Click sounds (CUR-06): 6 original sounds synthesised at runtime (no bundled samples to license).
 */
export const CLICK_SOUNDS: Array<{ id: string; name: string }> = [
  { id: 'soft-tick', name: 'Soft tick' },
  { id: 'mouse', name: 'Mouse click' },
  { id: 'pop', name: 'Pop' },
  { id: 'tap', name: 'Tap' },
  { id: 'wood', name: 'Wood block' },
  { id: 'digital', name: 'Digital' },
];

export function synthClick(ctx: BaseAudioContext, id: string): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.round(sr * 0.09);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let v = 0;
    switch (id) {
      case 'mouse': v = (rnd() * Math.exp(-t * 900) + Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 400) * 0.5) * 0.8; break;
      case 'pop': v = Math.sin(2 * Math.PI * (600 - 3000 * t) * t) * Math.exp(-t * 60) * 0.7; break;
      case 'tap': v = rnd() * Math.exp(-t * 300) * 0.5 + Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 80) * 0.5; break;
      case 'wood': v = (Math.sin(2 * Math.PI * 900 * t) + 0.5 * Math.sin(2 * Math.PI * 1800 * t)) * Math.exp(-t * 90) * 0.5; break;
      case 'digital': v = (Math.sin(2 * Math.PI * 1760 * t) > 0 ? 0.3 : -0.3) * Math.exp(-t * 70); break;
      default: v = Math.sin(2 * Math.PI * 3200 * t) * Math.exp(-t * 250) * 0.6 + rnd() * Math.exp(-t * 1500) * 0.3;
    }
    d[i] = v;
  }
  return buf;
}
