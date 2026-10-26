/**
 * Каталог каналов in-app уведомлений (зеркало server/src/utils/notificationSettings.js).
 */

export const NOTIFICATION_CHANNEL_MODES = [
  { value: 'all', label: 'Всем пользователям аккаунта' },
  { value: 'none', label: 'Никому' },
  { value: 'users', label: 'Выбранным пользователям' },
];

export const TELEGRAM_EVENTS = [
  {
    key: 'new_order',
    group: 'orders',
    title: 'Новые заказы',
    hint: 'Когда с маркетплейса или вручную появляется заказ.',
    defaultEnabled: true,
  },
  {
    key: 'sale',
    group: 'orders',
    title: 'Продажи',
    hint: 'Когда заказ переходит в статус «Доставлен».',
    defaultEnabled: true,
  },
  {
    key: 'order_cancelled',
    group: 'orders',
    title: 'Отмены заказов',
    hint: 'Когда заказ отменяют.',
    defaultEnabled: false,
  },
  {
    key: 'supplier_order_submit_failed',
    group: 'system',
    title: 'Ошибка отправки заказа поставщику',
    hint: 'Когда API поставщика не принял заказ или автозакупку.',
    defaultEnabled: false,
  },
  {
    key: 'competitor_price_below_cost',
    group: 'system',
    title: 'Цена конкурента ниже себестоимости',
    hint: 'Когда у отслеживаемого конкурента цена ниже себестоимости товара.',
    defaultEnabled: false,
  },
  {
    key: 'integration_tokens',
    group: 'system',
    title: 'Токены маркетплейсов',
    hint: 'Истёк, скоро истечёт или не проходит проверку.',
    defaultEnabled: false,
  },
  {
    key: 'certificates',
    group: 'system',
    title: 'Сертификаты',
    hint: 'Истёкшие и истекающие сертификаты.',
    defaultEnabled: false,
  },
  {
    key: 'marketplace_api_error',
    group: 'system',
    title: 'Ошибки API маркетплейсов',
    hint: 'Сбои запросов к Ozon / WB / Яндекс.Маркету.',
    defaultEnabled: false,
  },
  {
    key: 'mp_card_field_changed',
    group: 'system',
    title: 'Изменения карточки на маркетплейсе',
    hint: 'После импорта карточки, если на МП изменились поля.',
    defaultEnabled: false,
  },
  {
    key: 'system_jobs',
    group: 'system',
    title: 'Сбои фоновых задач',
    hint: 'Ошибки планировщика, комиссий и прочих системных jobs.',
    defaultEnabled: false,
  },
  {
    key: 'employee_birthday_soon',
    group: 'system',
    title: 'День рождения сотрудника',
    hint: 'За 10 дней до дня рождения.',
    defaultEnabled: false,
  },
];

function defaultTelegramEvents() {
  const events = {};
  for (const ev of TELEGRAM_EVENTS) events[ev.key] = ev.defaultEnabled === true;
  return events;
}

export function emptyTelegramSettings() {
  return {
    enabled: false,
    botToken: '',
    hasBotToken: false,
    botTokenHint: '',
    chatId: '',
    chatIds: [],
    events: defaultTelegramEvents(),
  };
}

function parseTelegramChatIds(raw) {
  const src = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  const out = [];
  const seen = new Set();
  for (const part of src.split(/[\s,;]+/)) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function parseClientTelegramSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const eventsIn = src.events && typeof src.events === 'object' && !Array.isArray(src.events) ? src.events : {};
  const events = {};
  for (const ev of TELEGRAM_EVENTS) {
    events[ev.key] = Object.prototype.hasOwnProperty.call(eventsIn, ev.key)
      ? eventsIn[ev.key] === true
      : ev.defaultEnabled === true;
  }
  const chatIds = parseTelegramChatIds(src.chatIds ?? src.chat_ids ?? src.chatId ?? src.chat_id);
  return {
    enabled: src.enabled === true,
    botToken: typeof src.botToken === 'string' ? src.botToken : '',
    hasBotToken: src.hasBotToken === true || Boolean(String(src.botToken || '').trim()),
    botTokenHint: typeof src.botTokenHint === 'string' ? src.botTokenHint : '',
    chatId: chatIds.join(', '),
    chatIds,
    events,
  };
}

