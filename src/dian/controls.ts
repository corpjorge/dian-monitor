import type { Locator, Page } from 'playwright';
import { DianStructureChangedError, ElementNotFoundError } from '../utils/errors.js';
import { findBestMatch, flatten } from '../utils/text.js';
import { SELECTOR, control, optionByKey } from './selectors.js';

/**
 * Thin wrappers over the two widget flavours the portal uses, plus the calendar
 * and the modal. They all share the same contract:
 *   `options()` lists what is really on screen, `select()` picks one by label.
 *
 * Matching is done on the *visible* text after normalization, so a `<br>` in
 * "Persona<br>Natural" or a stray trailing dot in "Devoluciones." do not break
 * the lookup. When nothing matches, the error carries the real option list —
 * which is what you need to fix a config value or spot an interface change.
 */

export interface ControlOption {
  /** The portal's own identifier (`llave` or `<option value>`). */
  key: string;
  /** Visible label, whitespace-normalized. */
  label: string;
}

export interface AvailableDate {
  /** Kendo's raw `data-value`, e.g. `2026/7/12` (month is 0-based). */
  rawValue: string;
  /** ISO date, e.g. `2026-08-12`. */
  iso: string;
  /** Full Spanish label from the cell title, e.g. `miércoles, 12 de agosto de 2026`. */
  label: string;
  /** Day number as displayed. */
  day: string;
}

const VISIBLE = { visible: true } as const;

/** A list-of-buttons control (TipoPersona, TipoAtencion, Categorias). */
export class ButtonListControl {
  constructor(
    private readonly page: Page,
    private readonly name: string,
    private readonly timeoutMs: number,
  ) {}

  private get container(): Locator {
    return this.page.locator(control(this.name)).filter(VISIBLE).first();
  }

  async waitUntilReady(): Promise<void> {
    try {
      await this.container.locator(SELECTOR.option).filter(VISIBLE).first().waitFor({
        state: 'visible',
        timeout: this.timeoutMs,
      });
    } catch {
      throw new ElementNotFoundError(`El control "${this.name}" no mostró opciones a tiempo.`, {
        control: this.name,
      });
    }
  }

  async isPresent(): Promise<boolean> {
    return (await this.container.locator(SELECTOR.option).filter(VISIBLE).count()) > 0;
  }

  async options(): Promise<ControlOption[]> {
    const raw = await this.container
      .locator(SELECTOR.option)
      .filter(VISIBLE)
      .evaluateAll((els) =>
        els.map((el) => ({
          key: el.getAttribute('llave') ?? '',
          label: (el as HTMLElement).innerText ?? '',
        })),
      );
    return raw.map((o) => ({ key: o.key, label: flatten(o.label) }));
  }

  async select(wanted: string): Promise<ControlOption> {
    await this.waitUntilReady();
    const options = await this.options();
    const match = findBestMatch(options, wanted, (o) => o.label);
    if (!match) {
      throw new DianStructureChangedError(
        `No se encontró la opción "${wanted}" en el control "${this.name}".`,
        { control: this.name, buscado: wanted, disponibles: options.map((o) => o.label) },
      );
    }
    await this.container.locator(optionByKey(match.key)).first().click({ timeout: this.timeoutMs });
    return match;
  }
}

/** A native `<select class="customSelect">` control (Servicios, Ciudades, Sedes, Horas). */
export class SelectControl {
  constructor(
    private readonly page: Page,
    private readonly name: string,
    private readonly timeoutMs: number,
  ) {}

  private get element(): Locator {
    return this.page.locator(`${control(this.name)} ${SELECTOR.select}`).filter(VISIBLE).first();
  }

  async isPresent(): Promise<boolean> {
    return (await this.page.locator(`${control(this.name)} ${SELECTOR.select}`).filter(VISIBLE).count()) > 0;
  }

  async waitUntilReady(): Promise<void> {
    try {
      await this.element.waitFor({ state: 'visible', timeout: this.timeoutMs });
    } catch {
      throw new ElementNotFoundError(`El control "${this.name}" no apareció a tiempo.`, { control: this.name });
    }
  }

  async options(): Promise<ControlOption[]> {
    const raw = await this.element.locator('option').evaluateAll((els) =>
      els.map((el) => ({
        key: (el as HTMLOptionElement).value,
        label: el.textContent ?? '',
      })),
    );
    // The portal always renders an empty placeholder option first.
    return raw.map((o) => ({ key: o.key, label: flatten(o.label) })).filter((o) => o.key !== '');
  }

