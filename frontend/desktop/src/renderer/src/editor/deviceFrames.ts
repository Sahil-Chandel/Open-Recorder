/**
 * Device frames (STY-05, DEV-05, task 11.7): original vector frames drawn procedurally
 * (no third-party device artwork). Bezel/corner values are relative to the screen's short side.
 */
export interface DeviceFrame {
  id: string;
  name: string;
  kind: 'phone' | 'tablet';
  bezel: number; // fraction of short side
  corner: number; // outer corner radius fraction
  screenCorner: number;
  color: string;
  edge: string;
  cutout: 'island' | 'notch' | 'punch' | 'none';
}

export const DEVICE_FRAMES: DeviceFrame[] = [
  { id: 'phone-island', name: 'Phone (island, dark)', kind: 'phone', bezel: 0.035, corner: 0.16, screenCorner: 0.13, color: '#16161a', edge: '#3a3a42', cutout: 'island' },
  { id: 'phone-island-silver', name: 'Phone (island, silver)', kind: 'phone', bezel: 0.035, corner: 0.16, screenCorner: 0.13, color: '#d9dadf', edge: '#9a9ca5', cutout: 'island' },
  { id: 'phone-notch', name: 'Phone (notch)', kind: 'phone', bezel: 0.04, corner: 0.15, screenCorner: 0.12, color: '#111114', edge: '#2e2e36', cutout: 'notch' },
  { id: 'phone-punch', name: 'Android phone (punch-hole)', kind: 'phone', bezel: 0.03, corner: 0.12, screenCorner: 0.1, color: '#0f1014', edge: '#33343c', cutout: 'punch' },
  { id: 'phone-punch-blue', name: 'Android phone (blue)', kind: 'phone', bezel: 0.03, corner: 0.12, screenCorner: 0.1, color: '#1d2b4a', edge: '#41598a', cutout: 'punch' },
  { id: 'phone-flat', name: 'Generic phone', kind: 'phone', bezel: 0.05, corner: 0.1, screenCorner: 0.06, color: '#1a1a1f', edge: '#3b3b44', cutout: 'none' },
  { id: 'tablet', name: 'Tablet', kind: 'tablet', bezel: 0.045, corner: 0.06, screenCorner: 0.035, color: '#18181d', edge: '#3a3a42', cutout: 'none' },
  { id: 'tablet-silver', name: 'Tablet (silver)', kind: 'tablet', bezel: 0.045, corner: 0.06, screenCorner: 0.035, color: '#dcdde2', edge: '#a0a2aa', cutout: 'none' },
  { id: 'android-tablet', name: 'Android tablet', kind: 'tablet', bezel: 0.04, corner: 0.05, screenCorner: 0.03, color: '#121216', edge: '#2f2f38', cutout: 'punch' },
];

export function pickFrame(width: number, height: number, kind: 'android' | 'ios'): string {
  const ratio = Math.max(width, height) / Math.min(width, height);
  const tablet = ratio < 1.7;
  if (tablet) return kind === 'ios' ? 'tablet' : 'android-tablet';
  return kind === 'ios' ? 'phone-island' : 'phone-punch';
}