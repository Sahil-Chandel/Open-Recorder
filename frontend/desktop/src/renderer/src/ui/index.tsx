/**
 * Design system (task 0.5): Button, IconButton, Slider (+numeric input), Toggle, Select, ColorPicker,
 * SegmentedControl, Tabs, Tooltip, Modal, Toast, Panel/Section, TitleBar. Accessible labels throughout.
 */
import { X, Minus } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { api } from '../lib/api';

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ');
}

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', size = 'md', className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      {...p}
      className={cx(
        'no-drag inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-ui)] font-medium transition disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'lg' && 'h-11 px-5 text-sm',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-2',
        variant === 'secondary' && 'bg-panel-2 text-text hover:bg-line border border-line',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-panel-2',
        variant === 'danger' && 'bg-danger text-white hover:opacity-90',
        className,
      )}
    />
  );
}

export function IconButton({ label, active, className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <Tooltip text={label}>
      <button
        aria-label={label}
        {...p}
        className={cx(
          'no-drag inline-flex h-8 w-8 items-center justify-center rounded-lg transition disabled:opacity-40',
          active ? 'bg-accent/20 text-accent-2' : 'text-muted hover:bg-panel-2 hover:text-text',
          className,
        )}
      />
    </Tooltip>
  );
}

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/90 px-2 py-1 text-[11px] text-white opacity-0 shadow transition-opacity delay-300 group-hover:opacity-100">
        {text}
      </span>
    </span>
  );
}

/**
 * Display scale of a slider's formatter (e.g. 0..1 shown as "50%" → 100), so typed numbers are read in
 * the same units the box shows instead of being clamped (typing "30" on a % slider used to give 100%).
 */
export function displayScale(format: ((v: number) => string) | undefined, min: number, max: number): number {
  if (!format) return 1;
  for (const v of [min + (max - min) * 0.5, min + (max - min) * 0.37]) {
    if (v === 0) continue;
    const n = parseFloat(format(v));
    if (!Number.isFinite(n) || n === 0) continue;
    const k = n / v;
    for (const c of [1, 100, 1000]) if (Math.abs(k - c) / c < 0.05) return c;
  }
  return 1;
}

export function Slider({ label, value, min, max, step = 0.01, onChange, format, parse, suffix, disabled, onCommit }: {
  label?: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string;
  /** typed text → value; defaults to a number in the formatter's display units */
  parse?: (text: string) => number; suffix?: string; disabled?: boolean; onCommit?: () => void;
}) {
  const id = useId();
  const [text, setText] = useState<string | null>(null);
  const shown = format ? format(value) : `${Math.round(value * 100) / 100}`;
  const read = (t: string): number => (parse ? parse(t) : parseFloat(t.replace(',', '.')) / displayScale(format, min, max));
  return (
    <div className={cx('flex flex-col gap-1', disabled && 'opacity-40')}>
      {label && (
        <div className="flex items-center justify-between">
          <label htmlFor={id} className="text-xs text-muted">{label}</label>
          <input
            aria-label={`${label} value`}
            className="w-16 rounded bg-panel-2 px-1.5 py-0.5 text-right text-xs tabular-nums outline-none"
            value={text ?? shown + (suffix ?? '')}
            disabled={disabled}
            onFocus={() => setText(shown)}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              const v = read(text ?? '');
              if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
              setText(null);
              onCommit?.();
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </div>
      )}
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))} onPointerUp={onCommit} className="w-full" />
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; hint?: string }) {
  return (
    <label className={cx('no-drag flex cursor-pointer items-center justify-between gap-3 py-1', disabled && 'pointer-events-none opacity-40')}>
      {label && <span className="flex flex-col"><span className="text-[13px]">{label}</span>{hint && <span className="text-[11px] text-muted">{hint}</span>}</span>}
      <button
        type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cx('relative h-5 w-9 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-line')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  );
}

