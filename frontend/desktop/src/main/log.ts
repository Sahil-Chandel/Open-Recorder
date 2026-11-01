/**
 * Structured JSON logging via electron-log with rotation (task 0.4). Log files feed "Send Feedback".
 */
import log from 'electron-log/main';
import { createLogger, type Logger, type LogRecord } from '@rec/shared';

log.transports.file.maxSize = 5 * 1024 * 1024; // rotates to main.old.log
log.transports.file.format = '{text}';
log.transports.console.format = '{text}';

const sink = (rec: LogRecord): void => {
  const line = JSON.stringify(rec);
  if (rec.level === 'error') log.error(line);
  else if (rec.level === 'warn') log.warn(line);
  else if (rec.level === 'debug') log.debug(line);
  else log.info(line);
};

export const logger: Logger = createLogger('main', sink, process.env.RECORDER_LOG_LEVEL === 'debug' ? 'debug' : 'info');
export const logFilePath = (): string => log.transports.file.getFile().path;
export function initLogging(): void {
  log.initialize();
  process.on('uncaughtException', (e) => logger.error('process.uncaughtException', e));
  process.on('unhandledRejection', (e) => logger.error('process.unhandledRejection', e));
}