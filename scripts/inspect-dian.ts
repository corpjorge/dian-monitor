/**
 * Interface explorer.
 *
 *   npm run inspect
 *
 * Walks the flow using the values in `.env` and prints, at every level, the
 * exact options the portal is offering right now. Use it to discover the
 * literal text to put in `DIAN_TARGET_SERVICE`, `DIAN_TARGET_PROCEDURE`,
 * `DIAN_TARGET_CITY` and `DIAN_TARGET_OFFICE` — and to check quickly whether
 * DIAN changed something.
 *
 * It never books anything: it only reads and reports.
 */
import { loadConfig } from '../src/config/env.js';
import { buildFlow } from '../src/dian/flow.js';
import { DianNavigator } from '../src/dian/navigator.js';
import { CONTROL } from '../src/dian/selectors.js';
import { createLogger } from '../src/utils/logger.js';

const config = loadConfig();
createLogger(config.logLevel);

const navigator = new DianNavigator(config);
const line = (text = '') => console.log(text);

try {
  await navigator.launch();
  await navigator.open();
  await navigator.startScheduling();

  const steps = buildFlow(config);
  line();
  line('══════════ EXPLORACIÓN DEL PORTAL DIAN ══════════');

  for (const step of steps) {
    const widget = step.kind === 'buttons' ? navigator.buttons(step.control) : navigator.dropdown(step.control);
    await widget.waitUntilReady().catch(() => undefined);
    const options = await widget.options().catch(() => []);

    line();
    line(`▸ ${step.title}  (control: ${step.control})`);
    if (options.length === 0) line('    (sin opciones visibles)');
    for (const option of options) line(`    · ${option.label}`);

    await navigator.applyStep(step);

    const modal = await navigator.modal().waitForMessage(3_000);
    if (modal) {
      line();
      line(`⚠ El portal respondió con un modal: "${modal}"`);
      line('  El recorrido se detiene aquí.');
      break;
    }

    if (step.advancesScreen) await navigator.advance().catch(() => undefined);
  }

  // Whatever came next, list it — this is where new trámites show up.
  for (const [title, name, kind] of [
    ['Tipo de servicio', CONTROL.service, 'buttons'],
    ['Trámite', CONTROL.procedure, 'select'],
    ['Ciudad', CONTROL.city, 'select'],
    ['Sede', CONTROL.office, 'select'],
    ['Horas', CONTROL.time, 'select'],
  ] as const) {
    const widget = kind === 'buttons' ? navigator.buttons(name) : navigator.dropdown(name);
    if (!(await widget.isPresent().catch(() => false))) continue;
    if (steps.some((s) => s.control === name)) continue;
    const options = await widget.options().catch(() => []);
    if (options.length === 0) continue;
    line();
    line(`▸ ${title} — disponible ahora (control: ${name})`);
    for (const option of options) line(`    · ${option.label}`);
  }

  const calendar = navigator.calendar();
  if (await calendar.isPresent().catch(() => false)) {
    line();
    line(`▸ Calendario — ${await calendar.currentMonth()}`);
    const dates = await calendar.availableDates();
    if (dates.length === 0) line('    (ningún día con cupo)');
    for (const date of dates) line(`    · ${date.label}  [${date.iso}]`);
  }

  line();
  line('═════════════════════════════════════════════════');
} finally {
  await navigator.close();
}
