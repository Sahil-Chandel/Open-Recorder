/**
 * Dual-GPU laptops (task 14.5): ask Chromium for the discrete GPU, and if the integrated one still ends up
 * driving the app, explain once how to assign Open-Recorder to the high-performance GPU.
 */
import { app, dialog, shell } from 'electron';
import { logger } from './log';
import { settings } from './settings';

const log = logger.child('gpu');
const VENDOR: Record<number, string> = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel' };

/** Must run before app ready. Harmless on single-GPU machines. */
export function preferDiscreteGpu(): void {
  app.commandLine.appendSwitch('force_high_performance_gpu');
}

interface GpuDevice { active?: boolean; vendorId?: number; deviceString?: string }

export async function checkGpuOnce(): Promise<void> {
  if (settings.get().general.gpuHintShown) return;
  try {
    const info = (await app.getGPUInfo('complete')) as { gpuDevice?: GpuDevice[] };
    const devices = info.gpuDevice ?? [];
    const discrete = devices.find((d) => d.vendorId === 0x10de || d.vendorId === 0x1002);
    const active = devices.find((d) => d.active);
    log.info('gpu.info', { devices: devices.map((d) => ({ vendor: VENDOR[d.vendorId ?? 0] ?? d.vendorId, active: Boolean(d.active) })) });
    if (!discrete || !active || active.vendorId !== 0x8086) return;
    settings.set({ general: { gpuHintShown: true } });
    const name = VENDOR[discrete.vendorId!] ?? 'dedicated';
    const r = await dialog.showMessageBox({
      type: 'info',
      title: 'Use your faster graphics card',
      message: `Your computer has an ${name} graphics card, but Open-Recorder is running on the built-in Intel graphics.`,
      detail: process.platform === 'win32'
        ? `For smoother 4K previews and faster exports: Settings → System → Display → Graphics → add Open-Recorder → Options → "High performance" (${name}). Then restart Open-Recorder.`
        : 'For smoother previews and faster exports, set Open-Recorder to use the high-performance GPU, then restart it.',
      buttons: process.platform === 'win32' ? ['Open graphics settings', 'Not now'] : ['OK'],
      defaultId: 0,
      cancelId: 1,
    });
    if (process.platform === 'win32' && r.response === 0) await shell.openExternal('ms-settings:display-advancedgraphics');
  } catch (e) {
    log.warn('gpu.check', { message: (e as Error).message });
  }
}
