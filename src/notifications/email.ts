import { Resend } from 'resend';
import type { AppConfig } from '../config/env.js';
import type { AvailabilityResult } from '../dian/availability.js';
import { NotificationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { buildEmail } from './messages.js';

/** Email delivery through Resend. Sends one message to all recipients. */
export class EmailNotifier {
  readonly channel = 'email';

  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean {
    return this.config.email.enabled;
  }

  async send(result: AvailabilityResult): Promise<void> {
    if (!this.enabled) {
      logger.debug('Correo deshabilitado (faltan RESEND_API_KEY / EMAIL_FROM / EMAIL_TO)');
      return;
    }

    const message = buildEmail(result);
    const recipients = this.config.email.to;

    if (this.config.dryRun) {
      logger.info(`[DRY_RUN] Correo NO enviado a ${recipients.length} destinatario(s)`, {
        para: recipients.join(', '),
        asunto: message.subject,
      });
      logger.debug(`[DRY_RUN] Cuerpo del correo:\n${message.text}`);
      return;
    }

    logger.info(`Enviando correo a ${recipients.length} destinatario(s)`);
    const resend = new Resend(this.config.email.apiKey);

    await withRetry(
      async () => {
        const response = await resend.emails.send({
          from: this.config.email.from,
          to: recipients,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        if (response.error) {
          throw new NotificationError('email', `Resend rechazó el envío: ${response.error.message}`, {
            nombre: response.error.name,
          });
        }
        logger.success('Correo enviado', { id: response.data?.id });
      },
      { attempts: this.config.maxAttempts, label: 'Envío de correo', shouldRetry: () => true },
    );
  }
}
