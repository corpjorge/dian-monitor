import { formatTimestamp } from './time.js';

/**
 * Small human-readable logger:
 *   [2026-08-09 23:00:00] INFO  Portal cargado
 *
 * Secrets are never printed: values registered through `registerSecret()` are
 * replaced with `***` anywhere they appear in a message or payload.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const secrets = new Set<string>();

/** Registers a value that must never reach the console. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('***');
  // Belt and braces: mask anything that looks like a Telegram bot token.
  // No leading `\b`: in a real API URL the token follows "bot" with no
  // separator (`/bot123456789:AA…`), and a word boundary would never match.
  return out.replace(/\d{6,12}:[A-Za-z0-9_-]{30,}/g, '***');
}

function serialize(meta: Record<string, unknown>): string {
  const entries = Object.entries(meta).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const body = entries
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return ` ${body}`;
}

export class Logger {
  constructor(private readonly minLevel: LogLevel = 'info') {}

  private write(level: LogLevel, tag: string, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line = redact(`[${formatTimestamp()}] ${tag.padEnd(7)} ${message}${serialize(meta ?? {})}`);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', 'DEBUG', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', 'INFO', message, meta);
  }

  /** Same level as info, but visually distinct for the happy path. */
  success(message: string, meta?: Record<string, unknown>): void {
    this.write('info', 'SUCCESS', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', 'WARN', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', 'ERROR', message, meta);
  }
}

/** Default instance; `createLogger` lets the entrypoint honour LOG_LEVEL. */
export let logger = new Logger((process.env['LOG_LEVEL'] as LogLevel) ?? 'info');

export function createLogger(level: LogLevel): Logger {
  logger = new Logger(level);
  return logger;
}
