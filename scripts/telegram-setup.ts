/**
 * Ayudante de configuración de Telegram.
 *
 *   npm run telegram:setup          → comprueba el bot y descubre tus chat_id
 *   npm run telegram:setup -- --test → además envía un mensaje de prueba
 *
 * Telegram no permite que un bot escriba primero: hasta que no le mandes un
 * mensaje, tu chat no existe para él. Este script te dice exactamente en qué
 * punto estás y qué falta.
 */
import 'dotenv/config';
import { splitList } from '../src/utils/text.js';

// Se lee el entorno en crudo a propósito: `loadConfig()` exige que el token y
// los chat_id vengan juntos, y este script existe precisamente para descubrir
// los chat_id cuando todavía no los tienes.
const token = (process.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
const sendTest = process.argv.includes('--test');
const line = (text = '') => console.log(text);

if (!token) {
  line('✗ Falta TELEGRAM_BOT_TOKEN en .env');
  line('  Créalo con @BotFather (/newbot) y pega el token en .env');
  process.exit(1);
}

/** Llama a la Bot API y devuelve el `result`, o lanza el error de Telegram. */
async function api<T>(method: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
  if (!payload.ok) throw new Error(payload.description ?? `HTTP ${response.status}`);
  return payload.result as T;
}

interface Chat {
  id: number;
  type: string;
  first_name?: string;
  title?: string;
  username?: string;
}

interface Update {
  message?: { chat: Chat };
  edited_message?: { chat: Chat };
  channel_post?: { chat: Chat };
}

line();
line('══════════ CONFIGURACIÓN DE TELEGRAM ══════════');
line();

// 1) ¿El token es válido?
try {
  const me = await api<{ username: string; first_name: string }>('getMe');
  line(`✓ Bot encontrado: @${me.username} (${me.first_name})`);
} catch (error) {
  line(`✗ El token no es válido: ${error instanceof Error ? error.message : String(error)}`);
  line('  Revisa TELEGRAM_BOT_TOKEN en .env, o pide uno nuevo a @BotFather.');
  process.exit(1);
}

// 2) ¿Quién le ha escrito?
const updates = await api<Update[]>('getUpdates');
const chats = new Map<number, Chat>();
for (const update of updates) {
  const chat = (update.message ?? update.edited_message ?? update.channel_post)?.chat;
  if (chat) chats.set(chat.id, chat);
}

line();
if (chats.size === 0) {
  line('✗ Ningún chat registrado todavía.');
  line();
  line('  Telegram no deja que un bot escriba primero. Haz esto:');
  line('    1. Abre Telegram y busca el bot por su nombre de usuario');
  line('    2. Pulsa "Iniciar" (o escríbele /start)');
  line('    3. Vuelve a ejecutar: npm run telegram:setup');
  process.exit(1);
}

line(`✓ ${chats.size} chat(s) registrado(s):`);
for (const chat of chats.values()) {
  const name = chat.first_name ?? chat.title ?? '(sin nombre)';
  const alias = chat.username ? ` @${chat.username}` : '';
  line(`    chat_id=${chat.id}  ${chat.type}  ${name}${alias}`);
}

const ids = [...chats.keys()].join(',');
line();
line('  Pon esto en tu .env (y en las variables de Railway):');
line(`    TELEGRAM_CHAT_IDS=${ids}`);

// 3) Prueba real, sólo si se pide explícitamente.
if (!sendTest) {
  line();
  line('  Para enviar un mensaje de prueba:  npm run telegram:setup -- --test');
  line();
  process.exit(0);
}

const configured = splitList(process.env['TELEGRAM_CHAT_IDS']);
const targets = configured.length > 0 ? configured : [...chats.keys()].map(String);

line();
line(`Enviando mensaje de prueba a ${targets.length} chat(s)…`);
for (const chatId of targets) {
  try {
    await api('sendMessage', {
      chat_id: chatId,
      text:
        '<b>✅ Monitor DIAN conectado</b>\n\n' +
        'Si lees esto, las alertas de citas llegarán por aquí.\n' +
        'Este es un mensaje de prueba; no significa que haya cupo.',
      parse_mode: 'HTML',
    });
    line(`  ✓ enviado a ${chatId}`);
  } catch (error) {
    line(`  ✗ falló ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
line();
