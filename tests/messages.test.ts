import { describe, expect, it } from 'vitest';
import type { AvailabilityResult } from '../src/dian/availability.js';
import {
  buildEmail,
  buildEmailSubject,
  buildTelegramMessage,
  buildTelegramReport,
} from '../src/notifications/messages.js';
import { Logger, redact, registerSecret } from '../src/utils/logger.js';
import { formatTimestamp } from '../src/utils/time.js';

function result(overrides: Partial<AvailabilityResult> = {}): AvailabilityResult {
  return {
    available: true,
    detectedAt: '2026-08-09T23:00:00.000Z',
    city: 'Bogotá, D.C.',
    procedure: 'Inscripción o actualización RUT persona natural',
    service: 'RUT y orientación TAC',
    attentionType: 'Videoatención',
    personType: 'Persona Natural',
    office: 'Bogotá Avenida 68',
    dates: [
      { date: '2026-08-12', label: 'miércoles, 12 de agosto de 2026', times: ['08:00 AM', '09:00 AM'] },
    ],
    reason: 'fechas-encontradas',
    stepsCompleted: [],
    discoveredOptions: [],
    ...overrides,
  };
}

describe('buildEmailSubject', () => {
  it('incluye la ciudad', () => {
    expect(buildEmailSubject(result())).toBe('🚨 Cita DIAN disponible - Bogotá, D.C.');
  });

  it('usa la modalidad cuando el flujo no llegó a elegir ciudad', () => {
    expect(buildEmailSubject(result({ city: '' }))).toBe('🚨 Cita DIAN disponible - Videoatención');
  });
});

describe('buildEmail', () => {
  it('incluye todos los datos del hallazgo', () => {
    const email = buildEmail(result());
    for (const expected of [
      'Bogotá, D.C.',
      'Videoatención',
      'Inscripción o actualización RUT persona natural',
      'Bogotá Avenida 68',
      'miércoles, 12 de agosto de 2026',
      '08:00 AM',
      'https://agendamiento.dian.gov.co/',
    ]) {
      expect(email.text).toContain(expected);
      expect(email.html).toContain(expected);
    }
  });

  it('genera HTML bien formado', () => {
    const email = buildEmail(result());
    expect(email.html).toContain('<!doctype html>');
    expect(email.html.match(/<tr>/g)?.length).toBe(email.html.match(/<\/tr>/g)?.length);
  });

  it('escapa el HTML que venga del portal', () => {
    const email = buildEmail(result({ message: '<script>alert(1)</script>' }));
    expect(email.html).not.toContain('<script>alert(1)</script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('avisa cuando aún no hay fechas concretas', () => {
    const email = buildEmail(result({ dates: [], reason: 'flujo-avanzo' }));
    expect(email.text).toContain('Por confirmar en el portal');
  });

  it('muestra la fecha de detección en horario de Colombia', () => {
    // 23:00 UTC = 18:00 en Bogotá (UTC-5)
    expect(buildEmail(result()).text).toMatch(/6:00\s*p/i);
  });
});

describe('buildTelegramMessage', () => {
  it('incluye los datos clave', () => {
    const message = buildTelegramMessage(result());
    expect(message).toContain('CITA DIAN DISPONIBLE');
    expect(message).toContain('Bogotá, D.C.');
    expect(message).toContain('Videoatención');
    expect(message).toContain('miércoles, 12 de agosto de 2026');
    expect(message).toContain('08:00 AM, 09:00 AM');
    expect(message).toContain('https://agendamiento.dian.gov.co/');
  });

  it('muestra el mensaje del portal cuando no hay fechas', () => {
    const message = buildTelegramMessage(
      result({ dates: [], reason: 'mensaje-desconocido', message: 'Servicio en mantenimiento' }),
    );
    expect(message).toContain('Servicio en mantenimiento');
  });

  it('lista las opciones detectadas cuando el flujo simplemente avanzó', () => {
    const message = buildTelegramMessage(
      result({ dates: [], reason: 'flujo-avanzo', discoveredOptions: ['Trámite A', 'Trámite B'] }),
    );
    expect(message).toContain('Trámite A');
    expect(message).toContain('Trámite B');
  });

  it('omite los campos vacíos', () => {
    expect(buildTelegramMessage(result({ office: '', procedure: '' }))).not.toContain('Sede:');
  });
});

describe('logger', () => {
  it('oculta los secretos registrados', () => {
    registerSecret('re_clave_super_secreta');
    expect(redact('usando re_clave_super_secreta aquí')).toBe('usando *** aquí');
  });

  it('oculta un token de Telegram aunque no se haya registrado', () => {
    expect(redact('https://api.telegram.org/bot123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ/send')).toContain(
      '***',
    );
  });

  it('respeta el nivel mínimo', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      const logger = new Logger('warn');
      logger.info('no debería aparecer');
      logger.debug('tampoco');
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(0);
  });
});

describe('formatTimestamp', () => {
  it('usa la hora de Colombia', () => {
    // 2026-08-10T04:00:00Z = 2026-08-09 23:00:00 en Bogotá
    expect(formatTimestamp(new Date('2026-08-10T04:00:00.000Z'))).toBe('2026-08-09 23:00:00');
  });

  it('representa la medianoche como 00', () => {
    expect(formatTimestamp(new Date('2026-08-10T05:00:00.000Z'))).toBe('2026-08-10 00:00:00');
  });
});

