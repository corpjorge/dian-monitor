import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import type { AvailabilityResult } from '../src/dian/availability.js';
import type { RunReport } from '../src/notifications/report.js';
import { TelegramNotifier } from '../src/notifications/telegram.js';

/**
 * Exercises the delivery path by intercepting `fetch`, so the multipart upload
 * and the caption-splitting logic are verified without a real bot token.
 */

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ';

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    DIAN_TARGET_PERSON_TYPE: 'Persona Natural',
    DIAN_TARGET_ATTENTION_TYPE: 'Videoatención',
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_IDS: '111',
    MAX_ATTEMPTS: '1',
    ...overrides,
  });
}

function availability(overrides: Partial<AvailabilityResult> = {}): AvailabilityResult {
  return {
    available: false,
    detectedAt: '2026-08-09T23:00:00.000Z',
    city: '',
    procedure: '',
    service: 'Devoluciones',
    attentionType: 'Videoatención',
    personType: 'Persona Natural',
    office: '',
    dates: [],
    reason: 'sin-especialidades',
    message: 'No se encontraron especialidades relacionadas según los filtros seleccionados.',
    stepsCompleted: [],
    discoveredOptions: [],
    ...overrides,
  };
}

interface Captured {
  url: string;
  body: unknown;
}

/** Replaces `fetch` and records what the notifier tried to send. */
function stubFetch(responder: (url: string) => Response): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    calls.push({ url, body: init?.body });
    return responder(url);
  }) as unknown as typeof fetch;
  return calls;
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

async function makeScreenshot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dian-test-'));
  const file = path.join(dir, 'captura.png');
  // A minimal but valid 1×1 PNG.
  await writeFile(
    file,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  return file;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('TelegramNotifier', () => {
  it('envía la captura como foto con el texto de pie', async () => {
    const calls = stubFetch(ok);
    const screenshotPath = await makeScreenshot();
    const report: RunReport = { kind: 'unavailable', result: availability(), screenshotPath };

    await new TelegramNotifier(config()).send(report);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/sendPhoto');
    const form = calls[0]!.body as FormData;
    expect(form.get('chat_id')).toBe('111');
    expect(form.get('parse_mode')).toBe('HTML');
    expect(String(form.get('caption'))).toContain('sin cupo todavía');
    expect(form.get('photo')).toBeInstanceOf(Blob);
  });

  it('envía solo texto cuando no hay captura', async () => {
    const calls = stubFetch(ok);

    await new TelegramNotifier(config()).send({ kind: 'unavailable', result: availability() });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/sendMessage');
  });

  it('respeta TELEGRAM_SEND_SCREENSHOT=false', async () => {
    const calls = stubFetch(ok);
    const screenshotPath = await makeScreenshot();

    await new TelegramNotifier(config({ TELEGRAM_SEND_SCREENSHOT: 'false' })).send({
      kind: 'unavailable',
      result: availability(),
      screenshotPath,
    });

    expect(calls[0]!.url).toContain('/sendMessage');
  });

  it('parte el mensaje cuando no cabe en el pie de foto', async () => {
    const calls = stubFetch(ok);
    const screenshotPath = await makeScreenshot();
    // Telegram limita el pie a 1024 caracteres; muchas horas lo superan.
    const dates = Array.from({ length: 12 }, (_, i) => ({
      date: `2026-08-${String(i + 10).padStart(2, '0')}`,
      label: `día ${i + 10} de agosto de 2026`,
      times: Array.from({ length: 12 }, (_, j) => `${7 + j}:15 AM`),
    }));

    await new TelegramNotifier(config()).send({
      kind: 'available',
      isRepeat: false,
      result: availability({ available: true, reason: 'fechas-encontradas', dates }),
      screenshotPath,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('/sendPhoto');
    expect(String((calls[0]!.body as FormData).get('caption')).length).toBeLessThanOrEqual(1024);
    expect(calls[1]!.url).toContain('/sendMessage');
  });

  it('si falla la foto, envía el texto de todas formas', async () => {
    const calls = stubFetch((url) =>
      url.includes('/sendPhoto') ? new Response('too big', { status: 413 }) : ok(),
    );
    const screenshotPath = await makeScreenshot();

    await new TelegramNotifier(config()).send({
      kind: 'unavailable',
      result: availability(),
      screenshotPath,
    });

    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['sendPhoto', 'sendMessage']);
  });

  it('envía a todos los chats configurados', async () => {
    const calls = stubFetch(ok);

    await new TelegramNotifier(config({ TELEGRAM_CHAT_IDS: '111,222,333' })).send({
      kind: 'unavailable',
      result: availability(),
    });

    expect(calls).toHaveLength(3);
  });

  it('un chat inválido no impide el envío a los demás', async () => {
    let seen = 0;
    stubFetch(() => (++seen === 1 ? new Response('chat not found', { status: 400 }) : ok()));

    await expect(
      new TelegramNotifier(config({ TELEGRAM_CHAT_IDS: '111,222' })).send({
        kind: 'unavailable',
        result: availability(),
      }),
    ).resolves.toBeUndefined();
  });

  it('no filtra el token cuando Telegram devuelve un error', async () => {
    stubFetch(() => new Response('bad request', { status: 400 }));

    const error = await new TelegramNotifier(config())
      .send({ kind: 'error', error: 'fallo' })
      .catch((e: unknown) => e);

    expect(String(error)).not.toContain(TOKEN);
  });

  it('en DRY_RUN no hace ninguna llamada', async () => {
    const calls = stubFetch(ok);

    await new TelegramNotifier(config({ DRY_RUN: 'true' })).send({
      kind: 'unavailable',
      result: availability(),
    });

    expect(calls).toHaveLength(0);
  });
});
