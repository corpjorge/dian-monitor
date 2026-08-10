/**
 * All user-facing timestamps are rendered in Colombian time (America/Bogota).
 * Internally the code always passes `Date` objects (UTC epoch) around.
 */

export const COLOMBIA_TZ = 'America/Bogota';

const partsFormatter = new Intl.DateTimeFormat('es-CO', {
  timeZone: COLOMBIA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function parts(date: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** `2026-08-09 23:00:00` in Colombian time — used by the logger. */
export function formatTimestamp(date: Date = new Date()): string {
  const p = parts(date);
  // Intl can emit "24" for midnight in some runtimes; normalize it to "00".
  const hour = p['hour'] === '24' ? '00' : (p['hour'] ?? '00');
  return `${p['year']}-${p['month']}-${p['day']} ${hour}:${p['minute']}:${p['second']}`;
}

/** Long human form, e.g. `domingo, 9 de agosto de 2026, 11:00 p. m.`. */
export function formatHuman(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: COLOMBIA_TZ,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date);
}

/** Machine-readable instant (UTC) for stored state and JSON payloads. */
export function isoNow(date: Date = new Date()): string {
  return date.toISOString();
}

/** Filesystem-safe stamp for screenshots: `2026-08-09T23-00-00-123Z`. */
export function fileStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function minutesSince(iso: string, now: Date = new Date()): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 60_000;
}
