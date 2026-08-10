/**
 * Error taxonomy. Every failure the monitor can produce is one of these, so the
 * top level can decide between "expected, keep going" and "stop this run".
 */

export type ErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'NAVIGATION_ERROR'
  | 'ELEMENT_NOT_FOUND'
  | 'DIAN_STRUCTURE_CHANGED'
  | 'NOTIFICATION_ERROR'
  | 'CAPTCHA_DETECTED'
  | 'STORAGE_ERROR';

export abstract class MonitorError extends Error {
  abstract readonly code: ErrorCode;
  /** Retrying only helps for transient problems (slow network, cold start). */
  readonly retryable: boolean = false;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** A required env var is missing or malformed. Always fatal, never retried. */
export class ConfigurationError extends MonitorError {
  readonly code = 'CONFIGURATION_ERROR' as const;
}

/** The portal did not load, timed out, or returned an unusable page. */
export class NavigationError extends MonitorError {
  readonly code = 'NAVIGATION_ERROR' as const;
  override readonly retryable = true;
}

/** A control was expected on screen and never appeared. */
export class ElementNotFoundError extends MonitorError {
  readonly code = 'ELEMENT_NOT_FOUND' as const;
  override readonly retryable = true;
}

/**
 * The page loaded fine but does not look like the flow we mapped — e.g. a
 * control exists but none of its options match anything we know. Retrying is
 * pointless; the DIAN interface changed and the selectors need review.
 */
export class DianStructureChangedError extends MonitorError {
  readonly code = 'DIAN_STRUCTURE_CHANGED' as const;
  override readonly retryable = false;
}

/** Email or Telegram delivery failed. Never aborts the other channel. */
export class NotificationError extends MonitorError {
  readonly code = 'NOTIFICATION_ERROR' as const;
  readonly channel: string;

  constructor(channel: string, message: string, details: Record<string, unknown> = {}) {
    super(message, details);
    this.channel = channel;
  }
}

/**
 * A CAPTCHA / anti-bot challenge was detected. The monitor stops here on
 * purpose: this project does not attempt to solve or bypass such checks.
 */
export class CaptchaDetectedError extends MonitorError {
  readonly code = 'CAPTCHA_DETECTED' as const;
}

export class StorageError extends MonitorError {
  readonly code = 'STORAGE_ERROR' as const;
}

export function isMonitorError(error: unknown): error is MonitorError {
  return error instanceof MonitorError;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
