import { loadConfig } from './config/env.js';
import { HEALTH, runMonitor } from './monitor.js';
import { ConfigurationError, describeError } from './utils/errors.js';
import { createLogger } from './utils/logger.js';

/**
 * Entrypoint for a single run — start, check, notify if needed, exit.
 * Designed for Railway Cron: the process never stays resident.
 *
 * Exit codes:
 *   0 → the run completed (with or without availability)
 *   1 → the run failed (navigation, structure change, captcha, bad config)
 */
async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // The logger is not configured yet, so print directly.
    const message = error instanceof ConfigurationError ? error.message : describeError(error);
    console.error(`[CONFIG] ${message}`);
    console.log(HEALTH.error);
    return 1;
  }

  const logger = createLogger(config.logLevel);
  const startedAt = Date.now();

  const outcome = await runMonitor(config);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (outcome.health === HEALTH.error) {
    logger.error(`Ejecución finalizada con error en ${seconds}s`);
    console.log(HEALTH.error);
    return 1;
  }

  if (outcome.health === HEALTH.availability) {
    logger.success(`Ejecución finalizada en ${seconds}s`, { notificado: outcome.notified });
    console.log(HEALTH.availability);
    return 0;
  }

  logger.info(`Ejecución finalizada en ${seconds}s`);
  console.log(HEALTH.noAvailability);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[FATAL] ${describeError(error)}`);
    console.log(HEALTH.error);
    process.exitCode = 1;
  });
