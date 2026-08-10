import type { AppConfig } from '../config/env.js';
import { CONTROL } from './selectors.js';

/**
 * The DIAN flow expressed as data, not code.
 *
 * The portal reveals its controls progressively: choosing a person type shows
 * the attention type, which shows the categories, which shows the procedure,
 * and only then does "Siguiente" unlock and move to the city/office/date
 * screen. Describing that as an ordered list of steps means changing what the
 * monitor looks for is a config edit, never a rewrite.
 *
 * A step whose configured value is empty ends the walk: the monitor evaluates
 * availability at exactly that point. That is what makes
 * "Persona Natural → Videoatención → Devoluciones and stop" expressible.
 */

export type WidgetKind = 'buttons' | 'select';

export interface FlowStep {
  /** Human label used in logs. */
  title: string;
  /** `nombrecontrol` attribute of the control to operate. */
  control: string;
  kind: WidgetKind;
  /** Configured value to pick. */
  value: string;
  /**
   * When true, the monitor clicks "Siguiente" after this step to move to the
   * next screen of the wizard.
   */
  advancesScreen?: boolean;
}

/** Builds the ordered step list for the configured target. */
export function buildFlow(config: AppConfig): FlowStep[] {
  const t = config.target;
  const steps: FlowStep[] = [
    { title: 'Tipo de persona', control: CONTROL.personType, kind: 'buttons', value: t.personType },
    { title: 'Modalidad', control: CONTROL.attentionType, kind: 'buttons', value: t.attentionType },
    { title: 'Tipo de servicio', control: CONTROL.service, kind: 'buttons', value: t.service },
    { title: 'Trámite', control: CONTROL.procedure, kind: 'select', value: t.procedure, advancesScreen: true },
    { title: 'Ciudad', control: CONTROL.city, kind: 'select', value: t.city },
    { title: 'Sede', control: CONTROL.office, kind: 'select', value: t.office },
  ];

  // Stop at the first step without a configured value: everything after it is
  // unreachable anyway, since the portal gates each control on the previous one.
  const firstEmpty = steps.findIndex((s) => s.value === '');
  return firstEmpty === -1 ? steps : steps.slice(0, firstEmpty);
}

/** True when the configured flow goes deep enough to reach the calendar. */
export function flowReachesCalendar(config: AppConfig): boolean {
  return Boolean(config.target.procedure && config.target.city && config.target.office);
}
