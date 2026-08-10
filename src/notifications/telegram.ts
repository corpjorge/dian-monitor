import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/env.js';
import { NotificationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { buildTelegramReport } from './messages.js';
import type { RunReport } from './report.js';

/**
 * Telegram delivery through the Bot API (plain `fetch`, no SDK needed).
 * Each chat is sent independently so one bad chat id cannot silence the rest.
 *
 * When a screenshot is available the report goes out as a photo with the text
 * as its caption — one message, image and all. Telegram caps captions at 1024
 * characters, so a long report (many dates and times) is split into the photo
 * plus a follow-up text message instead of being silently truncated.
 */
const CAPTION_LIMIT = 1024;

export class TelegramNotifier {
  readonly channel = 'telegram';

  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean {
    return this.config.telegram.enabled;
  }

  private get apiBase(): string {
    return `https://api.telegram.org/bot${this.config.telegram.botToken}`;
  }

  async send(report: RunReport): Promise<void> {
    if (!this.enabled) {
      logger.debug('Telegram deshabilitado (faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS)');
      return;
    }

    const text = buildTelegramReport(report);
    const photo = this.config.telegram.sendScreenshot ? report.screenshotPath : undefined;
    const chatIds = this.config.telegram.chatIds;

    if (this.config.dryRun) {
      logger.info(`[DRY_RUN] Telegram NO enviado a ${chatIds.length} chat(s)`, {
        chats: chatIds.join(', '),
        captura: photo ?? '(sin captura)',
      });
      logger.debug(`[DRY_RUN] Mensaje de Telegram:\n${text}`);
      return;
    }

    logger.info(`Enviando Telegram a ${chatIds.length} chat(s)`, { captura: photo ? 'sí' : 'no' });
    const failures: string[] = [];

    for (const chatId of chatIds) {
      try {
        await withRetry(() => this.deliver(chatId, text, photo), {
          attempts: this.config.maxAttempts,
          label: `Telegram (chat ${chatId})`,
          shouldRetry: () => true,
        });
        logger.success('Telegram enviado', { chat: chatId });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`Fallo al enviar Telegram al chat ${chatId}`, { error: detail });
        failures.push(chatId);
      }
    }

    if (failures.length === chatIds.length) {
      throw new NotificationError('telegram', 'No se pudo enviar a ningún chat de Telegram.', {
        chats: failures,
      });
    }
  }

  /** Sends the report as a photo when possible, falling back to plain text. */
  private async deliver(chatId: string, text: string, photoPath: string | undefined): Promise<void> {
    if (!photoPath) {
      await this.sendMessage(chatId, text);
      return;
    }

    try {
      const fits = text.length <= CAPTION_LIMIT;
      await this.sendPhoto(chatId, photoPath, fits ? text : truncateCaption(text));
      // The caption could not hold the whole report: send the rest separately.
      if (!fits) await this.sendMessage(chatId, text);
    } catch (error) {
      // A missing or oversized image must never cost us the alert itself.
      logger.warn('No se pudo enviar la captura; se envía solo el texto', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.sendMessage(chatId, text);
    }
  }

  private async sendMessage(chatId: string, text: string): Promise<void> {
    const response = await fetch(`${this.apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    await assertOk(response, chatId);
  }

  private async sendPhoto(chatId: string, photoPath: string, caption: string): Promise<void> {
    const bytes = await readFile(photoPath);
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([bytes], { type: 'image/png' }), path.basename(photoPath));

    const response = await fetch(`${this.apiBase}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    await assertOk(response, chatId);
  }
}

/** Turns a non-2xx Telegram reply into an error, without leaking the token. */
async function assertOk(response: Response, chatId: string): Promise<void> {
  if (response.ok) return;
  // The body carries Telegram's own description; the URL (with the token)
  // never reaches the logs.
  const body = await response.text().catch(() => '');
  throw new NotificationError(
    'telegram',
    `Telegram respondió HTTP ${response.status}: ${body.slice(0, 300)}`,
    { chatId },
  );
}

/** Trims a report to fit a caption, cutting on a line break when possible. */
function truncateCaption(text: string): string {
  const limit = CAPTION_LIMIT - 20;
  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > limit / 2 ? cut.slice(0, lastBreak) : cut}\n…`;
}
