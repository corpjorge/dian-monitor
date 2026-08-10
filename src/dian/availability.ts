import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { normalize } from '../utils/text.js';
import { isoNow } from '../utils/time.js';
import type { AvailableDate, ControlOption } from './controls.js';
import { timeOptionMatchesDate } from './controls.js';
import { CONTROL } from './selectors.js';
import { type FlowStep, buildFlow, flowReachesCalendar } from './flow.js';
import type { DianNavigator } from './navigator.js';

/**
 * Availability detection.
 *
 * The rule is deliberately *not* "search for the word 'disponible'". The portal
 * signals the absence of appointments structurally:
 *
 *  1. A modal appears with the exact text configured in
 *     `DIAN_NO_AVAILABILITY_MESSAGE` ("No se encontraron especialidades
 *     relacionadas según los filtros seleccionados."). That is the *only*
 *     unambiguous "nothing here" signal, and it is what the target combination
 *     (Persona Natural → Videoatención → Devoluciones) shows today.
 *  2. Any other modal message means the portal is saying something new →
 *     treated as a change worth notifying, flagged as `unknown-message`.
 *  3. No modal at all means the flow moved forward: the combination opened up.
 *     When the configuration goes deep enough, the calendar is then read to
 *     extract concrete dates and times.
 */

export interface AvailabilitySlotDate {
  /** ISO date, `2026-08-12`. */
  date: string;
  /** Spanish label as shown by the portal. */
  label: string;
  /** Times found for this date, e.g. `["8:00 AM", "9:15 AM"]`. */
  times: string[];
}

export type AvailabilityReason =
  | 'sin-especialidades'
  | 'mensaje-desconocido'
  | 'flujo-avanzo'
  | 'fechas-encontradas'
  | 'sin-fechas-en-calendario';

export interface AvailabilityResult {
  available: boolean;
  detectedAt: string;
  city: string;
  procedure: string;
  service: string;
  attentionType: string;
  personType: string;
  office: string;
  dates: AvailabilitySlotDate[];
  /** Why the monitor concluded what it concluded — shown in logs and alerts. */
  reason: AvailabilityReason;
  /** Modal text when the portal displayed one. */
  message?: string;
  /** Steps completed before the verdict, for traceability. */
  stepsCompleted: string[];
  /** Options offered by the last control reached (helps spot new trámites). */
  discoveredOptions: string[];
}

export interface CheckOptions {
  /** How long to wait for the portal's modal after a selection. */
  modalWaitMs?: number;
}

/**
 * Walks the configured flow and returns a structured verdict.
 * Never books anything: it stops as soon as it can decide.
 */
export async function checkAvailability(
  navigator: DianNavigator,
  config: AppConfig,
  options: CheckOptions = {},
): Promise<AvailabilityResult> {
  const modalWaitMs = options.modalWaitMs ?? 6_000;
  const steps = buildFlow(config);
  const completed: string[] = [];
  const base = baseResult(config);

  await navigator.startScheduling();

  for (const [index, step] of steps.entries()) {
    await navigator.applyStep(step);
    completed.push(`${step.title}=${step.value}`);

    // After each selection the portal may answer with a modal.
    const message = await navigator.modal().waitForMessage(index === steps.length - 1 ? modalWaitMs : 1_500);
    if (message) {
      return verdictFromModal(base, message, config, completed);
    }

    if (step.advancesScreen && index < steps.length - 1) {
      await navigator.advance();
      const afterAdvance = await navigator.modal().waitForMessage(1_500);
      if (afterAdvance) return verdictFromModal(base, afterAdvance, config, completed);
    }
  }

  // No modal: the combination is open. Collect everything we can see.
  const discovered = await describeNextControl(navigator, steps);
  logger.success('El flujo avanzó sin el mensaje de "sin especialidades"');

  if (!flowReachesCalendar(config)) {
    return {
      ...base,
      available: true,
      reason: 'flujo-avanzo',
      stepsCompleted: completed,
      discoveredOptions: discovered,
    };
  }

  const dates = await readCalendar(navigator, config);
  return {
    ...base,
    available: dates.length > 0,
    reason: dates.length > 0 ? 'fechas-encontradas' : 'sin-fechas-en-calendario',
    dates,
    stepsCompleted: completed,
    discoveredOptions: discovered,
  };
}

function baseResult(config: AppConfig): AvailabilityResult {
  return {
    available: false,
    detectedAt: isoNow(),
    city: config.target.city,
    procedure: config.target.procedure,
    service: config.target.service,
    attentionType: config.target.attentionType,
    personType: config.target.personType,
    office: config.target.office,
    dates: [],
    reason: 'sin-especialidades',
    stepsCompleted: [],
    discoveredOptions: [],
  };
}

