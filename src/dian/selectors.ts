/**
 * Every piece of DOM knowledge about the DIAN portal lives in this file.
 * If DIAN changes its interface, this is the first (and usually only) file to
 * touch.
 *
 * How the portal is built (verified by inspecting the live site):
 *  - It is an ASP.NET WebForms app rendered by the "C-Media WebPlayer" engine
 *    (Ciel Ingeniería) with Kendo UI widgets.
 *  - Every logical control is wrapped in `<div rol="control" nombrecontrol="X">`
 *    and the inner node carries `pantalla="PasoUno" nombre="X"`. Those
 *    attributes are stable and semantic — far better anchors than CSS classes.
 *  - All screens (PasoUno, PasoDos, ModalError, …) exist in the DOM at once and
 *    only one is visible, so *every* locator must be filtered by visibility.
 *  - Two widget flavours are used:
 *      · button lists — `<div class="boton …" llave="<id>">` inside the control
 *      · native selects — `<select class="customSelect">` with `<option value>`
 */

/** Logical control names (the `nombrecontrol` attribute). */
export const CONTROL = {
  personType: 'TipoPersona',
  attentionType: 'TipoAtencion',
  /** "Seleccione el tipo de servicio" — categoría. */
  service: 'Categorias',
  /** "Trámite" — native select. */
  procedure: 'Servicios',
  city: 'Ciudades',
  office: 'Sedes',
  calendar: 'Calendario',
  dateButton: 'btnFecha',
  time: 'Horas',
  modalMessage: 'txtInfoAdicional',
} as const;

export type ControlName = (typeof CONTROL)[keyof typeof CONTROL];

/** Raw CSS used to reach the portal's building blocks. */
export const SELECTOR = {
  /** Loading splash shown until the player finishes bootstrapping. */
  splash: '.splash',
  /**
   * Full-screen "Cargando" overlay raised around every round-trip.
   *
   * The player creates it on demand (`Ciel.MPC.WebPlayer.MostrarDivCargando()`
   * → `<div id="mpcWPdivCargando" class="pantallaCargando">`) and afterwards
   * only calls `.hide()` on it, so the node stays in the DOM for the rest of the
   * session: what matters is whether it is *visible*, never whether it exists.
   */
  loading: '#mpcWPdivCargando, .pantallaCargando',
  /** Home tiles: "Agendar cita" / "Gestionar cita". */
  homeTile: '.btnInicio',
  /** An option inside a button-list control. */
  option: '[llave]',
  /** Native dropdown inside a control. */
  select: 'select',
  /** Enabled "Siguiente" button (the blocked variant has a different class). */
  nextEnabled: '.btnSiguientePagina',
  /** Disabled "Siguiente" — present while the current screen is incomplete. */
  nextBlocked: '.btnSiguientePaginaBlock',
  previous: '.btnAnteriorPagina',
  /** Error/info modal screen. */
  modalScreen: '[pantalla="ModalError"]',
  modalButton: '.btnModal',
  /** Kendo calendar rendered inside the Calendario control. */
  calendarRoot: '#calendar',
  calendarDayEnabled: 'td.k-calendar-td:not(.k-disabled) a.k-link',
  calendarAnyDay: 'td.k-calendar-td a.k-link',
  calendarTitle: '.k-nav-fast',
  calendarNextMonth: '.k-nav-next',
} as const;

/** Builds the locator string for a named control container. */
export function control(name: string): string {
  return `[nombrecontrol="${name}"]`;
}

/** Locator for one option of a button-list control, by its `llave`. */
export function optionByKey(key: string): string {
  return `[llave="${cssEscape(key)}"]`;
}

/** Minimal CSS attribute-value escaping (DIAN keys are GUIDs or digits). */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** Text on the home tile that starts the scheduling flow. */
export const HOME_TILE_SCHEDULE = 'Agendar cita';

/**
 * Markers that indicate a CAPTCHA / anti-bot challenge is being shown.
 * The monitor detects these and stops — it never tries to solve them.
 */
export const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha/api2/bframe"]',
  'iframe[title*="recaptcha challenge" i]',
  '.g-recaptcha:visible',
  '#challenge-form',
  'iframe[src*="challenges.cloudflare.com"]',
] as const;

export const CAPTCHA_TEXT_MARKERS = [
  'no soy un robot',
  "i'm not a robot",
  'verifique que es humano',
  'verifying you are human',
  'checking your browser',
] as const;
