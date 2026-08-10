import { isMonitorError } from './errors.js';
import { logger } from './logger.js';

export interface RetryOptions {
  /** Total attempts, including the first one. */
  attempts: number;
  /** Delay before the 2nd attempt; doubles each time (capped). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  label: string;
  /** Overrides the default "retry only MonitorErrors flagged retryable" rule. */
  shouldRetry?: (error: unknown) => boolean;
}

function defaultShouldRetry(error: unknown): boolean {
  // A structural change in the portal will not fix itself on the next attempt,
  // so those errors bail out immediately instead of burning the retry budget.
  if (isMonitorError(error)) return error.retryable;
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn`, retrying transient failures with exponential backoff. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, label, baseDelayMs = 2_000, maxDelayMs = 15_000 } = options;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const canRetry = attempt < attempts && shouldRetry(error);
      if (!canRetry) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      logger.warn(`${label} falló (intento ${attempt}/${attempts}), reintentando en ${delay / 1000}s`, {
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay);
    }
  }

  throw lastError;
}
