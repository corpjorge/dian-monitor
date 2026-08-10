import { describe, expect, it } from 'vitest';
import { type AvailabilityResult, fingerprint } from '../src/dian/availability.js';
import { decideNotification, decideReporting } from '../src/notifications/dedupe.js';
import { MemoryStorage } from '../src/storage/memory.js';
import type { MonitorState } from '../src/storage/types.js';

function result(overrides: Partial<AvailabilityResult> = {}): AvailabilityResult {
  return {
    available: true,
    detectedAt: '2026-08-09T23:00:00.000Z',
    city: 'Bogotá, D.C.',
    procedure: 'RUT',
    service: 'RUT y orientación TAC',
    attentionType: 'Videoatención',
    personType: 'Persona Natural',
    office: 'Bogotá Avenida 68',
    dates: [{ date: '2026-08-12', label: 'x', times: ['08:00'] }],
    reason: 'fechas-encontradas',
    stepsCompleted: [],
    discoveredOptions: [],
    ...overrides,
  };
}

function stateFor(r: AvailabilityResult, notifiedAt: string): MonitorState {
  return {
    fingerprint: fingerprint(r),
    notifiedAt,
    lastRunAt: notifiedAt,
    lastAvailable: true,
    runsSinceLastReport: 0,
    lastRunFailed: false,
  };
}

const NOW = new Date('2026-08-09T23:30:00.000Z');

describe('decideNotification', () => {
  it('no notifica cuando no hay disponibilidad', () => {
    const decision = decideNotification(result({ available: false }), null, 60, NOW);
    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe('sin-disponibilidad');
  });

  it('notifica la primera vez', () => {
    expect(decideNotification(result(), null, 60, NOW).shouldNotify).toBe(true);
  });

  it('no repite la misma disponibilidad dentro del enfriamiento', () => {
    const previous = stateFor(result(), '2026-08-09T23:00:00.000Z'); // hace 30 min
    const decision = decideNotification(result(), previous, 60, NOW);
    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe('en-enfriamiento');
    expect(decision.cooldownRemainingMinutes).toBe(30);
  });

  it('repite la misma disponibilidad una vez pasado el enfriamiento', () => {
    const previous = stateFor(result(), '2026-08-09T22:00:00.000Z'); // hace 90 min
    expect(decideNotification(result(), previous, 60, NOW).shouldNotify).toBe(true);
  });

  it('con enfriamiento 0 nunca repite la misma disponibilidad', () => {
    const previous = stateFor(result(), '2020-01-01T00:00:00.000Z');
    const decision = decideNotification(result(), previous, 0, NOW);
    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe('misma-disponibilidad');
  });

  it('notifica de inmediato si aparece una hora nueva, aunque esté en enfriamiento', () => {
    const previous = stateFor(result(), '2026-08-09T23:29:00.000Z'); // hace 1 min
    const changed = result({ dates: [{ date: '2026-08-12', label: 'x', times: ['08:00', '09:00'] }] });
    expect(decideNotification(changed, previous, 60, NOW).shouldNotify).toBe(true);
  });

  it('notifica de inmediato si aparece una fecha nueva', () => {
    const previous = stateFor(result(), '2026-08-09T23:29:00.000Z');
    const changed = result({
      dates: [
        { date: '2026-08-12', label: 'x', times: ['08:00'] },
        { date: '2026-08-20', label: 'y', times: ['10:00'] },
      ],
    });
    expect(decideNotification(changed, previous, 60, NOW).shouldNotify).toBe(true);
  });

  it('notifica de inmediato si cambia la sede', () => {
    const previous = stateFor(result(), '2026-08-09T23:29:00.000Z');
    expect(decideNotification(result({ office: 'Bogotá BIMA' }), previous, 60, NOW).shouldNotify).toBe(true);
  });

  it('trata un estado previo sin fecha de aviso como muy antiguo', () => {
    const previous: MonitorState = {
      fingerprint: fingerprint(result()),
      notifiedAt: '',
      lastRunAt: '',
      lastAvailable: true,
      runsSinceLastReport: 0,
      lastRunFailed: false,
    };
    expect(decideNotification(result(), previous, 60, NOW).shouldNotify).toBe(true);
  });
});

describe('MemoryStorage', () => {
  it('empieza vacío y conserva lo guardado', async () => {
    const storage = new MemoryStorage();
    expect(await storage.getLastState()).toBeNull();
    const state = stateFor(result(), NOW.toISOString());
    await storage.saveState(state);
    expect(await storage.getLastState()).toEqual(state);
  });
});

describe('decideReporting', () => {
  const state = (over: Partial<MonitorState> = {}): MonitorState => ({
    fingerprint: 'x',
    notifiedAt: NOW.toISOString(),
    lastRunAt: NOW.toISOString(),
    lastAvailable: false,
    runsSinceLastReport: 0,
    lastRunFailed: false,
    ...over,
  });

  it('avisa siempre que hay disponibilidad, sin esperar al resumen', () => {
    const decision = decideReporting({
      kind: 'available',
      previous: state({ runsSinceLastReport: 3 }),
      heartbeatEveryRuns: 50,
    });
    expect(decision.send).toBe(true);
    expect(decision.trigger).toBe('disponibilidad');
  });

  it('calla mientras no hay novedad', () => {
    for (const runs of [0, 1, 20, 48]) {
      const decision = decideReporting({
        kind: 'unavailable',
        previous: state({ runsSinceLastReport: runs }),
        heartbeatEveryRuns: 50,
      });
      expect(decision.send, `ejecución ${runs + 1}`).toBe(false);
    }
  });

  it('envía el resumen en la ejecución número 50', () => {
    const decision = decideReporting({
      kind: 'unavailable',
      previous: state({ runsSinceLastReport: 49 }),
      heartbeatEveryRuns: 50,
    });
    expect(decision.send).toBe(true);
    expect(decision.trigger).toBe('resumen-periodico');
    expect(decision.runNumber).toBe(50);
  });

  it('cuenta la primera ejecución como la número 1', () => {
    expect(decideReporting({ kind: 'unavailable', previous: null, heartbeatEveryRuns: 50 }).runNumber).toBe(1);
  });

  it('con 1 avisa en cada ejecución', () => {
    expect(
      decideReporting({ kind: 'unavailable', previous: state(), heartbeatEveryRuns: 1 }).send,
    ).toBe(true);
  });

  it('con 0 nunca envía el resumen', () => {
    expect(
      decideReporting({
        kind: 'unavailable',
        previous: state({ runsSinceLastReport: 9_999 }),
        heartbeatEveryRuns: 0,
      }).send,
    ).toBe(false);
  });

  it('avisa de inmediato del primer fallo', () => {
    const decision = decideReporting({
      kind: 'error',
      previous: state({ lastRunFailed: false }),
      heartbeatEveryRuns: 50,
    });
    expect(decision.send).toBe(true);
    expect(decision.trigger).toBe('fallo-nuevo');
  });

  it('no repite el aviso mientras el fallo persiste', () => {
    const decision = decideReporting({
      kind: 'error',
      previous: state({ lastRunFailed: true, runsSinceLastReport: 5 }),
      heartbeatEveryRuns: 50,
    });
    expect(decision.send).toBe(false);
  });

  it('vuelve a avisar de un fallo persistente al llegar al resumen', () => {
    const decision = decideReporting({
      kind: 'error',
      previous: state({ lastRunFailed: true, runsSinceLastReport: 49 }),
      heartbeatEveryRuns: 50,
    });
    expect(decision.send).toBe(true);
    expect(decision.trigger).toBe('resumen-periodico');
  });
});
