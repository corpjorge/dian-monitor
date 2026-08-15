import type { AvailabilityResult } from '../dian/availability.js';
import { formatHuman } from '../utils/time.js';
import type { RunReport } from './report.js';

/**
 * Message construction — pure functions, no I/O, fully unit-testable.
 * Both channels render the same facts so an alert reads identically whether it
 * arrives by email or Telegram.
 */

const PORTAL_URL = 'https://agendamiento.dian.gov.co/';

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

const REASON_LABEL: Record<string, string> = {
  'fechas-encontradas': 'Se encontraron fechas con cupo disponible.',
  'flujo-avanzo': 'El portal habilitó el siguiente paso del flujo en lugar del mensaje de "sin especialidades".',
  'mensaje-desconocido': 'El portal mostró un mensaje distinto al habitual.',
  'sin-fechas-en-calendario': 'El flujo avanzó pero el calendario no ofrece días.',
  'sin-especialidades': 'No hay especialidades para los filtros seleccionados.',
};

function detectedAtLabel(result: AvailabilityResult): string {
  const parsed = new Date(result.detectedAt);
  return Number.isNaN(parsed.getTime()) ? result.detectedAt : formatHuman(parsed);
}

/** `Bogotá, D.C.` or a fallback when the flow stops before choosing a city. */
function cityLabel(result: AvailabilityResult): string {
  return result.city || '(no aplica en este punto del flujo)';
}

function valueOrDash(value: string): string {
  return value.trim() === '' ? '—' : value;
}

function datesAsText(result: AvailabilityResult): { dates: string; times: string } {
  if (result.dates.length === 0) {
    return { dates: 'Por confirmar en el portal', times: 'Por confirmar en el portal' };
  }
  const dates = result.dates.map((d) => d.label || d.date).join('\n');
  const times = result.dates
    .map((d) => `${d.label || d.date}: ${d.times.length > 0 ? d.times.join(', ') : 'sin horas listadas'}`)
    .join('\n');
  return { dates, times };
}

export function buildEmailSubject(result: AvailabilityResult): string {
  const place = result.city || result.attentionType;
  return `🚨 Cita DIAN disponible - ${place}`;
}

