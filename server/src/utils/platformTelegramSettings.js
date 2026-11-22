/**
 * Telegram суперадмина (платформа): хранится в platform_notification_settings.secrets.telegram.
 * Env-fallback: PLATFORM_TELEGRAM_BOT_TOKEN, PLATFORM_TELEGRAM_CHAT_IDS.
 */

import { parseTelegramChatIds } from './notificationSettings.js';

export const PLATFORM_TELEGRAM_EVENTS = [
  {
    key: 'public_signup',
    title: 'Регистрация аккаунта',
    hint: 'Когда кто-то создаёт аккаунт через публичную форму /register.',
    defaultEnabled: true,
  },
];

function parseBotToken(raw, previousToken) {
  const prev = String(previousToken || '').trim();
  const next = String(raw ?? '').trim();
  if (!next) return prev;
  if (/^[•*·.]+$/.test(next) || next.startsWith('…') || next.startsWith('...')) return prev;
  if (next.length > 256) return prev;
  return next;
}

export function defaultPlatformTelegram() {
  const events = {};
  for (const ev of PLATFORM_TELEGRAM_EVENTS) events[ev.key] = ev.defaultEnabled === true;
  return {
    enabled: false,
    botToken: '',
    chatIds: [],
    events,
  };
}

export function parsePlatformTelegram(raw, previous = null) {
  const prev = previous && typeof previous === 'object' ? previous : defaultPlatformTelegram();
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!src) {
    return {
      enabled: prev.enabled === true,
      botToken: String(prev.botToken || ''),
      chatIds: parseTelegramChatIds(prev.chatIds),
      events: { ...defaultPlatformTelegram().events, ...(prev.events || {}) },
    };
  }
  const eventsIn =
    src.events && typeof src.events === 'object' && !Array.isArray(src.events) ? src.events : {};
  const events = {};
  for (const ev of PLATFORM_TELEGRAM_EVENTS) {
    if (Object.prototype.hasOwnProperty.call(eventsIn, ev.key)) {
      events[ev.key] = eventsIn[ev.key] === true;
    } else if (prev.events && Object.prototype.hasOwnProperty.call(prev.events, ev.key)) {
      events[ev.key] = prev.events[ev.key] === true;
    } else {
      events[ev.key] = ev.defaultEnabled === true;
    }
  }
  const chatRaw = src.chatIds ?? src.chat_ids ?? src.chatId ?? src.chat_id;
  return {
    enabled: src.enabled === undefined ? prev.enabled === true : src.enabled === true,
    botToken: parseBotToken(src.botToken ?? src.bot_token, prev.botToken),
    chatIds: chatRaw === undefined ? parseTelegramChatIds(prev.chatIds) : parseTelegramChatIds(chatRaw),
    events,
  };
}

/** Для ответа API: токен не отдаём. */
export function platformTelegramForClient(raw) {
  const parsed = parsePlatformTelegram(raw, null);
  const token = String(parsed.botToken || '');
  return {
    enabled: parsed.enabled === true,
    hasBotToken: Boolean(token),
    botTokenHint: token ? `…${token.slice(-4)}` : '',
    chatIds: parsed.chatIds,
    events: { ...parsed.events },
  };
}

function envTelegramFallback() {
  const token = String(process.env.PLATFORM_TELEGRAM_BOT_TOKEN || '').trim();
  const chatIds = parseTelegramChatIds(process.env.PLATFORM_TELEGRAM_CHAT_IDS || '');
  if (!token || !chatIds.length) return null;
  return { botToken: token, chatIds };
}

/**
 * Куда слать: сохранённые настройки, иначе env.
 * override — для тестовой отправки из UI (пустой токен не затирает).
 */
export function resolvePlatformTelegramSendTarget(storedTelegram, override = {}) {
  const stored = parsePlatformTelegram(storedTelegram, null);
  const src = override && typeof override === 'object' ? override : {};
  const token = parseBotToken(src.botToken ?? src.bot_token, stored.botToken);
  const chatRaw = src.chatId ?? src.chat_id ?? src.chatIds ?? src.chat_ids;
  const chatText = Array.isArray(chatRaw) ? chatRaw.join(',') : String(chatRaw ?? '');
  let chatIds = chatText.trim() ? parseTelegramChatIds(chatText) : stored.chatIds;
  if (token && chatIds.length) return { token, chatIds, source: 'settings' };
  const env = envTelegramFallback();
  if (env) return { token: env.botToken, chatIds: env.chatIds, source: 'env' };
  return { token: token || '', chatIds, source: 'none' };
}

/**
 * Можно ли слать событие: либо включено в UI с токеном/чатом, либо есть env-fallback
 * (и событие не выключено явно в сохранённых events).
 */
export function isPlatformTelegramEventEnabled(storedTelegram, eventKey) {
  const key = String(eventKey || '').trim();
  if (!PLATFORM_TELEGRAM_EVENTS.some((e) => e.key === key)) return false;
  const tg = parsePlatformTelegram(storedTelegram, null);
  const eventOn = tg.events?.[key] === true;
  if (tg.enabled === true && tg.botToken && tg.chatIds?.length) return eventOn;
  if (!envTelegramFallback()) return false;
  if (tg.enabled === false && tg.botToken) return false;
  return eventOn;
}
