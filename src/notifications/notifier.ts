import type { AppConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { EmailNotifier } from './email.js';
import type { RunReport } from './report.js';
import { TelegramNotifier } from './telegram.js';

/**
 * Decides which channels hear about a run, and sends to them independently: if
 * Resend is down, Telegram still goes out, and vice versa.
 *
 * The two channels have deliberately different policies:
 *  · Telegram receives whatever the monitor decided is worth sending: every
 *    availability, plus the periodic summary that proves the cron is alive.
 *  · Email only fires when there is real availability. A cron every few minutes
 *    would otherwise fill an inbox with hundreds of identical messages.
 */

export interface ChannelOutcome {
  channel: string;
  delivered: boolean;
  error?: string;
}

export interface NotificationSummary {
  attempted: boolean;
  anyDelivered: boolean;
  outcomes: ChannelOutcome[];
}

export class Notifier {
  private readonly telegram: TelegramNotifier;
  private readonly email: EmailNotifier;

  constructor(private readonly config: AppConfig) {
    this.telegram = new TelegramNotifier(config);
    this.email = new EmailNotifier(config);
  }

  /** True when at least one channel is configured. */
  get hasChannels(): boolean {
    return this.telegram.enabled || this.email.enabled;
  }

  async report(report: RunReport): Promise<NotificationSummary> {
    const tasks: Array<{ channel: string; run: () => Promise<void> }> = [];

    if (this.telegram.enabled) {
      tasks.push({ channel: 'telegram', run: () => this.telegram.send(report) });
    }

    if (this.email.enabled && report.kind === 'available') {
      tasks.push({ channel: 'email', run: () => this.email.send(report.result) });
    }

    if (tasks.length === 0) {
      if (report.kind === 'available' && !this.hasChannels) {
        logger.warn('No hay canales de notificación configurados; solo se registra en los logs');
      }
      return { attempted: false, anyDelivered: false, outcomes: [] };
    }

    const outcomes: ChannelOutcome[] = [];
    for (const task of tasks) {
      try {
        await task.run();
        outcomes.push({ channel: task.channel, delivered: true });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`Falló el canal ${task.channel}; se continúa con los demás`, { error: detail });
        outcomes.push({ channel: task.channel, delivered: false, error: detail });
      }
    }

    const anyDelivered = outcomes.some((o) => o.delivered);
    if (anyDelivered && !this.config.dryRun) logger.success('Notificaciones enviadas');
    return { attempted: true, anyDelivered, outcomes };
  }
}