  async select(wanted: string): Promise<ControlOption> {
    await this.waitUntilReady();
    const options = await this.options();
    const match = findBestMatch(options, wanted, (o) => o.label);
    if (!match) {
      throw new DianStructureChangedError(
        `No se encontró la opción "${wanted}" en el control "${this.name}".`,
        { control: this.name, buscado: wanted, disponibles: options.map((o) => o.label) },
      );
    }
    await this.element.selectOption(match.key, { timeout: this.timeoutMs });
    return match;
  }
}

/** The Kendo calendar: enabled cells are the days with free slots. */
export class CalendarControl {
  constructor(
    private readonly page: Page,
    private readonly timeoutMs: number,
  ) {}

  private get root(): Locator {
    return this.page.locator(SELECTOR.calendarRoot).filter(VISIBLE).first();
  }

  async isPresent(): Promise<boolean> {
    return (await this.page.locator(SELECTOR.calendarRoot).filter(VISIBLE).count()) > 0;
  }

  async waitUntilReady(): Promise<void> {
    try {
      // Wait for the month header, never for a day cell: the portal hides the
      // links of unavailable days, so the first `a.k-link` in the DOM is
      // typically invisible and would time out even on a healthy calendar.
      await this.root.locator(SELECTOR.calendarTitle).first().waitFor({
        state: 'visible',
        timeout: this.timeoutMs,
      });
    } catch {
      throw new ElementNotFoundError('El calendario no se renderizó a tiempo.');
    }
  }

  /** Month label currently displayed, e.g. `agosto 2026`. */
  async currentMonth(): Promise<string> {
    return flatten(await this.root.locator(SELECTOR.calendarTitle).first().innerText());
  }

  /** Days that are selectable — i.e. days with appointments left. */
  async availableDates(): Promise<AvailableDate[]> {
    const raw = await this.root.locator(SELECTOR.calendarDayEnabled).evaluateAll((els) =>
      els.map((el) => ({
        rawValue: el.getAttribute('data-value') ?? '',
        label: el.getAttribute('title') ?? '',
        day: el.textContent ?? '',
      })),
    );
    return raw
      .filter((d) => d.rawValue !== '')
      .map((d) => ({
        rawValue: d.rawValue,
        iso: kendoValueToIso(d.rawValue),
        label: flatten(d.label),
        day: flatten(d.day),
      }));
  }

  /** True when selectable days are on screen, i.e. the picker is expanded. */
  async isOpen(): Promise<boolean> {
    return (await this.page.locator(SELECTOR.calendarDayEnabled).filter(VISIBLE).count()) > 0;
  }

  /** Date currently committed by the widget, as shown on `btnFecha` (`DD/MM/YYYY`). */
  async selectedDate(): Promise<string> {
    const btn = this.page.locator(control('btnFecha')).filter(VISIBLE).first();
    if ((await btn.count()) === 0) return '';
    return flatten(await btn.innerText().catch(() => ''));
  }

  /**
   * Selects a day and *confirms* the widget accepted it.
   *
   * The Kendo calendar is rendered inside an overlay that swallows the first
   * click, so a click that appears to succeed can leave the previous date
   * selected — which would attach the wrong times to a date. Instead of
   * guessing the widget's toggle semantics, this clicks and then verifies
   * `btnFecha` shows the expected date, retrying a couple of times.
   *
   * Returns false when the date could never be committed; the caller then
   * reports no times rather than stale ones.
   */
  async selectDate(date: AvailableDate): Promise<boolean> {
    const expected = isoToDisplayDate(date.iso);
    const day = this.root.locator(`a.k-link[data-value="${date.rawValue}"]`).first();
    const clickTimeout = Math.min(this.timeoutMs, 15_000);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.openPicker();
      await this.page.waitForTimeout(400);

      try {
        await day.click({ timeout: clickTimeout });
      } catch {
        await day.click({ force: true, timeout: clickTimeout }).catch(() => undefined);
      }

      if (await this.waitForSelectedDate(expected, 5_000)) return true;
    }