/** Turns a modal message into a verdict, per the rules documented above. */
function verdictFromModal(
  base: AvailabilityResult,
  message: string,
  config: AppConfig,
  completed: string[],
): AvailabilityResult {
  const isKnownEmpty = normalize(message) === normalize(config.target.noAvailabilityMessage);

  if (isKnownEmpty) {
    logger.info('El portal informó que no hay especialidades para los filtros seleccionados');
    return { ...base, available: false, reason: 'sin-especialidades', message, stepsCompleted: completed };
  }

  logger.success(`El portal mostró un mensaje distinto al habitual: "${message}"`);
  return { ...base, available: true, reason: 'mensaje-desconocido', message, stepsCompleted: completed };
}

/** Reads the options of the control right after the last completed step. */
async function describeNextControl(navigator: DianNavigator, steps: FlowStep[]): Promise<string[]> {
  const nextControl = nextControlAfter(steps);
  if (!nextControl) return [];
  const options = await navigator
    .optionsOf(nextControl)
    .catch(() => [] as ControlOption[]);
  if (options.length > 0) {
    logger.info(`Opciones visibles en "${nextControl.title}"`, { total: options.length });
  }
  return options.map((o) => o.label);
}

/** The control the portal would reveal next, given the configured steps. */
function nextControlAfter(steps: FlowStep[]): FlowStep | undefined {
  const order: FlowStep[] = [
    { title: 'Tipo de servicio', control: CONTROL.service, kind: 'buttons', value: '' },
    { title: 'Trámite', control: CONTROL.procedure, kind: 'select', value: '' },
    { title: 'Ciudad', control: CONTROL.city, kind: 'select', value: '' },
    { title: 'Sede', control: CONTROL.office, kind: 'select', value: '' },
  ];
  const done = new Set(steps.map((s) => s.control));
  return order.find((s) => !done.has(s.control));
}

/**
 * Reads the calendar and, for each enabled day, the times offered.
 * Scans up to `DIAN_SCAN_MONTHS` months forward.
 */
async function readCalendar(navigator: DianNavigator, config: AppConfig): Promise<AvailabilitySlotDate[]> {
  const calendar = navigator.calendar();
  // The calendar renders a moment after the office is chosen, so wait for it
  // instead of probing once and giving up.
  try {
    await calendar.waitUntilReady();
  } catch {
    logger.warn('No se encontró el calendario en pantalla');
    return [];
  }

  const results: AvailabilitySlotDate[] = [];

  for (let month = 0; month < config.target.scanMonths; month++) {
    const monthLabel = await calendar.currentMonth();
    const days = await calendar.availableDates();
    logger.info(`Calendario ${monthLabel}: ${days.length} día(s) con cupo`);

    for (const day of days) {
      const times = await readTimesForDate(navigator, day);
      results.push({ date: day.iso, label: day.label, times });
    }

    if (month < config.target.scanMonths - 1) {
      const moved = await calendar.goToNextMonth();
      if (!moved) break;
    }
  }

  return results;
}

/**
 * Selects a date and lists the times the portal returns for it.
 *
 * Both halves are verified: the calendar must confirm the date was committed,
 * and the time options must actually belong to that date (their value encodes
 * it). Without those checks the portal's lag can attach one day's times to the
 * next day — an alert that reads plausibly and is wrong.
 */
async function readTimesForDate(navigator: DianNavigator, date: AvailableDate): Promise<string[]> {
  const calendar = navigator.calendar();
  try {
    const selected = await calendar.selectDate(date);
    if (!selected) {
      logger.warn(`No se pudo seleccionar la fecha ${date.label}; se omiten sus horas`);
      return [];
    }

    const times = navigator.dropdown(CONTROL.time);
    const deadline = Date.now() + TIMES_TIMEOUT_MS;
    for (;;) {
      if (await times.isPresent()) {
        const options = await times.options();
        if (options.length > 0 && options.every((o) => timeOptionMatchesDate(o.key, date.iso))) {
          return options.map((o) => o.label);
        }
      }
      if (Date.now() >= deadline) {
        logger.warn(`Las horas de ${date.label} no se cargaron a tiempo`);
        return [];
      }
      await navigator.wait(400);
    }
  } catch (error) {
    logger.warn(`No se pudieron leer las horas de ${date.label}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** How long to wait for the times of one date before giving up on it. */
const TIMES_TIMEOUT_MS = 15_000;

/**
 * Stable fingerprint of a result. Two runs that found exactly the same
 * availability produce the same hash, which is what suppresses duplicate
 * alerts. Any new date, new time or different message changes it.
 */
export function fingerprint(result: AvailabilityResult): string {
  const payload = [
    normalize(result.city),
    normalize(result.office),
    normalize(result.service),
    normalize(result.procedure),
    normalize(result.attentionType),
    normalize(result.personType),
    result.reason,
    normalize(result.message ?? ''),
    result.dates
      .map((d) => `${d.date}:${[...d.times].sort().join('|')}`)
      .sort()
      .join(';'),
  ].join('||');

  return createHash('sha256').update(payload).digest('hex');
}
