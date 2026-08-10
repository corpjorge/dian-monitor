import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { logger } from './logger.js';
import { fileStamp } from './time.js';

/**
 * Diagnostics captured when navigation fails. The point is to answer, from
 * Railway logs alone, "did DIAN change its interface?" — so we keep the
 * screenshot, the URL, the title and the visible text, and nothing personal.
 */

export interface DebugArtifacts {
  screenshotPath?: string;
  contextPath?: string;
}

export async function captureDebugArtifacts(
  page: Page | undefined,
  directory: string,
  label: string,
  error: unknown,
): Promise<DebugArtifacts> {
  if (!page || page.isClosed()) return {};
  const stamp = fileStamp();
  const base = path.join(directory, `${label}-${stamp}`);
  const artifacts: DebugArtifacts = {};

  try {
    await mkdir(directory, { recursive: true });

    const screenshotPath = `${base}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    artifacts.screenshotPath = screenshotPath;

    const context = {
      capturadoEn: new Date().toISOString(),
      url: page.url(),
      titulo: await page.title().catch(() => '(sin título)'),
      error: error instanceof Error ? { nombre: error.name, mensaje: error.message } : String(error),
      // Visible text only — enough to see which screen we were on, without
      // storing the full HTML (which would be large and needlessly detailed).
      textoVisible: await page
        .locator('body')
        .innerText()
        .then((t) => t.replace(/\s+\n/g, '\n').slice(0, 4_000))
        .catch(() => '(no disponible)'),
      controlesVisibles: await listVisibleControls(page).catch(() => []),
    };

    const contextPath = `${base}.json`;
    await writeFile(contextPath, JSON.stringify(context, null, 2), 'utf8');
    artifacts.contextPath = contextPath;

    logger.info('Diagnóstico guardado', { screenshot: screenshotPath, contexto: contextPath });
  } catch (captureError) {
    logger.warn('No se pudo guardar el diagnóstico', {
      error: captureError instanceof Error ? captureError.message : String(captureError),
    });
  }

  return artifacts;
}

/** Names of the player controls currently visible — the fastest change signal. */
export async function listVisibleControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[nombrecontrol]'))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => el.getAttribute('nombrecontrol') ?? '')
      .filter((name) => name !== ''),
  );
}

/** Screenshot of the final screen, kept on success when SCREENSHOT_ALWAYS=true. */
export async function captureScreenshot(
  page: Page,
  directory: string,
  label: string,
): Promise<string | undefined> {
  try {
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${label}-${fileStamp()}.png`);
    await page.screenshot({ path: target, fullPage: true });
    return target;
  } catch (error) {
    logger.warn('No se pudo tomar la captura', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