export function buildEmail(result: AvailabilityResult): BuiltEmail {
  const { dates, times } = datesAsText(result);
  const detected = detectedAtLabel(result);
  const reason = REASON_LABEL[result.reason] ?? result.reason;

  const rows: Array<[string, string]> = [
    ['Ciudad', cityLabel(result)],
    ['Tipo de persona', valueOrDash(result.personType)],
    ['Modalidad', valueOrDash(result.attentionType)],
    ['Tipo de servicio', valueOrDash(result.service)],
    ['Trámite', valueOrDash(result.procedure)],
    ['Sede', valueOrDash(result.office)],
    ['Fecha(s)', dates],
    ['Hora(s)', times],
    ['Detectado', detected],
  ];

  if (result.message) rows.push(['Mensaje del portal', result.message]);
  if (result.discoveredOptions.length > 0) {
    rows.push(['Opciones detectadas', result.discoveredOptions.join('\n')]);
  }

  const text = [
    'Se encontró disponibilidad de cita DIAN.',
    '',
    reason,
    '',
    ...rows.map(([label, value]) => `${label}:\n${value}\n`),
    `Portal DIAN:\n${PORTAL_URL}`,
    '',
    'Ingresa cuanto antes porque la disponibilidad puede cambiar.',
  ].join('\n');

  const html = renderHtml(rows, reason);
  return { subject: buildEmailSubject(result), text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(rows: Array<[string, string]>, reason: string): string {
  const cells = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #eef0f4;color:#5b6472;font-size:13px;
                     text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;vertical-align:top;">
            ${escapeHtml(label)}
          </td>
          <td style="padding:10px 14px;border-bottom:1px solid #eef0f4;color:#1f2430;font-size:15px;
                     font-weight:600;white-space:pre-line;">
            ${escapeHtml(value)}
          </td>
        </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f6f7f9;
               font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0"
           style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;
                  box-shadow:0 1px 3px rgba(16,24,40,.08);">
      <tr>
        <td style="background:#41d78c;padding:22px 24px;">
          <h1 style="margin:0;color:#0b2b1c;font-size:20px;">🚨 Cita DIAN disponible</h1>
          <p style="margin:6px 0 0;color:#0b2b1c;font-size:14px;opacity:.85;">${escapeHtml(reason)}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 10px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
            ${cells}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 24px 26px;">
          <a href="${PORTAL_URL}"
             style="display:inline-block;background:#2b6cb0;color:#ffffff;text-decoration:none;
                    padding:12px 20px;border-radius:8px;font-weight:600;font-size:15px;">
            Abrir el portal de la DIAN
          </a>
          <p style="margin:16px 0 0;color:#5b6472;font-size:13px;line-height:1.5;">
            Ingresa cuanto antes porque la disponibilidad puede cambiar en minutos.<br>
            Este mensaje lo envía tu monitor automático; no reserva ninguna cita por ti.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Escapes the three characters Telegram's HTML mode treats specially.
 *
 * The message embeds text written by DIAN (trámite names, modal messages),
 * which regularly contains quotes and parentheses. HTML mode is used instead of
 * Markdown precisely because an unmatched `_` or `*` in that text would make
 * Telegram reject the whole message with a parse error.
 */
export function escapeTelegram(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Common header lines: which combination is being watched. */
function telegramFilters(result: AvailabilityResult): string[] {
  const e = escapeTelegram;
  const lines: string[] = [];
  if (result.city) lines.push(`📍 ${e(result.city)}`);
  lines.push(`👤 ${e(valueOrDash(result.personType))}`);
  lines.push(`💻 ${e(valueOrDash(result.attentionType))}`);
  lines.push(`🗂 ${e(valueOrDash(result.service))}`);
  if (result.procedure) lines.push(`📋 ${e(result.procedure)}`);
  if (result.office) lines.push(`🏢 ${e(result.office)}`);
  return lines;
}

/**
 * Single entry point for Telegram. Every run produces a report, so the builder
 * covers the quiet outcome too — that message is what tells you the monitor is
 * still alive and still watching the right thing.
 */
export function buildTelegramReport(report: RunReport): string {
  switch (report.kind) {
    case 'available':
      return buildTelegramMessage(report.result, report.isRepeat);
    case 'unavailable':
      return buildTelegramNoAvailability(report.result, report.runsCovered ?? 1);
    case 'error':
      return buildTelegramError(report.error, report.runsCovered ?? 1);
  }
}

/**
 * The periodic "still nothing" summary. It exists so that silence can only mean
 * one thing: the cron stopped running.
 */
export function buildTelegramNoAvailability(result: AvailabilityResult, runsCovered = 1): string {
  const e = escapeTelegram;
  const lines = ['<b>🔍 Sigo vigilando — sin cupo todavía</b>', '', ...telegramFilters(result)];

  if (result.message) {
    lines.push('', `💬 ${e(result.message)}`);
  } else if (result.reason === 'sin-fechas-en-calendario') {
    lines.push('', '💬 El calendario no ofrece ningún día con cupo.');
  }

  lines.push(
    '',
    `🔁 ${revisionsLabel(runsCovered)}`,
    `Revisado: ${e(detectedAtLabel(result))}`,
    `👉 ${PORTAL_URL}`,
  );
  return lines.join('\n');
}

/** "50 revisiones sin novedad" / "1 revisión sin novedad". */
function revisionsLabel(runs: number): string {
  return runs === 1 ? '1 revisión sin novedad' : `${runs} revisiones sin novedad`;
}

/** Sent when the run itself failed — so silence never looks like "no hay cupo". */
export function buildTelegramError(error: string, runsCovered = 1): string {
  const e = escapeTelegram;
  const lines = [
    '<b>⚠️ El monitor no pudo completar la revisión</b>',
    '',
    `💬 ${e(error)}`,
    '',
    'No se pudo comprobar la disponibilidad en esta ejecución.',
  ];
  if (runsCovered > 1) lines.push(`🔁 Lleva ${runsCovered} ejecuciones fallando.`);
  lines.push(`Ocurrió: ${e(formatHuman(new Date()))}`, `👉 ${PORTAL_URL}`);
  return lines.join('\n');
}

export function buildTelegramMessage(result: AvailabilityResult, isRepeat = false): string {
  const e = escapeTelegram;
  const lines = [
    '<b>🚨 CITA DIAN DISPONIBLE</b>',
    '',
    ...telegramFilters(result),
  ];

  if (isRepeat) lines.push('', 'ℹ️ Es la misma disponibilidad del aviso anterior.');

  if (result.dates.length > 0) {
    lines.push('');
    for (const date of result.dates) {
      lines.push(`📅 ${e(date.label || date.date)}`);
      lines.push(`🕐 ${e(date.times.length > 0 ? date.times.join(', ') : 'horas por confirmar')}`);
    }
  } else if (result.message) {
    lines.push('', `💬 ${e(result.message)}`);
  }

  if (result.discoveredOptions.length > 0) {
    lines.push('', `🔎 Opciones detectadas: ${e(result.discoveredOptions.join(' · '))}`);
  }

  lines.push('', `Detectado: ${e(detectedAtLabel(result))}`, `👉 ${PORTAL_URL}`);
  return lines.join('\n');
}
