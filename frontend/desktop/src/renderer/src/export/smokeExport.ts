/** Smoke-test hook: export the open project at 720p30 and log the result for the headless runner. */
import { startExport } from './exporter';
import { useEditor } from '../editor/store';
import { api } from '../lib/api';

export async function runSmokeExport(): Promise<void> {
  const s = useEditor.getState();
  const settings = await api.invoke<{ general: { exportDir: string } }>('settings:get');
  const t0 = performance.now();
  try {
    for (const format of ['mp4', 'gif'] as const) {
      const job = startExport({
        project: s.project!, opened: s.opened!, telemetry: s.telemetry,
        settings: { name: `smoke-${format}`, dir: settings.general.exportDir, format, resolution: '720p', fps: format === 'gif' ? 15 : 30, quality: 'medium' },
        onProgress: () => undefined,
      });
      const r = await job.promise;
      console.log(`SMOKE_EXPORT ${JSON.stringify({ ok: true, format, ...r, ms: Math.round(performance.now() - t0) })}`);
    }
  } catch (e) {
    console.log(`SMOKE_EXPORT ${JSON.stringify({ ok: false, error: String((e as Error)?.stack ?? e) })}`);
  }
}