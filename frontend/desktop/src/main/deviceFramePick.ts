/** Auto-pick a device frame id by aspect (task 11.7); ids match renderer/editor/deviceFrames.ts. */
export function pickFrame(width: number, height: number, kind: 'android' | 'ios'): string {
  const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
  if (ratio < 1.7) return kind === 'ios' ? 'tablet' : 'android-tablet';
  return kind === 'ios' ? 'phone-island' : 'phone-punch';
}