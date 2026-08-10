import type { AvailabilityResult } from '../dian/availability.js';

/**
 * What a single execution produced, in the shape the notification channels
 * consume. Modelled as a union so every message builder is forced to handle
 * the three real outcomes: found, not found, and the run itself failed.
 */
export type RunReport =
  | {
      kind: 'available';
      result: AvailabilityResult;
      /** True when this is the same availability already alerted before. */
      isRepeat: boolean;
      screenshotPath?: string;
    }
  | {
      kind: 'unavailable';
      result: AvailabilityResult;
      /** Ejecuciones que resume este mensaje (1 = sólo la actual). */
      runsCovered?: number;
      screenshotPath?: string;
    }
  | { kind: 'error'; error: string; runsCovered?: number; screenshotPath?: string };
