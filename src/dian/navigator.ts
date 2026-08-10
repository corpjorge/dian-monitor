import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import type { AppConfig } from '../config/env.js';
import { CaptchaDetectedError, ElementNotFoundError, NavigationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { COLOMBIA_TZ } from '../utils/time.js';
import {
  ButtonListControl,
  CalendarControl,
  type ControlOption,
  ModalControl,
  SelectControl,
} from './controls.js';
import type { FlowStep } from './flow.js';
import { CAPTCHA_SELECTORS, CAPTCHA_TEXT_MARKERS, HOME_TILE_SCHEDULE, SELECTOR } from './selectors.js';

/**
 * Drives a real Chromium through the DIAN portal.
 *
 * Waiting strategy: the app is a single page that swaps screens in place, so
 * there is nothing to `waitForNavigation` on. Instead every step waits for the
 * *element it is about to use* to become visible, which is what makes the run
 * survive a slow connection without any fixed sleeps.
 */
export class DianNavigator {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(private readonly config: AppConfig) {}

  /** The live page, for diagnostics. Undefined before `launch()`. */
  get currentPage(): Page | undefined {
    return this.page;
  }

  private requirePage(): Page {
    if (!this.page) throw new NavigationError('El navegador no está inicializado.');
    return this.page;
  }

  async launch(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    this.context = await this.browser.newContext({
      locale: 'es-CO',
      timezoneId: COLOMBIA_TZ,
      viewport: { width: 1440, height: 1100 },
    });
    this.context.setDefaultTimeout(this.config.stepTimeoutMs);
    this.page = await this.context.newPage();
    logger.debug('Navegador iniciado', { headless: this.config.headless });
  }

  /** Always safe to call, even if `launch()` failed halfway through. */
  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    logger.debug('Navegador cerrado');
  }

  /** Loads the portal and waits for the player to finish bootstrapping. */
  async open(): Promise<void> {
    const page = this.requirePage();
    let response;
    try {
      response = await page.goto(this.config.url, {
        waitUntil: 'load',
        timeout: this.config.navTimeoutMs,
      });
    } catch (error) {
      throw new NavigationError(`No se pudo abrir el portal: ${describe(error)}`, { url: this.config.url });
    }

    const status = response?.status() ?? 0;
    if (status >= 400) {
      throw new NavigationError(`El portal respondió HTTP ${status}.`, { url: this.config.url, status });
    }

    // The player shows a splash until its dashboard definition is rendered.
    await page
      .locator(SELECTOR.splash)
      .waitFor({ state: 'hidden', timeout: this.config.navTimeoutMs })
      .catch(() => logger.debug('El splash no se ocultó; se continúa con la espera de controles.'));

    await this.assertNoCaptcha();

    try {
      await page
        .locator(SELECTOR.homeTile)
        .filter({ visible: true })
        .first()
        .waitFor({ state: 'visible', timeout: this.config.stepTimeoutMs });
    } catch {
      throw new NavigationError('El portal cargó pero no se renderizó la pantalla de inicio.', {
        url: page.url(),
      });
    }

    logger.info('Portal cargado', { titulo: await page.title() });
  }

  /** Clicks the "Agendar cita" tile and waits for the first control. */
  async startScheduling(): Promise<void> {
    const page = this.requirePage();
    const tile = page.locator(SELECTOR.homeTile).filter({ hasText: HOME_TILE_SCHEDULE }).first();
    try {
      await tile.click({ timeout: this.config.stepTimeoutMs });
    } catch {
      throw new ElementNotFoundError(`No se encontró el botón "${HOME_TILE_SCHEDULE}".`);
    }
    logger.info(`Clic en "${HOME_TILE_SCHEDULE}"`);
  }

  buttons(name: string): ButtonListControl {
    return new ButtonListControl(this.requirePage(), name, this.config.stepTimeoutMs);
  }

  dropdown(name: string): SelectControl {
    return new SelectControl(this.requirePage(), name, this.config.stepTimeoutMs);
  }

  calendar(): CalendarControl {
    return new CalendarControl(this.requirePage(), this.config.stepTimeoutMs);
  }

  /** Short pause used while polling the portal for asynchronous updates. */
  async wait(ms: number): Promise<void> {
    await this.requirePage().waitForTimeout(ms);
  }

  modal(): ModalControl {
    return new ModalControl(this.requirePage());
  }

  /** Applies one configured step and returns the option actually selected. */
  async applyStep(step: FlowStep): Promise<ControlOption> {
    const widget = step.kind === 'buttons' ? this.buttons(step.control) : this.dropdown(step.control);
    const selected = await widget.select(step.value);
    logger.info(`${step.title} seleccionado: ${selected.label}`);
    await this.settle();
    return selected;
  }

  /** Lists what a control currently offers — used for diagnostics and reports. */
  async optionsOf(step: FlowStep): Promise<ControlOption[]> {
    const widget = step.kind === 'buttons' ? this.buttons(step.control) : this.dropdown(step.control);
    if (!(await widget.isPresent())) return [];
    return widget.options();
  }

  /** Clicks "Siguiente"; waits for it to be enabled first. */
  async advance(): Promise<void> {
    const page = this.requirePage();
    const button = page.locator(SELECTOR.nextEnabled).filter({ visible: true }).first();
    try {
      await button.waitFor({ state: 'visible', timeout: this.config.stepTimeoutMs });
    } catch {
      throw new ElementNotFoundError(
        'El botón "Siguiente" nunca se habilitó: falta completar algún dato de la pantalla.',
      );
    }
    await button.click({ timeout: this.config.stepTimeoutMs });
    logger.info('Avanzando a la siguiente pantalla');
    await this.settle();
  }

  /**
   * Waits for the portal to finish the round-trip triggered by a selection.
   * Each choice fires a `Player.aspx/ValidadorValidar` POST; once the network
   * is quiet the newly revealed control is in the DOM.
   */
  async settle(): Promise<void> {
    const page = this.requirePage();
    await page.waitForLoadState('networkidle', { timeout: this.config.stepTimeoutMs }).catch(() => undefined);
    await this.assertNoCaptcha();
  }

  /**
   * Detects CAPTCHA / anti-bot challenges. This project deliberately does not
   * solve them: it reports and stops so a human can look.
   */
  async assertNoCaptcha(): Promise<void> {
    const page = this.requirePage();

    for (const selector of CAPTCHA_SELECTORS) {
      const count = await page.locator(selector).filter({ visible: true }).count().catch(() => 0);
      if (count > 0) {
        throw new CaptchaDetectedError('Se detectó un mecanismo anti-bot (CAPTCHA) en el portal.', {
          selector,
          url: page.url(),
        });
      }
    }

    const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    const marker = CAPTCHA_TEXT_MARKERS.find((m) => text.includes(m));
    if (marker) {
      throw new CaptchaDetectedError('Se detectó una verificación anti-bot en el portal.', {
        marcador: marker,
        url: page.url(),
      });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
