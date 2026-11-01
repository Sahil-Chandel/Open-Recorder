/**
 * HelperSupervisor (task 0.6): spawns the native capture helper, speaks JSON-RPC 2.0 over stdio,
 * health-checks with ping, restarts with exponential back-off + jitter, kills on quit.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { RpcNotificationSchema, RpcResponseSchema } from '@rec/shared';
import { logger } from './log';
import { binPath, ffmpegPath } from './paths';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export type HelperState = 'stopped' | 'starting' | 'ready' | 'crashed' | 'unavailable';

interface HelperLogLine {
  level?: string;
  operation?: string;
  context?: Record<string, unknown>;
  error?: { type?: string; message?: string; stack?: string };
}

function parseLogLine(text: string): HelperLogLine | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as HelperLogLine) : null;
  } catch {
    return null; // raw text, e.g. the .NET runtime's own crash output
  }
}

export class HelperSupervisor extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private restarts = 0;
  private health: NodeJS.Timeout | null = null;
  private quitting = false;
  state: HelperState = 'stopped';
  info: Record<string, unknown> = {};
  private log = logger.child('helper');

  constructor(private readonly binName = process.platform === 'darwin' ? 'mac-helper' : 'win-helper') {
    super();
  }

  start(): void {
    if (this.quitting) return;
    const bin = binPath(this.binName);
    if (!bin) {
      this.setState('unavailable');
      this.log.error('helper.missing', new Error(`${this.binName} binary not found`));
      return;
    }
    this.setState('starting');
    const proc = spawn(bin, [], { stdio: 'pipe', windowsHide: true, env: { ...process.env, RECORDER_FFMPEG: ffmpegPath() } });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: proc.stderr }).on('line', (line) => this.onStderr(line));
    proc.on('exit', (code, signal) => this.onExit(code, signal));
    proc.on('error', (e) => this.log.error('helper.spawn', e));
    this.call('version', undefined, 30000)
      .then((v) => {
        this.info = v as Record<string, unknown>;
        this.restarts = 0;
        this.setState('ready');
        this.log.info('helper.ready', this.info);
      })
      .catch((e) => this.log.error('helper.version', e));
    this.health = setInterval(() => {
      if (this.state !== 'ready') return;
      this.call('ping', undefined, 5000).catch((e) => {
        this.log.warn('helper.ping.failed', { message: (e as Error).message });
        this.proc?.kill();
      });
    }, 10000);
  }

  private setState(s: HelperState): void {
    this.state = s;
    this.emit('state', s);
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.warn('helper.badline', { line: line.slice(0, 200) });
      return;
    }
    const res = RpcResponseSchema.safeParse(msg);
    if (res.success && res.data.id !== undefined && this.pending.has(res.data.id)) {
      const p = this.pending.get(res.data.id)!;
      this.pending.delete(res.data.id);
      clearTimeout(p.timer);
      if (res.data.error) p.reject(Object.assign(new Error(res.data.error.message), { code: res.data.error.code }));
      else p.resolve(res.data.result);
      return;
    }
    const note = RpcNotificationSchema.safeParse(msg);
    if (note.success) this.emit('notification', note.data.method, note.data.params);
  }

  /**
   * The helper logs structured JSON lines on stderr. Its warnings/errors (and any raw .NET crash text such as
   * "Unhandled exception.") are promoted into the main log so helper crashes are diagnosable from main.log alone.
   */
  private onStderr(line: string): void {
    const text = line.slice(0, 4000);
    const rec = parseLogLine(text);
    if (!rec) {
      if (/exception|fatal|unhandled|   at /i.test(text)) this.log.error('helper.stderr', new Error(text));
      else this.log.debug('helper.stderr', { line: text });
      return;
    }
    const op = `helper.${rec.operation ?? 'log'}`;
    if (rec.level === 'error' || rec.level === 'fatal') {
      const err = Object.assign(new Error(rec.error?.message ?? 'helper error'), { name: rec.error?.type ?? 'HelperError', stack: rec.error?.stack });
      this.log.error(op, err, rec.context);
    } else if (rec.level === 'warn') this.log.warn(op, { ...rec.context, ...(rec.error ? { error: rec.error.message } : {}) });
    else this.log.debug(op, rec.context);
  }

  private onExit(code: number | null, signal: string | null): void {
    if (this.health) clearInterval(this.health);
    this.health = null;
    this.proc = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`helper exited during ${p.method}`));
    }
    this.pending.clear();
    if (this.quitting) return this.setState('stopped');
    this.setState('crashed');
    this.restarts++;
    const delay = Math.min(30000, 500 * 2 ** this.restarts) * (0.8 + Math.random() * 0.4);
    // 0xE0434352 = unhandled .NET exception (the preceding helper.unhandled line has the stack)
    const hex = code != null && code > 0xffff ? `0x${(code >>> 0).toString(16).toUpperCase()}` : undefined;
    this.log.warn('helper.exit', { code, hex, signal, restartInMs: Math.round(delay), restarts: this.restarts });
    setTimeout(() => this.start(), delay);
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 15000): Promise<T> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error(`helper not running (${this.state})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  stop(): void {
    this.quitting = true;
    if (this.health) clearInterval(this.health);
    try {
      this.proc?.stdin.end(); // helper exits when stdin closes and finalises any recording
    } catch {
      /* already closed */
    }
    const p = this.proc;
    if (p) setTimeout(() => p.kill(), 4000).unref();
  }
}

export const helper = new HelperSupervisor();
