import { type AppConfig, describeConfig } from './config/env.js';
import { type AvailabilityResult, checkAvailability } from './dian/availability.js';
import { DianNavigator } from './dian/navigator.js';
import { decideNotification, decideReporting } from './notifications/dedupe.js';
import { Notifier } from './notifications/notifier.js';
import type { RunReport } from './notifications/report.js';
import { createStorage } from './storage/index.js';
import type { MonitorState, StateStorage } from './storage/types.js';
import { captureDebugArtifacts, captureScreenshot } from './utils/debug.js';
import { CaptchaDetectedError, describeError, isMonitorError } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { withRetry } from './utils/retry.js';
import { isoNow } from './utils/time.js';

/**
 * Orchestration: navigate → detect → deduplicate → report → persist.
 * One run, one verdict, browser always closed via `finally`.
 *
 * Every execution produces a `RunReport`, but not every report is sent: the
 * monitor stays quiet while there is nothing new and speaks up when there is
 * availability, when it starts failing, or every `HEARTBEAT_EVERY_RUNS` runs so
 * that prolonged silence can only mean the cron itself stopped.
 */

/** Health markers, printed verbatim so Railway logs can be grepped. */
export const HEALTH = {
  noAvailability: 'MONITOR_OK_NO_AVAILABILITY',
  availability: 'MONITOR_OK_AVAILABILITY_FOUND',
  error: 'MONITOR_ERROR',
} as const;

export type HealthMarker = (typeof HEALTH)[keyof typeof HEALTH];

export interface MonitorOutcome {
  health: HealthMarker;
  result?: AvailabilityResult;
  notified: boolean;
  error?: string;
}

export async function runMonitor(
  config: AppConfig,
  storage: StateStorage = createStorage(config),
): Promise<MonitorOutcome> {
  logger.info('Iniciando monitor DIAN', describeConfig(config));
  if (config.dryRun) logger.warn('DRY_RUN activo: no se enviará ninguna notificación real');

  const navigator = new DianNavigator(config);
  const notifier = new Notifier(config);
  const previous = await storage.getLastState();
  warnIfCounterCannotPersist(config, previous);
  let errorScreenshot: string | undefined;

  try {
    const result = await withRetry(
      async (attempt) => {
        if (attempt > 1) {
          logger.info(`Reintentando el recorrido (intento ${attempt})`);
          await navigator.close();
        }
        await navigator.launch();
        try {
          await navigator.open();
          return await checkAvailability(navigator, config);
        } catch (error) {
          // Capture diagnostics here, while the page is still alive — after the
          // retry loop gives up the browser may already be gone.
          if (config.screenshotOnError) {
            const artifacts = await captureDebugArtifacts(
              navigator.currentPage,
              config.screenshotDir,
              `error-intento${attempt}`,
              error,
            );
            errorScreenshot = artifacts.screenshotPath ?? errorScreenshot;
          }
          throw error;
        }
      },
      { attempts: config.maxAttempts, label: 'Recorrido del portal' },
    );

    logFindings(result);

    if (!result.available) {
      logger.info('No existe disponibilidad', { motivo: result.reason });
      const decision = decideReporting({
        kind: 'unavailable',
        previous,
        heartbeatEveryRuns: config.heartbeatEveryRuns,
      });

      if (!decision.send) {
        logger.info('Sin novedad: no se envía mensaje', {
          ejecucion: decision.runNumber,
          resumenCada: config.heartbeatEveryRuns || 'nunca',
        });
        await persist(storage, { result, runsSinceLastReport: decision.runNumber, failed: false });
        return { health: HEALTH.noAvailability, result, notified: false };
      }

      logger.info('Enviando resumen periódico', { ejecucionesResumidas: decision.runNumber });
      const screenshotPath = await captureFinalScreenshot(navigator, config, result);
      const summary = await notifier.report({
        kind: 'unavailable',
        result,
        runsCovered: decision.runNumber,
        screenshotPath,
      });
      await persist(storage, { result, runsSinceLastReport: 0, failed: false });
      return { health: HEALTH.noAvailability, result, notified: summary.anyDelivered };
    }

    const screenshotPath = await captureFinalScreenshot(navigator, config, result);

    logger.success('Disponibilidad encontrada', {
      motivo: result.reason,
      fechas: result.dates.length,
      mensaje: result.message,
    });

    const decision = decideNotification(result, previous, config.cooldownMinutes);
    if (!decision.shouldNotify) {
      logger.info('Es la misma disponibilidad ya avisada', {
        motivo: decision.reason,
        minutosRestantes: decision.cooldownRemainingMinutes,
      });
    }

    // The alert always goes out — the dedup result only changes its wording.
    // Suppressing it entirely would break the "one message per run" contract.
    const summary = await notifier.report({
      kind: 'available',
      result,
      isRepeat: !decision.shouldNotify,
      screenshotPath,
    });

    await persist(storage, {
      result,
      runsSinceLastReport: 0,
      failed: false,
      fingerprint: decision.shouldNotify ? decision.fingerprint : null,
      notified: decision.shouldNotify && (summary.anyDelivered || config.dryRun),
    });

    return { health: HEALTH.availability, result, notified: summary.anyDelivered };
  } catch (error) {
    const outcome = handleFailure(error);
    const decision = decideReporting({
      kind: 'error',
      previous,
      heartbeatEveryRuns: config.heartbeatEveryRuns,
    });

    if (decision.send) {
      logger.info('Avisando del fallo', { motivo: decision.trigger });
      await reportFailure(notifier, outcome.error ?? 'Error desconocido', errorScreenshot, decision.runNumber);
    } else {
      logger.info('El fallo se repite: se avisará en el próximo resumen', {
        ejecucion: decision.runNumber,
      });
    }

    await persist(storage, {
      runsSinceLastReport: decision.send ? 0 : decision.runNumber,
      failed: true,
    });
    return outcome;
  } finally {
    await navigator.close();
  }
}

