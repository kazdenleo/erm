/**
 * Настройки in-app уведомлений на уровне profile.
 * Каналы: mode = all | none | users (+ userIds).
 */

export const NOTIFICATION_CHANNEL_MODES = ['all', 'none', 'users'];

/** Каталог настраиваемых каналов (UI + фильтрация). */
export const NOTIFICATION_CHANNELS = [
  {
    key: 'employee_birthday_soon',
    title: 'День рождения сотрудника',
    hint: 'За 10 дней до дня рождения. Дата задаётся в карточке пользователя. О своём ДР уведомление не приходит.',
    defaultMode: 'none',
    types: ['employee_birthday_soon'],
  },
  {
    key: 'competitor_price_below_cost',
    title: 'Цена конкурента ниже себестоимости',
    hint: 'Когда у отслеживаемого конкурента цена ниже себестоимости товара.',
    defaultMode: 'all',
    types: ['competitor_price_below_cost'],
  },
  {
    key: 'mp_card_field_changed',
    title: 'Изменения карточки на маркетплейсе',
    hint: 'После импорта карточки, если на МП изменились поля.',
    defaultMode: 'all',
    types: ['mp_card_field_changed'],
  },
  {
    key: 'supplier_order_submit_failed',
    title: 'Ошибка отправки заказа поставщику',
    hint: 'Когда API поставщика не принял заказ или автозакупку.',
    defaultMode: 'all',
    types: ['supplier_order_submit_failed'],
  },
  {
    key: 'integration_tokens',
    title: 'Токены маркетплейсов',
    hint: 'Истёк, скоро истечёт или не проходит проверку.',
    defaultMode: 'all',
    types: ['token_expired', 'token_expires_soon', 'token_invalid'],
  },
  {
    key: 'certificates',
    title: 'Сертификаты',
    hint: 'Истёкшие и истекающие сертификаты.',
    defaultMode: 'all',
    types: ['certificate_expired', 'certificate_expires_soon'],
  },
  {
    key: 'marketplace_api_error',
    title: 'Ошибки API маркетплейсов',
    hint: 'Сбои запросов к Ozon / WB / Яндекс.Маркету.',
    defaultMode: 'all',
    types: ['marketplace_api_error'],
  },
  {
    key: 'system_jobs',
    title: 'Сбои фоновых задач',
    hint: 'Ошибки планировщика, комиссий и прочих системных jobs.',
    defaultMode: 'all',
    types: [
      'job_failed',
      'error',
      'commission_cache_missing',
      'commission_cache_stale',
      'commission_refresh_degraded',
      'commission_refresh_failed',
      'commission_empty_overwrite_blocked',
    ],
  },
];

export const BIRTHDAY_NOTIFY_DAYS_BEFORE = 10;

const CHANNEL_BY_KEY = new Map(NOTIFICATION_CHANNELS.map((c) => [c.key, c]));
const CHANNEL_BY_TYPE = new Map();
for (const ch of NOTIFICATION_CHANNELS) {
  for (const t of ch.types) CHANNEL_BY_TYPE.set(t, ch.key);
}

function parseObject(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

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
  if (NOTIFICATION_CHANNEL_MODES.includes(m)) return m;
  return fallback;
}

export function channelKeyForNotificationType(type) {
  const t = String(type || '').trim();
  if (!t) return null;
  if (CHANNEL_BY_TYPE.has(t)) return CHANNEL_BY_TYPE.get(t);
  if (t.startsWith('commission_')) return 'system_jobs';
  return null;
}

export function defaultChannelConfig(channelKey) {
  const meta = CHANNEL_BY_KEY.get(channelKey);
  const mode = meta?.defaultMode || 'all';
  return { mode, userIds: [] };
}

function parseChannelConfig(raw, channelKey) {
  const fallback = defaultChannelConfig(channelKey);
  if (raw == null) return { ...fallback };
  if (Array.isArray(raw)) {
    const userIds = parseUserIdList(raw);
    if (!userIds.length) return { mode: fallback.mode === 'none' ? 'none' : 'all', userIds: [] };
    return { mode: 'users', userIds };
  }
  if (typeof raw !== 'object') return { ...fallback };
  const userIds = parseUserIdList(raw.userIds ?? raw.user_ids ?? raw.recipientUserIds);
  let mode = normalizeMode(raw.mode, fallback.mode);
  if (mode === 'users' && !userIds.length) {
    mode = fallback.mode === 'none' ? 'none' : 'all';
  }
  return { mode, userIds: mode === 'users' ? userIds : [] };
}

export function parseNotificationSettings(raw) {
  const src = parseObject(raw);
  const channelsIn = parseObject(src.channels ?? src.recipientsByType ?? src.recipients_by_type);
  const channels = {};
  for (const ch of NOTIFICATION_CHANNELS) {
    channels[ch.key] = parseChannelConfig(channelsIn[ch.key], ch.key);
  }

  // Совместимость со старым полем birthdayRecipientUserIds
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

  return { channels };
}

export function mergeNotificationSettings(current, incoming) {
  const base = parseNotificationSettings(current);
  const patch = incoming && typeof incoming === 'object' ? incoming : {};
  const next = parseNotificationSettings({
    channels: { ...base.channels },
  });

  const patchChannels = parseObject(patch.channels ?? patch.recipientsByType);
  for (const ch of NOTIFICATION_CHANNELS) {
    if (Object.prototype.hasOwnProperty.call(patchChannels, ch.key)) {
      next.channels[ch.key] = parseChannelConfig(patchChannels[ch.key], ch.key);
    }
  }

  if (
    patch.birthdayRecipientUserIds !== undefined ||
    patch.birthday_recipient_user_ids !== undefined
  ) {
    const ids = parseUserIdList(
      patch.birthdayRecipientUserIds ?? patch.birthday_recipient_user_ids
    );
    next.channels.employee_birthday_soon = ids.length
      ? { mode: 'users', userIds: ids }
      : { mode: 'none', userIds: [] };
  }

  return next;
}

export function getChannelConfig(settings, channelKey) {
  const parsed = parseNotificationSettings(settings);
  return parsed.channels[channelKey] || defaultChannelConfig(channelKey);
}

/** Список userId для рассылки (пустой = никому). mode=all → null (всем). */
export function resolveRecipientUserIds(settings, channelKey) {
  const cfg = getChannelConfig(settings, channelKey);
  if (cfg.mode === 'none') return [];
  if (cfg.mode === 'all') return null;
  return cfg.userIds || [];
}

/**
 * Видно ли уведомление пользователю по настройкам канала.
 * Приглашения (target_user_id) и неизвестные типы не режем здесь.
 */
export function isNotificationVisibleToUser(settings, type, userId) {
  const channelKey = channelKeyForNotificationType(type);
  if (!channelKey) return true;
  const cfg = getChannelConfig(settings, channelKey);
  if (cfg.mode === 'none') return false;
  if (cfg.mode === 'all') return true;
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return false;
  return (cfg.userIds || []).includes(uid);
}