describe('escapeTelegram', () => {
  it('escapa los caracteres que rompen el modo HTML', async () => {
    const { escapeTelegram } = await import('../src/notifications/messages.js');
    expect(escapeTelegram('Tips & <b>trucos</b>')).toBe('Tips &amp; &lt;b&gt;trucos&lt;/b&gt;');
  });

  it('deja intactos los guiones bajos y asteriscos del texto de la DIAN', async () => {
    // En modo Markdown estos caracteres provocaban un error 400 de Telegram.
    const message = buildTelegramMessage(
      result({ procedure: 'Trámite_especial *urgente*', dates: [] }),
    );
    expect(message).toContain('Trámite_especial *urgente*');
  });

  it('escapa el texto que venga del portal dentro del mensaje', () => {
    const message = buildTelegramMessage(
      result({ dates: [], reason: 'mensaje-desconocido', message: 'Error <script>' }),
    );
    expect(message).toContain('&lt;script&gt;');
    expect(message).not.toContain('<script>');
  });
});

describe('buildTelegramReport', () => {
  it('avisa "sin cupo" en la ejecución rutinaria', () => {
    const message = buildTelegramReport({
      kind: 'unavailable',
      result: result({
        available: false,
        dates: [],
        reason: 'sin-especialidades',
        message: 'No se encontraron especialidades relacionadas según los filtros seleccionados.',
      }),
    });
    expect(message).toContain('sin cupo todavía');
    expect(message).toContain('No se encontraron especialidades');
    expect(message).toContain('Videoatención');
    expect(message).toContain('Revisado:');
  });

  it('explica cuando el calendario quedó sin días', () => {
    const message = buildTelegramReport({
      kind: 'unavailable',
      result: result({ available: false, dates: [], reason: 'sin-fechas-en-calendario' }),
    });
    expect(message).toContain('no ofrece ningún día con cupo');
  });

  it('marca el aviso repetido', () => {
    const repeat = buildTelegramReport({ kind: 'available', result: result(), isRepeat: true });
    const fresh = buildTelegramReport({ kind: 'available', result: result(), isRepeat: false });
    expect(repeat).toContain('misma disponibilidad');
    expect(fresh).not.toContain('misma disponibilidad');
    expect(fresh).toContain('CITA DIAN DISPONIBLE');
  });

  it('informa del fallo para que el silencio no se confunda con "no hay cupo"', () => {
    const message = buildTelegramReport({ kind: 'error', error: 'El portal respondió HTTP 503.' });
    expect(message).toContain('no pudo completar la revisión');
    expect(message).toContain('HTTP 503');
  });

  it('escapa el texto del portal en el mensaje de fallo', () => {
    const message = buildTelegramReport({ kind: 'error', error: 'fallo en <div id="x">' });
    expect(message).toContain('&lt;div');
    expect(message).not.toContain('<div id=');
  });
});

describe('resumen periódico', () => {
  it('indica cuántas revisiones resume', () => {
    const message = buildTelegramReport({
      kind: 'unavailable',
      result: result({ available: false, dates: [] }),
      runsCovered: 50,
    });
    expect(message).toContain('50 revisiones sin novedad');
  });

  it('usa el singular cuando resume una sola', () => {
    const message = buildTelegramReport({
      kind: 'unavailable',
      result: result({ available: false, dates: [] }),
      runsCovered: 1,
    });
    expect(message).toContain('1 revisión sin novedad');
  });

  it('dice cuántas ejecuciones lleva fallando', () => {
    const message = buildTelegramReport({ kind: 'error', error: 'timeout', runsCovered: 50 });
    expect(message).toContain('Lleva 50 ejecuciones fallando');
  });

  it('no menciona el conteo en el primer fallo', () => {
    const message = buildTelegramReport({ kind: 'error', error: 'timeout', runsCovered: 1 });
    expect(message).not.toContain('ejecuciones fallando');
  });
});

describe('enlace al portal', () => {
  const PORTAL = 'https://agendamiento.dian.gov.co/';

  // El enlace es la acción que se espera del mensaje: debe estar en todos,
  // también en el resumen rutinario y en el aviso de fallo.
  it('aparece en el aviso de disponibilidad', () => {
    expect(buildTelegramReport({ kind: 'available', result: result(), isRepeat: false })).toContain(PORTAL);
  });

  it('aparece en el resumen periódico', () => {
    expect(
      buildTelegramReport({
        kind: 'unavailable',
        result: result({ available: false, dates: [] }),
        runsCovered: 50,
      }),
    ).toContain(PORTAL);
  });

  it('aparece en el aviso de fallo', () => {
    expect(buildTelegramReport({ kind: 'error', error: 'timeout' })).toContain(PORTAL);
  });

  it('también en el correo', () => {
    const email = buildEmail(result());
    expect(email.text).toContain(PORTAL);
    expect(email.html).toContain(PORTAL);
  });
});
