import { describe, expect, it } from 'vitest';
import { type AvailabilityResult, fingerprint } from '../src/dian/availability.js';
import { isoToDisplayDate, kendoValueToIso, timeOptionMatchesDate } from '../src/dian/controls.js';
import { buildFlow, flowReachesCalendar } from '../src/dian/flow.js';
import { loadConfig } from '../src/config/env.js';

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
    dates: [{ date: '2026-08-12', label: 'miércoles, 12 de agosto de 2026', times: ['08:00', '09:00'] }],
    reason: 'fechas-encontradas',
    stepsCompleted: [],
    discoveredOptions: [],
    ...overrides,
  };
}

describe('kendoValueToIso', () => {
  it('convierte el mes de base cero de Kendo', () => {
    expect(kendoValueToIso('2026/7/12')).toBe('2026-08-12');
    expect(kendoValueToIso('2026/0/1')).toBe('2026-01-01');
    expect(kendoValueToIso('2026/11/31')).toBe('2026-12-31');
  });

  it('devuelve el valor original si no puede interpretarlo', () => {
    expect(kendoValueToIso('no-es-fecha')).toBe('no-es-fecha');
  });
});

describe('isoToDisplayDate', () => {
  it('produce el formato que muestra el botón de fecha', () => {
    expect(isoToDisplayDate('2026-08-12')).toBe('12/08/2026');
  });
});

describe('timeOptionMatchesDate', () => {
  it('acepta las horas del mismo día', () => {
    expect(timeOptionMatchesDate('8/12/2026 12:15:00 PM', '2026-08-12')).toBe(true);
  });

  it('rechaza las horas de otro día — evita alertas con horas desfasadas', () => {
    expect(timeOptionMatchesDate('8/13/2026 12:15:00 PM', '2026-08-12')).toBe(false);
  });

  it('acepta valores con un formato desconocido en lugar de descartarlos', () => {
    expect(timeOptionMatchesDate('formato-nuevo', '2026-08-12')).toBe(true);
  });
});

describe('fingerprint', () => {
  it('es estable para la misma disponibilidad', () => {
    expect(fingerprint(result())).toBe(fingerprint(result()));
  });

  it('ignora el instante de detección', () => {
    expect(fingerprint(result({ detectedAt: '2030-01-01T00:00:00.000Z' }))).toBe(fingerprint(result()));
  });

  it('ignora el orden de las horas', () => {
    const reversed = result({
      dates: [{ date: '2026-08-12', label: 'x', times: ['09:00', '08:00'] }],
    });
    expect(fingerprint(reversed)).toBe(fingerprint(result()));
  });

  it('cambia cuando aparece una hora nueva', () => {
    const extra = result({
      dates: [{ date: '2026-08-12', label: 'x', times: ['08:00', '09:00', '10:00'] }],
    });
    expect(fingerprint(extra)).not.toBe(fingerprint(result()));
  });

  it('cambia cuando aparece una fecha nueva', () => {
    const extra = result({
      dates: [
        { date: '2026-08-12', label: 'x', times: ['08:00', '09:00'] },
        { date: '2026-08-13', label: 'y', times: ['08:00'] },
      ],
    });
    expect(fingerprint(extra)).not.toBe(fingerprint(result()));
  });

  it('cambia cuando cambia la sede', () => {
    expect(fingerprint(result({ office: 'Bogotá BIMA' }))).not.toBe(fingerprint(result()));
  });

  it('cambia cuando el portal muestra otro mensaje', () => {
    const a = result({ dates: [], reason: 'mensaje-desconocido', message: 'Servicio en mantenimiento' });
    const b = result({ dates: [], reason: 'mensaje-desconocido', message: 'Intente más tarde' });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('no distingue diferencias de tildes o mayúsculas en los filtros', () => {
    expect(fingerprint(result({ city: 'BOGOTA, D.C.' }))).toBe(fingerprint(result()));
  });
});

describe('buildFlow', () => {
  const base = {
    DIAN_TARGET_PERSON_TYPE: 'Persona Natural',
    DIAN_TARGET_ATTENTION_TYPE: 'Videoatención',
  };

  it('se detiene en el primer valor sin configurar', () => {
    const config = loadConfig({ ...base, DIAN_TARGET_SERVICE: 'Devoluciones' });
    const steps = buildFlow(config);
    expect(steps.map((s) => s.title)).toEqual(['Tipo de persona', 'Modalidad', 'Tipo de servicio']);
  });

  it('recorre todo el flujo cuando está configurado por completo', () => {
    const config = loadConfig({
      ...base,
      DIAN_TARGET_SERVICE: 'RUT y orientación TAC',
      DIAN_TARGET_PROCEDURE: 'Inscripción o actualización RUT persona natural',
      DIAN_TARGET_CITY: 'Bogotá, D.C.',
      DIAN_TARGET_OFFICE: 'Bogotá Avenida 68',
    });
    expect(buildFlow(config)).toHaveLength(6);
    expect(flowReachesCalendar(config)).toBe(true);
  });

  it('no llega al calendario con una configuración parcial', () => {
    const config = loadConfig({ ...base, DIAN_TARGET_SERVICE: 'Devoluciones' });
    expect(flowReachesCalendar(config)).toBe(false);
  });

  it('marca el paso del trámite como el que cambia de pantalla', () => {
    const config = loadConfig({
      ...base,
      DIAN_TARGET_SERVICE: 'RUT y orientación TAC',
      DIAN_TARGET_PROCEDURE: 'Inscripción',
      DIAN_TARGET_CITY: 'Bogotá, D.C.',
      DIAN_TARGET_OFFICE: 'Bogotá Avenida 68',
    });
    const advancing = buildFlow(config).filter((s) => s.advancesScreen);
    expect(advancing.map((s) => s.title)).toEqual(['Trámite']);
  });
});
