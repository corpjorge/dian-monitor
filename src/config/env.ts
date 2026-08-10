import 'dotenv/config';
import { z } from 'zod';
import { ConfigurationError } from '../utils/errors.js';
import { registerSecret } from '../utils/logger.js';
import { splitList } from '../utils/text.js';

/**
 * Every knob of the monitor lives here. Nothing else in the codebase reads
 * `process.env` directly, so a new option only ever needs a line in this schema
 * and a line in `.env.example`.
 */

const booleanish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : /^(1|true|yes|si|sí|on)$/i.test(v.trim())));

const intWithDefault = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .refine((v) => Number.isFinite(v) && v >= min && v <= max, {
      message: `debe ser un número entre ${min} y ${max}`,
    });

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim());

const schema = z.object({
  // ---------------------------------------------------------------- portal
  DIAN_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : 'https://agendamiento.dian.gov.co/?recurso=CitasDIAN')),

  // -------------------------------------------------------- flow selection
  // Each value matches the visible label in the portal. Leave one empty to
  // stop the flow there (the monitor evaluates availability at that point).
  DIAN_TARGET_PERSON_TYPE: optionalText, // "Persona Natural"
  DIAN_TARGET_ATTENTION_TYPE: optionalText, // "Videoatención" | "Presencial"
  DIAN_TARGET_SERVICE: optionalText, // categoría: "Seleccione el tipo de servicio"
  DIAN_TARGET_PROCEDURE: optionalText, // trámite: select "Trámite"
  DIAN_TARGET_CITY: optionalText, // "Bogotá, D.C."
  DIAN_TARGET_OFFICE: optionalText, // sede
  /** How many calendar months to scan forward when the flow reaches the date step. */
  DIAN_SCAN_MONTHS: intWithDefault(2, 1, 12),
  /**
   * Modal text the portal shows when the chosen combination has no queues.
   * Seeing exactly this message means "no availability"; anything else is
   * treated as a change worth notifying.
   */
  DIAN_NO_AVAILABILITY_MESSAGE: z
    .string()
    .optional()
    .transform((v) =>
      v && v.trim() !== ''
        ? v.trim()
        : 'No se encontraron especialidades relacionadas según los filtros seleccionados.',
    ),

  // ----------------------------------------------------------- notifications
  RESEND_API_KEY: optionalText,
  EMAIL_FROM: optionalText,
  EMAIL_TO: optionalText,
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_CHAT_IDS: optionalText,
  /** Adjunta la captura de la pantalla final a cada mensaje de Telegram. */
  TELEGRAM_SEND_SCREENSHOT: booleanish(true),
  /**
   * Cada cuántas ejecuciones enviar un resumen por Telegram aunque no haya
   * novedad, para confirmar que el monitor sigue vivo.
   * 1 = en cada ejecución · 0 = nunca (sólo avisa cuando hay cita).
   * Requiere que el estado se conserve entre ejecuciones (ver README).
   */
  HEARTBEAT_EVERY_RUNS: intWithDefault(50, 0, 5_000),

  // ------------------------------------------------------------- behaviour
  HEADLESS: booleanish(true),
  DRY_RUN: booleanish(false),
  SCREENSHOT_ON_ERROR: booleanish(true),
  SCREENSHOT_ALWAYS: booleanish(false),
  NOTIFICATION_COOLDOWN_MINUTES: intWithDefault(60, 0, 10_080),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .optional()
    .transform((v) => v ?? 'info'),

  // --------------------------------------------------------------- timing
  NAV_TIMEOUT_MS: intWithDefault(90_000, 5_000, 300_000),
  STEP_TIMEOUT_MS: intWithDefault(45_000, 2_000, 180_000),
  MAX_ATTEMPTS: intWithDefault(3, 1, 5),

  // -------------------------------------------------------------- storage
  STATE_BACKEND: z
    .enum(['json', 'memory'])
    .optional()
    .transform((v) => v ?? 'json'),
  STATE_FILE_PATH: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : 'data/state.json')),

  // ------------------------------------------------------------ artifacts
  SCREENSHOT_DIR: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : 'screenshots')),
});

export interface AppConfig {
  url: string;
  target: {
    personType: string;
    attentionType: string;
    service: string;
    procedure: string;
    city: string;
    office: string;
    scanMonths: number;
    noAvailabilityMessage: string;
  };
  email: { apiKey: string; from: string; to: string[]; enabled: boolean };
  telegram: { botToken: string; chatIds: string[]; enabled: boolean; sendScreenshot: boolean };
  heartbeatEveryRuns: number;
  headless: boolean;
  dryRun: boolean;
  screenshotOnError: boolean;
  screenshotAlways: boolean;
  screenshotDir: string;
  cooldownMinutes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  navTimeoutMs: number;
  stepTimeoutMs: number;
  maxAttempts: number;
  storage: { backend: 'json' | 'memory'; filePath: string };
}

