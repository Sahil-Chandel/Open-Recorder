/** Floating control bar (task 2.4, REC-09): timer, pause/continue, stop, restart, discard, mic mute. */
import { Keyboard, KeyboardOff, Mic, MicOff, Pause, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RecState } from '../../../shared/ipc';
import { api } from '../lib/api';
import { cx } from '../ui';

const fmt = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function ControlBar() {
  const [st, setSt] = useState<RecState>({ state: 'recording', elapsedSec: 0, micMuted: false });
  const [t, setT] = useState(0);
  useEffect(() => {
    void api.invoke<RecState>('rec:status').then(setSt);
    const offs = [api.on('rec:state', setSt), api.on('rec:tick', setT)];
    return () => offs.forEach((o) => o());
  }, []);
  const paused = st.state === 'paused';
  const Btn = ({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) => (
    <button aria-label={label} title={label} onClick={onClick} className={cx('no-drag flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/15 hover:text-white', danger && 'hover:bg-danger')}>{children}</button>
  );
  return (
    <div className="drag flex h-full items-center gap-1 rounded-full border border-white/10 bg-[#121218]/95 px-2 text-white shadow-2xl">
      <span className={cx('ml-2 h-2.5 w-2.5 rounded-full', paused ? 'bg-warn' : 'animate-pulse bg-danger')} />
      <span className="mx-2 w-16 font-mono text-sm tabular-nums">{fmt(t)}</span>
      <Btn label={paused ? 'Continue' : 'Pause'} onClick={() => api.invoke(paused ? 'rec:resume' : 'rec:pause')}>{paused ? <Play size={16} /> : <Pause size={16} />}</Btn>
      <Btn label="Finish" onClick={() => api.invoke('rec:stop')}><Square size={15} className="fill-danger text-danger" /></Btn>
      <Btn label="Restart" onClick={() => api.invoke('rec:restart')}><RotateCcw size={15} /></Btn>
      <Btn label="Discard" onClick={() => api.invoke('rec:discard')} danger><Trash2 size={15} /></Btn>
      <Btn label={st.micMuted ? 'Unmute mic' : 'Mute mic'} onClick={() => api.invoke('rec:toggleMicMute')}>{st.micMuted ? <MicOff size={15} className="text-danger" /> : <Mic size={15} />}</Btn>
      <Btn label={st.keysPaused ? 'Resume keystroke capture' : 'Pause keystroke capture (e.g. while typing a password)'} onClick={() => api.invoke('rec:toggleKeyCapture')}>{st.keysPaused ? <KeyboardOff size={15} className="text-warn" /> : <Keyboard size={15} />}</Btn>
    </div>
  );
}