export const NOTIFICATION_CHANNELS = [
  {
    key: 'employee_birthday_soon',
    title: 'День рождения сотрудника',
    hint: 'За 10 дней до дня рождения. Дата задаётся в карточке пользователя. О своём ДР уведомление не приходит.',
    defaultMode: 'none',
  },
  {
    key: 'competitor_price_below_cost',
    title: 'Цена конкурента ниже себестоимости',
    hint: 'Когда у отслеживаемого конкурента цена ниже себестоимости товара.',
    defaultMode: 'all',
  },
  {
    key: 'mp_card_field_changed',
    title: 'Изменения карточки на маркетплейсе',
    hint: 'После импорта карточки, если на МП изменились поля.',
    defaultMode: 'all',
  },
  {
    key: 'supplier_order_submit_failed',
    title: 'Ошибка отправки заказа поставщику',
    hint: 'Когда API поставщика не принял заказ или автозакупку.',
    defaultMode: 'all',
  },
  {
    key: 'integration_tokens',
    title: 'Токены маркетплейсов',
    hint: 'Истёк, скоро истечёт или не проходит проверку.',
    defaultMode: 'all',
  },
  {
    key: 'certificates',
    title: 'Сертификаты',
    hint: 'Истёкшие и истекающие сертификаты.',
    defaultMode: 'all',
  },
  {
    key: 'marketplace_api_error',
    title: 'Ошибки API маркетплейсов',
    hint: 'Сбои запросов к Ozon / WB / Яндекс.Маркету.',
    defaultMode: 'all',
  },
  {
    key: 'system_jobs',
    title: 'Сбои фоновых задач',
    hint: 'Ошибки планировщика, комиссий и прочих системных jobs.',
    defaultMode: 'all',
  },
];

function parseUserIdList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const n = Number(item);
    if (!Number.isFinite(n) || n <= 0) continue;
    const id = Math.trunc(n);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeMode(raw, fallback = 'all') {
  const m = String(raw || '').trim().toLowerCase();
  if (m === 'all' || m === 'none' || m === 'users') return m;
  return fallback;
}

function parseChannelConfig(raw, channelMeta) {
  const fallbackMode = channelMeta?.defaultMode || 'all';
  if (raw == null) return { mode: fallbackMode, userIds: [] };
  if (Array.isArray(raw)) {
    const userIds = parseUserIdList(raw);
    if (!userIds.length) return { mode: fallbackMode === 'none' ? 'none' : 'all', userIds: [] };
    return { mode: 'users', userIds };
  }
  if (typeof raw !== 'object') return { mode: fallbackMode, userIds: [] };
  const userIds = parseUserIdList(raw.userIds ?? raw.user_ids ?? raw.recipientUserIds);
  let mode = normalizeMode(raw.mode, fallbackMode);
  if (mode === 'users' && !userIds.length) {
    mode = fallbackMode === 'none' ? 'none' : 'all';
  }
  return { mode, userIds: mode === 'users' ? userIds : [] };
}

export function parseClientNotificationSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const channelsIn =
    src.channels && typeof src.channels === 'object' && !Array.isArray(src.channels)
      ? src.channels
      : {};
  const channels = {};
  for (const ch of NOTIFICATION_CHANNELS) {
    channels[ch.key] = parseChannelConfig(channelsIn[ch.key], ch);
  }

  const legacyBirthday = parseUserIdList(
    src.birthdayRecipientUserIds ?? src.birthday_recipient_user_ids
  );
  if (
    (src.birthdayRecipientUserIds != null || src.birthday_recipient_user_ids != null) &&
    channelsIn.employee_birthday_soon == null
  ) {
    channels.employee_birthday_soon = legacyBirthday.length
      ? { mode: 'users', userIds: legacyBirthday }
      : { mode: 'none', userIds: [] };
  }

  return { channels, telegram: parseClientTelegramSettings(src.telegram) };
}

export function notificationSettingsPayload(settings) {
  const parsed = parseClientNotificationSettings(settings);
  const channels = {};
  for (const ch of NOTIFICATION_CHANNELS) {
    const cfg = parsed.channels[ch.key] || { mode: ch.defaultMode, userIds: [] };
    channels[ch.key] = {
      mode: cfg.mode,
      userIds: cfg.mode === 'users' ? cfg.userIds || [] : [],
    };
  }
  const tg = parsed.telegram || emptyTelegramSettings();
  const events = {};
  for (const ev of TELEGRAM_EVENTS) {
    events[ev.key] = tg.events?.[ev.key] === true;
  }
  return {
    channels,
    telegram: {
      enabled: tg.enabled === true,
      botToken: String(tg.botToken || '').trim(),
      chatIds: parseTelegramChatIds(typeof tg.chatId === 'string' ? tg.chatId : tg.chatIds),
      events,
    },
  };
}
