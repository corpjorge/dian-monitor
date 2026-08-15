import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { PortalNotSettledError } from '../utils/errors.js';
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
 * The rule is deliberately *not* "search for the word 'disponible'", and just as
 * deliberately *not* "no modal appeared in N seconds". The portal answers every
 * selection in exactly one of two ways, and the monitor waits for one of them:
 *
 *  1. A modal. With the exact text configured in `DIAN_NO_AVAILABILITY_MESSAGE`
 *     ("No se encontraron especialidades relacionadas según los filtros
 *     seleccionados.") it means there is nothing — that is what the target
 *     combination (Persona Natural → Videoatención → Devoluciones) shows today.
 *     Any *other* message means the portal is saying something new → alert.
 *  2. The next control, populated. The combination opened up: choosing
 *     "Devoluciones" reveals the "Trámite" select with real options. When the
 *     configuration goes deeper, the calendar is then read for dates and times.
 *
 * Anything else — the "Cargando" overlay still up, the splash back on screen,
 * the portal simply not responding — is *no answer at all*, and produces
 * `PortalNotSettledError` rather than a verdict. Treating silence as good news
 * is what alerted on a loading screen.
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
  /** How long to wait for the portal to answer one selection. */
  settleTimeoutMs?: number;
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
  const settleTimeoutMs = options.settleTimeoutMs ?? config.stepTimeoutMs;
  const steps = buildFlow(config);
  const completed: string[] = [];
  const base = baseResult(config);
  let discovered: string[] = [];

  await navigator.startScheduling();

  for (const [index, step] of steps.entries()) {
    await navigator.applyStep(step);
    completed.push(`${step.title}=${step.value}`);

    // The control this selection should reveal when there is something behind
    // it: the next configured step, or — on the last one — whatever the portal
    // would show next. Undefined only when the flow already reaches the
    // calendar, where the dates themselves are the evidence.
    const following = steps[index + 1] ?? nextControlAfter(steps);

    // A step that changes screen reveals nothing by itself, so there we only
    // wait for the portal to go quiet without a modal, click "Siguiente", and
    // look for the new control afterwards.
    const answer = await answerAfter(
      navigator,
      step.advancesScreen ? undefined : following,
      settleTimeoutMs,
      step.title,
    );
    if (answer.kind === 'modal') return verdictFromModal(base, answer.message, config, completed);
    let revealed = answer.options;

    if (step.advancesScreen) {
      await navigator.advance();
      const afterAdvance = await answerAfter(navigator, following, settleTimeoutMs, 'Siguiente');
      if (afterAdvance.kind === 'modal') {
        return verdictFromModal(base, afterAdvance.message, config, completed);
      }
      revealed = afterAdvance.options;
    }

    if (index === steps.length - 1) discovered = revealed;
  }

  // The portal revealed the next step instead of the "sin especialidades"
  // modal: the combination is open.
  logger.success('El portal habilitó el siguiente paso del flujo');
  if (discovered.length > 0) {
    logger.info('Opciones visibles tras el último paso', { total: discovered.length });
  }

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

/**
 * One of the portal's two possible answers to a selection. There is no third
 * member on purpose: "still loading" is not an answer, it is a reason to keep
 * waiting (and, past the deadline, to fail the run).
 */
export type PortalAnswer =
  | { kind: 'modal'; message: string }
  | { kind: 'revealed'; options: string[] };

/**
 * What `waitForAnswer` needs from the page. Narrow on purpose: it keeps the
 * waiting rule — the part that decides whether an alert goes out — testable
 * without a browser.
 */
export interface PortalProbe {
  /** True while the "Cargando" overlay or the splash covers the page. */
  isBusy(): Promise<boolean>;
  /** Text of the visible modal, or null when there is none. */
  modalMessage(): Promise<string | null>;
  /**
   * Options of the control this selection should reveal. `null` when there is
   * no such control to look at, in which case going quiet is answer enough.
   */
  revealedOptions(): Promise<string[] | null>;
  wait(ms: number): Promise<void>;
}

/** How often the portal is re-checked while it is still working. */
const POLL_MS = 300;

/**
 * Waits for the portal's answer on a real page.
 *
 * `expected` is the control this selection should reveal; when it is undefined
 * there is nothing to look for — the portal going quiet without a modal is the
 * whole answer (the step that only unlocks "Siguiente", or the last one before
 * the calendar).
 */
async function answerAfter(
  navigator: DianNavigator,
  expected: FlowStep | undefined,
  timeoutMs: number,
  stepTitle: string,
): Promise<PortalAnswer> {
  const busy = navigator.busy();
  const modal = navigator.modal();

  const probe: PortalProbe = {
    isBusy: () => busy.isBusy(),
    modalMessage: () => modal.message(),
    revealedOptions: async () => {
      if (!expected) return null;
      const options = await navigator.optionsOf(expected).catch(() => [] as ControlOption[]);
      return options.map((o) => o.label);
    },
    wait: (ms) => navigator.wait(ms),
  };

  return waitForAnswer(probe, timeoutMs, () => ({
    paso: stepTitle,
    esperaba: expected ? expected.title : '(sólo que el portal terminara)',
  }));
}

/**
 * Polls until the portal actually answers, and refuses to invent an answer.
 *
 * The order matters: nothing on screen is read while the portal is busy, so a
 * half-drawn wizard behind the overlay can never be mistaken for progress.
 */
export async function waitForAnswer(
  probe: PortalProbe,
  timeoutMs: number,
  describe: () => Record<string, unknown> = () => ({}),
): Promise<PortalAnswer> {
  const deadline = Date.now() + timeoutMs;
  let sawBusy = false;

  for (;;) {
    if (await probe.isBusy()) {
      sawBusy = true;
    } else {
      const message = await probe.modalMessage();
      if (message) return { kind: 'modal', message };

      const options = await probe.revealedOptions();
      if (options === null) return { kind: 'revealed', options: [] };
      if (options.length > 0) return { kind: 'revealed', options };
    }

    if (Date.now() >= deadline) {
      throw new PortalNotSettledError(
        'El portal no respondió a la selección: se quedó cargando y no mostró ni el mensaje ' +
          'habitual ni el siguiente paso.',
        { ...describe(), pantallaDeCargaVista: sawBusy, esperaMs: timeoutMs },
      );
    }
    await probe.wait(POLL_MS);
  }
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

/** The control the portal would reveal next, given the configured steps. */
export function nextControlAfter(steps: FlowStep[]): FlowStep | undefined {
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