/**
 * Screenshot of the screen the run ended on. Taken whenever it will be used —
 * as a Telegram attachment or because `SCREENSHOT_ALWAYS` is set — and always
 * before the browser closes.
 */
async function captureFinalScreenshot(
  navigator: DianNavigator,
  config: AppConfig,
  result: AvailabilityResult,
): Promise<string | undefined> {
  const wanted =
    config.screenshotAlways || (config.telegram.enabled && config.telegram.sendScreenshot);
  if (!wanted) return undefined;

  const page = navigator.currentPage;
  if (!page) return undefined;

  const label = result.available ? 'disponible' : 'sin-disponibilidad';
  const path = await captureScreenshot(page, config.screenshotDir, label);
  if (path) logger.info('Captura de la pantalla final', { archivo: path });
  return path;
}

/** Notifying about a failure must never turn into a second failure. */
async function reportFailure(
  notifier: Notifier,
  error: string,
  screenshotPath: string | undefined,
  runsCovered: number,
): Promise<void> {
  const report: RunReport = { kind: 'error', error, runsCovered, screenshotPath };
  await notifier.report(report).catch((notifyError: unknown) => {
    logger.error('Tampoco se pudo avisar del fallo', { error: describeError(notifyError) });
  });
}

/** Prints exactly what the run saw — the audit trail for every execution. */
function logFindings(result: AvailabilityResult): void {
  logger.info('Resultado del recorrido', {
    disponible: result.available,
    motivo: result.reason,
    pasos: result.stepsCompleted.join(' → ') || '(ninguno)',
  });

  if (result.message) logger.info(`Mensaje del portal: "${result.message}"`);

  if (result.discoveredOptions.length > 0) {
    logger.info(`Opciones detectadas (${result.discoveredOptions.length}):`);
    for (const option of result.discoveredOptions) logger.info(`   · ${option}`);
  }

  if (result.dates.length > 0) {
    logger.info(`Fechas con cupo (${result.dates.length}):`);
    for (const date of result.dates) {
      const times = date.times.length > 0 ? date.times.join(', ') : '(sin horas listadas)';
      logger.info(`   · ${date.label || date.date} → ${times}`);
    }
  }
}

function handleFailure(error: unknown): MonitorOutcome {
  const message = describeError(error);

  if (error instanceof CaptchaDetectedError) {
    // Deliberate stop: this project does not attempt to bypass anti-bot checks.
    logger.error('Se detectó un mecanismo anti-bot; la ejecución se detiene de forma controlada', {
      detalle: error.details,
    });
  } else if (isMonitorError(error)) {
    logger.error(`Fallo del monitor [${error.code}]: ${error.message}`, { detalle: error.details });
  } else {
    logger.error(`Fallo inesperado: ${message}`);
  }

  return { health: HEALTH.error, notified: false, error: message };
}

/** Persists the run. `fingerprint` is only refreshed when we actually alerted. */
async function persist(
  storage: StateStorage,
  update: {
    result?: AvailabilityResult;
    runsSinceLastReport: number;
    failed: boolean;
    fingerprint?: string | null;
    notified?: boolean;
  },
): Promise<void> {
  try {
    const previous = await storage.getLastState();
    const { result } = update;
    await storage.saveState({
      fingerprint: update.fingerprint ?? previous?.fingerprint ?? '',
      notifiedAt: update.notified ? isoNow() : (previous?.notifiedAt ?? ''),
      lastRunAt: isoNow(),
      lastAvailable: result?.available ?? false,
      runsSinceLastReport: update.runsSinceLastReport,
      lastRunFailed: update.failed,
      summary: result
        ? `${result.reason}${result.dates.length > 0 ? ` (${result.dates.length} fecha/s)` : ''}`
        : 'ejecución fallida',
    });
  } catch (error) {
    // Losing the state only risks a duplicate alert — never fail the run for it.
    logger.warn('No se pudo guardar el estado', { error: describeError(error) });
  }
}

/**
 * The periodic summary counts runs, so it only works if the state survives
 * between executions. On Railway that means mounting a Volume; without one the
 * counter resets every time and the summary would never fire.
 */
function warnIfCounterCannotPersist(config: AppConfig, previous: MonitorState | null): void {
  if (config.heartbeatEveryRuns <= 1) return;
  if (config.storage.backend === 'memory') {
    logger.warn(
      `STATE_BACKEND=memory no conserva el contador: el resumen cada ${config.heartbeatEveryRuns} ` +
        'ejecuciones nunca se enviará. Usa STATE_BACKEND=json con un volumen persistente.',
    );
    return;
  }
  if (previous === null) {
    logger.info('Sin estado previo: esta es la primera ejecución (o el estado no se conserva)');
  }
}