    return false;
  }

  /** Polls `btnFecha` until it displays `expected`. */
  private async waitForSelectedDate(expected: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.selectedDate()).includes(expected)) return true;
      if (Date.now() >= deadline) return false;
      await this.page.waitForTimeout(250);
    }
  }

  /** Expands the date picker. */
  async openPicker(): Promise<void> {
    const btn = this.page.locator(control('btnFecha')).filter(VISIBLE).first();
    if ((await btn.count()) > 0) await btn.click({ timeout: this.timeoutMs }).catch(() => undefined);
  }

  async goToNextMonth(): Promise<boolean> {
    const before = await this.currentMonth();
    const next = this.root.locator(SELECTOR.calendarNextMonth).first();
    if ((await next.count()) === 0) return false;
    await next.click({ timeout: this.timeoutMs }).catch(() => undefined);
    try {
      await this.page.waitForFunction(
        ([selector, previous]) => {
          const el = document.querySelector(`${selector} .k-nav-fast`);
          return !!el && (el.textContent ?? '').trim() !== previous;
        },
        [SELECTOR.calendarRoot, before] as const,
        { timeout: 10_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
}

/** `2026-08-12` → `12/08/2026`, the format `btnFecha` displays. */
export function isoToDisplayDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) return iso;
  return `${day}/${month}/${year}`;
}

/**
 * Checks whether an `Horas` option belongs to the given date.
 * The portal encodes it in the option value as `M/D/YYYY h:mm:ss AM`.
 * Values that do not parse are accepted, so a format change degrades to the
 * old behaviour instead of silently reporting zero times.
 */
export function timeOptionMatchesDate(optionValue: string, iso: string): boolean {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(optionValue.trim());
  if (!match) return true;
  const [, month, day, year] = match;
  const candidate = `${year}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
  return candidate === iso;
}

/** Converts Kendo's `YYYY/M/D` (0-based month) to an ISO `YYYY-MM-DD` date. */
export function kendoValueToIso(rawValue: string): string {
  const parts = rawValue.split('/');
  const year = Number(parts[0]);
  const monthIndex = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) return rawValue;
  const mm = String(monthIndex + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * The two screens that mean "the portal is still working".
 *
 *  - `#mpcWPdivCargando` — the dark "Cargando" overlay the player raises around
 *    every round-trip, on top of everything (z-index 21000).
 *  - `.splash` — the bootstrap screen, shown when the player rebuilds itself
 *    from scratch (session expired, page reloaded).
 *
 * While either is up the wizard has not answered yet, so nothing on the page
 * can be read as a verdict. Reading it anyway is what made the monitor alert on
 * a loading screen.
 */
export class BusyControl {
  constructor(private readonly page: Page) {}

  /** True while the "Cargando" overlay covers the page. */
  async isLoading(): Promise<boolean> {
    return (await this.page.locator(SELECTOR.loading).filter(VISIBLE).count().catch(() => 0)) > 0;
  }

  /** True while the player is bootstrapping (splash with the DIAN logo). */
  async isBootstrapping(): Promise<boolean> {
    return (await this.page.locator(SELECTOR.splash).filter(VISIBLE).count().catch(() => 0)) > 0;
  }

  async isBusy(): Promise<boolean> {
    return (await this.isLoading()) || (await this.isBootstrapping());
  }

  /** Waits for both indicators to clear. Returns false when they never do. */
  async waitUntilIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await this.isBusy())) return true;
      if (Date.now() >= deadline) return false;
      await this.page.waitForTimeout(200);
    }
  }
}

/** Labels that are buttons inside a modal, never the message itself. */
const MODAL_BUTTON_LABELS = /^(aceptar|cerrar|cancelar|continuar|volver|entendido|ok)$/i;

/**
 * The portal's info/error modal.
 *
 * Every control of the modal carries `pantalla="ModalError"` — the icon, the
 * close button, the message and the "Aceptar" button alike — so picking the
 * first match returns an empty string. We therefore collect *all* visible modal
 * controls and keep the longest text that is not a button label.
 */
export class ModalControl {
  constructor(private readonly page: Page) {}

  /** Returns the visible modal message, or `null` when no modal is shown. */
  async message(): Promise<string | null> {
    const texts = await this.page
      .locator(SELECTOR.modalScreen)
      .filter(VISIBLE)
      .evaluateAll((els) =>
        els.map((el) => ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()),
      )
      .catch(() => [] as string[]);

    const candidates = texts.filter((t) => t.length > 0 && !MODAL_BUTTON_LABELS.test(t));
    if (candidates.length === 0) return null;

    // The message control holds the longest text of the modal.
    const message = candidates.reduce((longest, current) =>
      current.length > longest.length ? current : longest,
    );
    return flatten(message);
  }

  /** True when a modal screen is on top of the wizard, message or not. */
  async isOpen(): Promise<boolean> {
    return (await this.page.locator(SELECTOR.modalScreen).filter(VISIBLE).count()) > 0;
  }

  /**
   * Waits briefly for a modal to appear. The portal renders it asynchronously
   * right after the selection round-trip, so a short poll avoids both a race
   * and a long fixed sleep.
   */
  async waitForMessage(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = await this.message();
      if (message) return message;
      if (Date.now() >= deadline) return null;
      await this.page.waitForTimeout(250);
    }
  }

  async dismiss(): Promise<void> {
    const button = this.page.locator(SELECTOR.modalButton).filter(VISIBLE).first();
    if ((await button.count()) > 0) await button.click().catch(() => undefined);
  }
}
