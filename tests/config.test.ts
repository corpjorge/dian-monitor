import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { ConfigurationError } from '../src/utils/errors.js';
import { splitList } from '../src/utils/text.js';

/** Minimum viable environment; individual tests override what they exercise. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DIAN_TARGET_PERSON_TYPE: 'Persona Natural',
    DIAN_TARGET_ATTENTION_TYPE: 'Videoatención',
    ...overrides,
  };
}

describe('splitList', () => {
  it('separa varios destinatarios por coma', () => {
    expect(splitList('a@x.com,b@y.com,c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });

  it('recorta espacios y descarta entradas vacías', () => {
    expect(splitList(' a@x.com , , b@y.com ,')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('devuelve lista vacía cuando no hay valor', () => {
    expect(splitList(undefined)).toEqual([]);
    expect(splitList('')).toEqual([]);
  });
});

describe('loadConfig', () => {
  it('aplica los valores por defecto', () => {
    const config = loadConfig(env());
    expect(config.url).toContain('recurso=CitasDIAN');
    expect(config.headless).toBe(true);
    expect(config.dryRun).toBe(false);
    expect(config.cooldownMinutes).toBe(60);
    expect(config.storage.backend).toBe('json');
    expect(config.target.noAvailabilityMessage).toContain('No se encontraron especialidades');
  });

  it('exige el tipo de persona', () => {
    expect(() => loadConfig({ DIAN_TARGET_ATTENTION_TYPE: 'Videoatención' })).toThrow(ConfigurationError);
  });

  it('exige la modalidad', () => {
    expect(() => loadConfig({ DIAN_TARGET_PERSON_TYPE: 'Persona Natural' })).toThrow(ConfigurationError);
  });

  it('interpreta los booleanos en varias formas', () => {
    expect(loadConfig(env({ HEADLESS: 'false' })).headless).toBe(false);
    expect(loadConfig(env({ DRY_RUN: 'true' })).dryRun).toBe(true);
    expect(loadConfig(env({ DRY_RUN: 'sí' })).dryRun).toBe(true);
    expect(loadConfig(env({ DRY_RUN: '1' })).dryRun).toBe(true);
    expect(loadConfig(env({ DRY_RUN: 'no' })).dryRun).toBe(false);
  });

  it('habilita el correo sólo con las tres variables', () => {
    expect(loadConfig(env()).email.enabled).toBe(false);
    const complete = loadConfig(
      env({
        RESEND_API_KEY: 're_test_key_123456',
        EMAIL_FROM: 'monitor@ejemplo.com',
        EMAIL_TO: 'uno@ejemplo.com, dos@ejemplo.com',
      }),
    );
    expect(complete.email.enabled).toBe(true);
    expect(complete.email.to).toEqual(['uno@ejemplo.com', 'dos@ejemplo.com']);
  });

  it('rechaza una API key de correo sin destinatarios', () => {
    expect(() =>
      loadConfig(env({ RESEND_API_KEY: 're_test_key_123456', EMAIL_FROM: 'a@b.com' })),
    ).toThrow(ConfigurationError);
  });

  it('habilita Telegram con varios chats', () => {
    const config = loadConfig(
      env({ TELEGRAM_BOT_TOKEN: '123456789:AAaaBBbbCCccDDddEEeeFFffGGgg', TELEGRAM_CHAT_IDS: '111, 222' }),
    );
    expect(config.telegram.enabled).toBe(true);
    expect(config.telegram.chatIds).toEqual(['111', '222']);
  });

  it('rechaza un token de Telegram sin chats', () => {
    expect(() => loadConfig(env({ TELEGRAM_BOT_TOKEN: '123456789:AAaa' }))).toThrow(ConfigurationError);
  });

  it('rechaza números fuera de rango', () => {
    expect(() => loadConfig(env({ DIAN_SCAN_MONTHS: '99' }))).toThrow(ConfigurationError);
    expect(() => loadConfig(env({ MAX_ATTEMPTS: '0' }))).toThrow(ConfigurationError);
  });

  it('no incluye secretos en el resumen imprimible', async () => {
    const { describeConfig } = await import('../src/config/env.js');
    const config = loadConfig(
      env({
        RESEND_API_KEY: 're_super_secreto_123',
        EMAIL_FROM: 'a@b.com',
        EMAIL_TO: 'c@d.com',
        TELEGRAM_BOT_TOKEN: '123456789:tokensecreto',
        TELEGRAM_CHAT_IDS: '1',
      }),
    );
    const printed = JSON.stringify(describeConfig(config));
    expect(printed).not.toContain('re_super_secreto_123');
    expect(printed).not.toContain('tokensecreto');
  });
});
