import type { AvailabilityResult } from '../dian/availability.js';
import { fingerprint } from '../dian/availability.js';
import type { MonitorState } from '../storage/types.js';
import { minutesSince } from '../utils/time.js';

/**
 * Duplicate control.
 *
 * Two independent guards:
 *  · fingerprint — the same city + service + procedure + modality + dates +
 *    times produces the same SHA-256, so identical availability never alerts
 *    twice. A new date, a new time or a different message changes the hash and
 *    does alert.
 *  · cooldown — even for a *changed* fingerprint, `NOTIFICATION_COOLDOWN_MINUTES`
 *    puts a floor on how often alerts can go out. Set it to 0 to disable.
 */

/**
 * When to actually send a message.
 *
 * Checking every few minutes would mean hundreds of identical "still nothing"
 * messages a day, so the monitor stays quiet by default and speaks only when it
 * has something to say:
 *
 *  · **Hay cita** → siempre. Es el motivo de existir del monitor.
 *  · **Sin cupo** → sólo cada `HEARTBEAT_EVERY_RUNS` ejecuciones. Ese resumen
 *    periódico es lo que distingue "no hay cita" de "el cron dejó de correr".
 *  · **Fallo nuevo** → de inmediato: si el monitor se rompe conviene saberlo ya,
 *    no dentro de 50 ejecuciones.
 *  · **Fallo que se repite** → se calla hasta el siguiente resumen, para que una
 *    caída larga del portal no genere una avalancha.
 */
export type ReportTrigger = 'disponibilidad' | 'fallo-nuevo' | 'resumen-periodico' | 'silencio';

export interface ReportDecision {
  send: boolean;
  trigger: ReportTrigger;
  /** Ejecuciones acumuladas desde el último mensaje, contando la actual. */
  runNumber: number;
}

export function decideReporting(params: {
  kind: 'available' | 'unavailable' | 'error';
  previous: MonitorState | null;
  heartbeatEveryRuns: number;
}): ReportDecision {
  const { kind, previous, heartbeatEveryRuns } = params;
  const runNumber = (previous?.runsSinceLastReport ?? 0) + 1;

  if (kind === 'available') return { send: true, trigger: 'disponibilidad', runNumber };

  if (kind === 'error' && !previous?.lastRunFailed) {
    return { send: true, trigger: 'fallo-nuevo', runNumber };
  }

  if (heartbeatEveryRuns > 0 && runNumber >= heartbeatEveryRuns) {
    return { send: true, trigger: 'resumen-periodico', runNumber };
  }

  return { send: false, trigger: 'silencio', runNumber };
}

export type SkipReason = 'sin-disponibilidad' | 'misma-disponibilidad' | 'en-enfriamiento';

export interface DedupeDecision {
  shouldNotify: boolean;
  fingerprint: string;
  reason?: SkipReason;
  /** Minutes left in the cooldown window, when that is the blocker. */
  cooldownRemainingMinutes?: number;
}

export function decideNotification(
  result: AvailabilityResult,
  previous: MonitorState | null,
  cooldownMinutes: number,
  now: Date = new Date(),
): DedupeDecision {
  const current = fingerprint(result);

  if (!result.available) {
    return { shouldNotify: false, fingerprint: current, reason: 'sin-disponibilidad' };
  }

  if (previous && previous.fingerprint === current) {
    // Same availability as last time. The cooldown decides whether it is old
    // enough to be worth repeating; with cooldown 0 it stays suppressed.
    const elapsed = minutesSince(previous.notifiedAt, now);
    if (cooldownMinutes <= 0 || elapsed < cooldownMinutes) {
      return {
        shouldNotify: false,
        fingerprint: current,
        reason: cooldownMinutes <= 0 ? 'misma-disponibilidad' : 'en-enfriamiento',
        ...(cooldownMinutes > 0
          ? { cooldownRemainingMinutes: Math.max(0, Math.ceil(cooldownMinutes - elapsed)) }
          : {}),
      };
    }
  }

  return { shouldNotify: true, fingerprint: current };
}