export function Select<T extends string>({ value, options, onChange, label, className, disabled }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label?: string; className?: string; disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      {label && <label htmlFor={id} className="text-xs text-muted">{label}</label>}
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}
        className="no-drag h-8 w-full rounded-[var(--radius-ui)] border border-line bg-panel-2 px-2 text-[13px] outline-none disabled:opacity-40">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export const SWATCHES = ['#ffffff', '#000000', '#7c5cff', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#14b8a6'];
export function ColorPicker({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-xs text-muted">{label}</span>}
      <div className="flex flex-wrap items-center gap-1.5">
        {SWATCHES.map((c) => (
          <button key={c} aria-label={`color ${c}`} onClick={() => onChange(c)}
            className={cx('h-5 w-5 rounded-full border', value.toLowerCase() === c ? 'border-accent ring-2 ring-accent/50' : 'border-line')} style={{ background: c }} />
        ))}
        <input aria-label="custom color" type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onChange={(e) => onChange(e.target.value)} className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0" />
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, className, size = 'md' }: {
  value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; className?: string; size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" className={cx('no-drag inline-flex rounded-[var(--radius-ui)] bg-panel-2 p-0.5', className)}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} title={o.title} onClick={() => onChange(o.value)}
          className={cx('flex-1 whitespace-nowrap rounded-lg px-2.5 transition', size === 'sm' ? 'h-6 text-[11px]' : 'h-7 text-xs', value === o.value ? 'bg-accent text-white' : 'text-muted hover:text-text')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-[13px]', value === t.value ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line px-4 py-3">
      <header className="mb-2 flex items-center justify-between">
        <button className="text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-text" onClick={() => setOpen(!open)}>{title}</button>
        {right}
      </header>
      {open && <div className="flex flex-col gap-3">{children}</div>}
    </section>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 520 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="flex max-h-[90vh] flex-col rounded-2xl border border-line bg-panel shadow-2xl outline-none" style={{ width }}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
        </header>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- toasts
interface ToastItem { id: number; kind: 'info' | 'success' | 'warning' | 'error'; message: string; action?: { label: string; run: () => void } }
interface ToastStore { items: ToastItem[]; push: (t: Omit<ToastItem, 'id'>) => void; remove: (id: number) => void }
let toastId = 1;
export const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (t) => {
    const id = toastId++;
    set((s) => ({ items: [...s.items.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((i) => i.id !== id) })), t.kind === 'error' ? 8000 : 4000);
  },
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));
export const toast = (message: string, kind: ToastItem['kind'] = 'info', action?: ToastItem['action']) => useToasts.getState().push({ message, kind, ...(action ? { action } : {}) });

export function Toaster() {
  const { items, remove } = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex flex-col gap-2" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={cx('pointer-events-auto flex max-w-sm items-center gap-3 rounded-xl border px-4 py-2.5 text-[13px] shadow-xl',
          t.kind === 'error' ? 'border-danger/50 bg-[#2a1215]' : t.kind === 'success' ? 'border-ok/40 bg-[#10241a]' : t.kind === 'warning' ? 'border-warn/40 bg-[#2a2010]' : 'border-line bg-panel-2')}>
          <span className="flex-1">{t.message}</span>
          {t.action && <button className="font-medium text-accent-2" onClick={() => { t.action!.run(); remove(t.id); }}>{t.action.label}</button>}
          <button aria-label="dismiss" onClick={() => remove(t.id)} className="text-muted"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export function TitleBar({ title, children, onClose }: { title?: ReactNode; children?: ReactNode; onClose?: () => void }) {
  const isMac = api.platform() === 'darwin';
  return (
    <div className={cx('drag flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3', isMac && 'pl-20')}>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-medium">{title}</div>
      <div className="no-drag flex items-center gap-1">{children}</div>
      {!isMac && (
        <div className="no-drag ml-1 flex items-center">
          <button aria-label="Minimize" className="flex h-8 w-9 items-center justify-center text-muted hover:bg-panel-2" onClick={() => api.invoke('win:minimize')}><Minus size={14} /></button>
          <button aria-label="Close" className="flex h-8 w-9 items-center justify-center text-muted hover:bg-danger hover:text-white" onClick={onClose ?? (() => api.invoke('win:close'))}><X size={14} /></button>
        </div>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  );
}

export function TextInput(p: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx('no-drag h-8 rounded-[var(--radius-ui)] border border-line bg-panel-2 px-2 text-[13px] outline-none focus:border-accent', p.className)} />;
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted">
      {icon}
      <div className="text-sm text-text">{title}</div>
      {hint && <div className="max-w-xs text-xs">{hint}</div>}
      {action}
    </div>
  );
}

export function Meter({ value, label }: { value: number; label: string }) {
  const db = value > 0 ? 20 * Math.log10(value) : -60;
  const pct = Math.max(0, Math.min(1, (db + 60) / 60));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(db)}>
      <div className={cx('h-full rounded-full transition-[width] duration-75', pct > 0.92 ? 'bg-danger' : pct > 0.75 ? 'bg-warn' : 'bg-ok')} style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

// simple confirm dialog hook
const ConfirmCtx = createContext<(msg: string, opts?: { danger?: boolean; ok?: string }) => Promise<boolean>>(async () => false);
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ msg: string; danger?: boolean; ok?: string; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback((msg: string, opts?: { danger?: boolean; ok?: string }) => new Promise<boolean>((resolve) => setState({ msg, ...opts, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={!!state} onClose={() => close(false)} title="Please confirm" width={420}
        footer={<><Button onClick={() => close(false)}>Cancel</Button><Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.ok ?? 'OK'}</Button></>}>
        <p className="text-[13px] leading-relaxed">{state?.msg}</p>
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);
