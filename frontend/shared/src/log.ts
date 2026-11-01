/**
 * Structured logger contract (key=value JSON lines). Implementations: electron-log (main),
 * console (renderer/worker), pino (backend). Never log secrets or typed characters.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  operation: string;
  module: string;
  status?: 'start' | 'success' | 'failure' | 'retry' | 'fallback';
  trace_id?: string;
  context?: Record<string, unknown>;
  error?: { message: string; stack?: string };
}
export type LogSink = (rec: LogRecord) => void;

export interface Logger {
  debug(op: string, ctx?: Record<string, unknown>): void;
  info(op: string, ctx?: Record<string, unknown>): void;
  warn(op: string, ctx?: Record<string, unknown>): void;
  error(op: string, err: unknown, ctx?: Record<string, unknown>): void;
  child(module: string): Logger;
}

const REDACT = /pass(word)?|token|secret|authorization|cookie|apikey|api_key/i;
export function redact(ctx: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!ctx) return ctx;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) out[k] = REDACT.test(k) ? '[redacted]' : v;
  return out;
}

export function createLogger(module: string, sink: LogSink, minLevel: LogLevel = 'info', traceId?: string): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const emit = (level: LogLevel, operation: string, ctx?: Record<string, unknown>, err?: unknown) => {
    if (order[level] < order[minLevel]) return;
    const rec: LogRecord = { timestamp: new Date().toISOString(), level, operation, module };
    if (traceId) rec.trace_id = traceId;
    const c = redact(ctx);
    if (c) rec.context = c;
    if (err !== undefined) {
      const e = err instanceof Error ? err : new Error(String(err));
      rec.status = 'failure';
      rec.error = e.stack ? { message: e.message, stack: e.stack } : { message: e.message };
    }
    sink(rec);
  };
  return {
    debug: (op, ctx) => emit('debug', op, ctx),
    info: (op, ctx) => emit('info', op, ctx),
    warn: (op, ctx) => emit('warn', op, ctx),
    error: (op, err, ctx) => emit('error', op, ctx, err),
    child: (m) => createLogger(`${module}.${m}`, sink, minLevel, traceId),
  };
}

export const consoleSink: LogSink = (rec) => {
  const line = JSON.stringify(rec);
  if (rec.level === 'error') console.error(line);
  else if (rec.level === 'warn') console.warn(line);
  else console.log(line);
};