/**
 * Validates the environment and returns a typed config.
 * Throws `ConfigurationError` with a readable summary when something is wrong.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`);
    throw new ConfigurationError(`Variables de entorno inválidas:\n${issues.join('\n')}`);
  }
  const e = parsed.data;

  registerSecret(e.RESEND_API_KEY);
  registerSecret(e.TELEGRAM_BOT_TOKEN);

  const emailTo = splitList(e.EMAIL_TO);
  const chatIds = splitList(e.TELEGRAM_CHAT_IDS);

  const config: AppConfig = {
    url: e.DIAN_URL,
    target: {
      personType: e.DIAN_TARGET_PERSON_TYPE,
      attentionType: e.DIAN_TARGET_ATTENTION_TYPE,
      service: e.DIAN_TARGET_SERVICE,
      procedure: e.DIAN_TARGET_PROCEDURE,
      city: e.DIAN_TARGET_CITY,
      office: e.DIAN_TARGET_OFFICE,
      scanMonths: e.DIAN_SCAN_MONTHS,
      noAvailabilityMessage: e.DIAN_NO_AVAILABILITY_MESSAGE,
    },
    email: {
      apiKey: e.RESEND_API_KEY,
      from: e.EMAIL_FROM,
      to: emailTo,
      enabled: Boolean(e.RESEND_API_KEY && e.EMAIL_FROM && emailTo.length > 0),
    },
    telegram: {
      botToken: e.TELEGRAM_BOT_TOKEN,
      chatIds,
      enabled: Boolean(e.TELEGRAM_BOT_TOKEN && chatIds.length > 0),
      sendScreenshot: e.TELEGRAM_SEND_SCREENSHOT,
    },
    heartbeatEveryRuns: e.HEARTBEAT_EVERY_RUNS,
    headless: e.HEADLESS,
    dryRun: e.DRY_RUN,
    screenshotOnError: e.SCREENSHOT_ON_ERROR,
    screenshotAlways: e.SCREENSHOT_ALWAYS,
    screenshotDir: e.SCREENSHOT_DIR,
    cooldownMinutes: e.NOTIFICATION_COOLDOWN_MINUTES,
    logLevel: e.LOG_LEVEL,
    navTimeoutMs: e.NAV_TIMEOUT_MS,
    stepTimeoutMs: e.STEP_TIMEOUT_MS,
    maxAttempts: e.MAX_ATTEMPTS,
    storage: { backend: e.STATE_BACKEND, filePath: e.STATE_FILE_PATH },
  };

  assertUsable(config);
  return config;
}

/** Fails fast on combinations that would silently do nothing useful. */
function assertUsable(config: AppConfig): void {
  if (!config.target.personType) {
    throw new ConfigurationError('DIAN_TARGET_PERSON_TYPE es obligatorio (ej. "Persona Natural").');
  }
  if (!config.target.attentionType) {
    throw new ConfigurationError('DIAN_TARGET_ATTENTION_TYPE es obligatorio (ej. "Videoatención").');
  }
  if (config.email.apiKey && !config.email.from) {
    throw new ConfigurationError('RESEND_API_KEY está definido pero falta EMAIL_FROM.');
  }
  if (config.email.apiKey && config.email.to.length === 0) {
    throw new ConfigurationError('RESEND_API_KEY está definido pero EMAIL_TO está vacío.');
  }
  if (config.telegram.botToken && config.telegram.chatIds.length === 0) {
    throw new ConfigurationError('TELEGRAM_BOT_TOKEN está definido pero TELEGRAM_CHAT_IDS está vacío.');
  }
}

/** Config summary safe to print (no secrets). */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    url: config.url,
    persona: config.target.personType,
    modalidad: config.target.attentionType,
    servicio: config.target.service || '(no configurado)',
    tramite: config.target.procedure || '(no configurado)',
    ciudad: config.target.city || '(no configurado)',
    sede: config.target.office || '(no configurado)',
    headless: config.headless,
    dryRun: config.dryRun,
    email: config.email.enabled ? `${config.email.to.length} destinatario(s)` : 'deshabilitado',
    telegram: config.telegram.enabled ? `${config.telegram.chatIds.length} chat(s)` : 'deshabilitado',
    resumenCada: config.heartbeatEveryRuns > 0 ? `${config.heartbeatEveryRuns} ejecuciones` : 'nunca',
    almacenamiento: config.storage.backend,
  };
}
