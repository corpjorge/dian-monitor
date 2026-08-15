import { describe, expect, it } from 'vitest';
import { type PortalProbe, waitForAnswer } from '../src/dian/availability.js';
import { PortalNotSettledError } from '../src/utils/errors.js';

/**
 * The rule these tests protect: an alert may only come from something the
 * portal actually showed. While the "Cargando" overlay (or the splash) is up
 * the page says nothing, and the monitor must keep waiting instead of reading
 * the half-drawn screen underneath as "el flujo avanzó".
 */

interface Frame {
  busy?: boolean;
  modal?: string | null;
  options?: string[] | null;
}

/** A fake portal that walks through `frames`, repeating the last one forever. */
function probeOf(frames: Frame[], onWait: () => void = () => undefined): PortalProbe {
  let index = -1;
  const frame = () => frames[Math.min(index, frames.length - 1)] ?? {};
  return {
    isBusy: async () => {
      index++;
      return frame().busy ?? false;
    },
    modalMessage: async () => frame().modal ?? null,
    revealedOptions: async () => (frame().options === undefined ? [] : frame().options!),
    wait: async () => onWait(),
  };
}

describe('waitForAnswer', () => {
  it('no da veredicto mientras el portal está cargando', async () => {
    const frames: Frame[] = [
      { busy: true },
      { busy: true },
      { busy: false, options: ['Devolución del IVA'] },
    ];
    const answer = await waitForAnswer(probeOf(frames), 1_000);
    expect(answer).toEqual({ kind: 'revealed', options: ['Devolución del IVA'] });
  });

  it('falla en vez de inventar disponibilidad si nunca deja de cargar', async () => {
    const probe = probeOf([{ busy: true }]);
    await expect(waitForAnswer(probe, 150)).rejects.toBeInstanceOf(PortalNotSettledError);
  });

  it('falla también si el portal vuelve al splash y no muestra nada', async () => {
    // El splash cuenta como "ocupado": es el player reiniciándose.
    const probe = probeOf([{ busy: false, options: [] }, { busy: true }]);
    await expect(waitForAnswer(probe, 150)).rejects.toBeInstanceOf(PortalNotSettledError);
  });

  it('devuelve el mensaje del modal cuando el portal responde con uno', async () => {
    const frames: Frame[] = [
      { busy: true },
      { busy: false, modal: 'No se encontraron especialidades relacionadas.' },
    ];
    const answer = await waitForAnswer(probeOf(frames), 1_000);
    expect(answer).toEqual({
      kind: 'modal',
      message: 'No se encontraron especialidades relacionadas.',
    });
  });

  it('espera a que el control tenga opciones de verdad, no sólo a que exista', async () => {
    const frames: Frame[] = [
      { busy: false, options: [] },
      { busy: false, options: [] },
      { busy: false, options: ['Trámite A'] },
    ];
    const answer = await waitForAnswer(probeOf(frames), 1_000);
    expect(answer).toEqual({ kind: 'revealed', options: ['Trámite A'] });
  });

  it('se conforma con que el portal termine cuando no hay control que mirar', async () => {
    // `options: null` = este paso no revela ningún control (cambia de pantalla).
    const answer = await waitForAnswer(probeOf([{ busy: true }, { busy: false, options: null }]), 1_000);
    expect(answer).toEqual({ kind: 'revealed', options: [] });
  });

  it('cuenta en el error si llegó a ver la pantalla de carga', async () => {
    const probe = probeOf([{ busy: true }]);
    await expect(waitForAnswer(probe, 150, () => ({ paso: 'Tipo de servicio' }))).rejects.toMatchObject({
      code: 'PORTAL_NOT_SETTLED',
      retryable: true,
      details: { paso: 'Tipo de servicio', pantallaDeCargaVista: true },
    });
  });

  it('no se queda en un bucle sin pausas', async () => {
    let waits = 0;
    const probe = probeOf([{ busy: true }], () => {
      waits++;
    });
    await expect(waitForAnswer(probe, 150)).rejects.toBeInstanceOf(PortalNotSettledError);
    expect(waits).toBeGreaterThan(0);
  });
});
