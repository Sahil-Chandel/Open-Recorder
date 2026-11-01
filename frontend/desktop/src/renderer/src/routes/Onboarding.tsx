/**
 * Permission onboarding (task 2.9, SET-09): live status for screen / camera / mic / accessibility,
 * one-click deep links into the OS privacy pages, then continue to the recorder.
 */
import { CheckCircle2, Circle, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, isMac } from '../lib/api';
import { Button, TitleBar } from '../ui';

type Status = Record<'screen' | 'camera' | 'microphone' | 'accessibility', string>;
const ROWS: Array<{ k: keyof Status; title: string; why: string; macOnly?: boolean }> = [
  { k: 'screen', title: 'Screen recording', why: 'Capture your screen and windows.', macOnly: true },
  { k: 'camera', title: 'Camera', why: 'Record your webcam as a separate layer.' },
  { k: 'microphone', title: 'Microphone', why: 'Record your voice.' },
  { k: 'accessibility', title: 'Accessibility / input monitoring', why: 'Track clicks and shortcuts for auto zoom and the keyboard overlay. Typed characters are never stored.', macOnly: true },
];

export default function Onboarding() {
  const [st, setSt] = useState<Status | null>(null);
  const [helper, setHelper] = useState('starting');
  const refresh = () => api.invoke<Status>('permissions:status').then(setSt);
  useEffect(() => {
    void refresh();
    void api.invoke<{ state: string }>('helper:status').then((s) => setHelper(s.state));
    const off = api.on('helper:state', setHelper);
    const t = setInterval(refresh, 2000);
    return () => { clearInterval(t); off(); };
  }, []);
  return (
    <div className="flex h-full flex-col bg-bg">
      <TitleBar title="Welcome" />
      <div className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <div>
          <h1 className="text-xl font-semibold">Let’s get you recording</h1>
          <p className="mt-1 text-[13px] text-muted">Record once — the app adds zooms, a smooth cursor, camera layouts and captions automatically. Everything stays on your computer.</p>
        </div>
        <div className="flex flex-col divide-y divide-line rounded-xl border border-line bg-panel">
          {ROWS.filter((r) => !r.macOnly || isMac()).map((r) => {
            const v = st?.[r.k] ?? 'unknown';
            const ok = v === 'granted';
            return (
              <div key={r.k} className="flex items-center gap-3 p-3">
                {ok ? <CheckCircle2 className="text-ok" size={20} /> : v === 'denied' ? <XCircle className="text-danger" size={20} /> : <Circle className="text-muted" size={20} />}
                <div className="flex-1">
                  <div className="text-[13px] font-medium">{r.title}</div>
                  <div className="text-xs text-muted">{r.why}</div>
                </div>
                {!ok && <Button size="sm" onClick={() => api.invoke('permissions:open', r.k)}>{isMac() ? 'Enable' : 'Open settings'}</Button>}
              </div>
            );
          })}
          <div className="flex items-center gap-3 p-3">
            {helper === 'ready' ? <CheckCircle2 className="text-ok" size={20} /> : <Circle className="text-muted" size={20} />}
            <div className="flex-1">
              <div className="text-[13px] font-medium">Capture engine</div>
              <div className="text-xs text-muted">{helper === 'ready' ? 'Ready' : helper === 'unavailable' ? 'Not found — reinstall the app.' : 'Starting…'}</div>
            </div>
          </div>
        </div>
        {isMac() && <p className="text-xs text-muted">After enabling Screen Recording or Accessibility, macOS may ask you to restart the app.</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line p-4">
        <Button variant="primary" onClick={async () => { await api.invoke('settings:set', { onboardingDone: true }); await api.invoke('win:open', 'recorder'); await api.invoke('win:close'); }}>Continue</Button>
      </div>
    </div>
  );
}