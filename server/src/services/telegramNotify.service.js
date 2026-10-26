/**
 * Отправка уведомлений аккаунта в Telegram (Bot API).
 * Токен и chat id хранятся в profiles.notification_settings.telegram.
 */

import fetch from 'node-fetch';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import {
  channelKeyForNotificationType,
  isTelegramEventEnabled,
  parseNotificationSettings,
} from '../utils/notificationSettings.js';

/** Новый заказ старше этого срока при первой загрузке истории не шлём. */
export const ORDER_TELEGRAM_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

const DEDUPE_MS = 30 * 60 * 1000;
const recentSends = new Map();

const EVENT_TITLE = {
  new_order: ['Новый заказ', 'Новые заказы'],
  sale: ['Продажа', 'Продажи'],
  order_cancelled: ['Заказ отменён', 'Отмены заказов'],
};

const MP_LABEL = {
  ozon: 'Ozon',
  wildberries: 'Wildberries',
  wb: 'Wildberries',
  yandex: 'Яндекс.Маркет',
  ym: 'Яндекс.Маркет',
  manual: 'Вручную',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normStatus(status) {
  return String(status ?? '').trim().toLowerCase();
}

function normMarketplace(mp) {
  const m = String(mp || '').toLowerCase();
  if (m === 'wb') return 'wildberries';
  if (m === 'ym') return 'yandex';
  return m || 'ozon';
}

function marketplaceLabel(mp) {
  const key = normMarketplace(mp);
  return MP_LABEL[key] || MP_LABEL[mp] || key;
}

export function orderLineKey(row, profileIdFallback) {
  const oid = row?.orderId ?? row?.order_id;
  if (oid == null || String(oid).trim() === '') return '';
  const pid = row?.profileId ?? row?.profile_id ?? profileIdFallback ?? '';
  return `${pid}|${normMarketplace(row?.marketplace)}:${oid}`;
}

function orderGroupKey(row) {
  const mp = normMarketplace(row?.marketplace);
  const oid = String(row?.orderId ?? row?.order_id ?? '');
  const base = oid.split('~')[0];
  if (mp === 'manual') {
    const gid = row?.orderGroupId ?? row?.order_group_id ?? base;
    return `${mp}:${gid}`;
  }
  return `${mp}:${base || oid}`;
}

function displayOrderId(row) {
  const oid = String(row?.orderId ?? row?.order_id ?? '');
  const base = oid.split('~')[0];
  if (normMarketplace(row?.marketplace) === 'manual') {
    const gid = row?.orderGroupId ?? row?.order_group_id;
    if (gid) return String(gid);
  }
  return base || oid;
}

function isFreshOrder(row, now) {
  const raw = row?.createdAt ?? row?.created_at ?? row?.inProcessAt ?? row?.in_process_at;
  const t = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(t)) return false;
  return t <= now + 60_000 && now - t <= ORDER_TELEGRAM_FRESH_MS;
}

function isCancelledStatus(status) {
  return status === 'cancelled' || status === 'заказ удалён';
}

function formatMoney(amount) {
  const v = Number(amount);
  const n = Number.isFinite(v) ? v : 0;
  const text = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
  return `${text} ₽`;
}

function lineSum(line) {
  const qty = Math.max(1, Number(line.quantity) || 1);
  const price = Number(line.price) || 0;
  return price * qty;
}

/**
 * Какие события появились в пачке заказов относительно уже известных строк.
 * previousRows — снимок до upsert (статусы до изменения).
 */
export function diffOrdersForTelegram(rows, previousRows, options = {}) {
  const now = options.now ?? Date.now();
  const assumeFresh = options.assumeFresh === true;
  const profileIdFallback = options.profileId;
  const prev = new Map();
  for (const row of previousRows || []) {
    const key = orderLineKey(row, profileIdFallback);
    if (!key || prev.has(key)) continue;
    prev.set(key, normStatus(row?.status));
  }

  const buckets = {
    new_order: new Map(),
    sale: new Map(),
    order_cancelled: new Map(),
  };

  for (const row of rows || []) {
    const key = orderLineKey(row, profileIdFallback);
    if (!key) continue;
    const status = normStatus(row?.status);
    const had = prev.has(key);
    const prevStatus = had ? prev.get(key) : null;
    let event = null;
    if (!had) {
      if (!assumeFresh && !isFreshOrder(row, now)) continue;
      if (status === 'delivered') event = 'sale';
      else if (isCancelledStatus(status)) event = 'order_cancelled';
      else event = 'new_order';
    } else if (status === 'delivered' && prevStatus !== 'delivered') {
      event = 'sale';
    } else if (isCancelledStatus(status) && !isCancelledStatus(prevStatus)) {
      event = 'order_cancelled';
    }
    if (!event) continue;

    const gkey = orderGroupKey(row);
    const map = buckets[event];
    if (!map.has(gkey)) {
      map.set(gkey, {
        marketplace: normMarketplace(row?.marketplace),
        orderId: displayOrderId(row),
        lines: [],
      });
    }
    const qty = Math.max(1, parseInt(row?.quantity, 10) || 1);
    const price = Number(row?.price);
    map.get(gkey).lines.push({
      name: String(row?.productName ?? row?.product_name ?? 'Товар').trim() || 'Товар',
      quantity: qty,
      price: Number.isFinite(price) ? price : 0,
    });
  }

  return {
    new_order: [...buckets.new_order.values()],
    sale: [...buckets.sale.values()],
    order_cancelled: [...buckets.order_cancelled.values()],
  };
}

export function formatOrderEventMessages(eventKey, groups) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return [];
  const titles = EVENT_TITLE[eventKey] || ['Уведомление', 'Уведомления'];
  const shown = list.slice(0, 20);
  const hidden = list.length - shown.length;
  const title = shown.length > 1 ? titles[1] : titles[0];
  const blocks = shown.map((group) => {
    const lines = (group.lines || []).slice(0, 8).map((line) => {
      const qty = Math.max(1, Number(line.quantity) || 1);
      return `• ${escapeHtml(line.name)} — ${qty} шт, ${formatMoney(lineSum(line))}`;
    });
    const moreLines = (group.lines || []).length - lines.length;
    if (moreLines > 0) lines.push(`• и ещё ${moreLines}`);
    const total = (group.lines || []).reduce((sum, line) => sum + lineSum(line), 0);
    const head = `<b>${escapeHtml(marketplaceLabel(group.marketplace))}</b> · <code>${escapeHtml(group.orderId)}</code>`;
    return [head, ...lines, `Итого: ${formatMoney(total)}`].join('\n');
  });
  let text = `<b>${escapeHtml(title)}</b>${shown.length > 1 ? ` (${shown.length})` : ''}\n\n${blocks.join('\n\n')}`;
  if (hidden > 0) text += `\n\nи ещё ${hidden}`;
  if (text.length <= 3900) return [text];
  const chunks = [];
  let current = `<b>${escapeHtml(title)}</b>`;
  for (const block of blocks) {
    const next = `${current}\n\n${block}`;
    if (next.length > 3900 && current.length > title.length + 10) {
      chunks.push(current);
      current = `<b>${escapeHtml(title)}</b>\n\n${block}`;
    } else {
      current = next;
    }
  }
  if (hidden > 0) current += `\n\nи ещё ${hidden}`;
  chunks.push(current);
  return chunks;
}

function rememberSend(dedupeKey) {
  const now = Date.now();
  const prev = recentSends.get(dedupeKey);
  if (prev && now - prev < DEDUPE_MS) return false;
  recentSends.set(dedupeKey, now);
  if (recentSends.size > 4000) {
    for (const [key, ts] of recentSends) {
      if (now - ts > DEDUPE_MS) recentSends.delete(key);
    }
  }
  return true;
}

export async function sendTelegramMessage(botToken, chatId, text) {
  const token = String(botToken || '').trim();
  const chat = String(chatId || '').trim();
  const body = String(text || '').trim();
  if (!token || !chat || !body) return { ok: false, error: 'Не заданы токен, чат или текст' };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12000);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: body.slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: abort.signal,
    });
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, error: aborted ? 'Telegram не ответил вовремя' : e?.message || 'Нет связи с Telegram' };
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || data?.ok === false) {
    const desc = String(data?.description || `HTTP ${response.status}`).slice(0, 300);
    return { ok: false, error: desc };
  }
  return { ok: true };
}

async function loadTelegramConfig(profileId) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const result = await query(
    `SELECT notification_settings FROM profiles WHERE id = $1 LIMIT 1`,
    [pid]
  );
  return parseNotificationSettings(result.rows?.[0]?.notification_settings).telegram;
}

async function sendToChats(config, messages) {
  const texts = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
  if (!config?.botToken || !config.chatIds?.length || !texts.length) return;
  for (const chatId of config.chatIds) {
    for (const text of texts) {
      const result = await sendTelegramMessage(config.botToken, chatId, text);
      if (!result.ok) {
        logger?.warn?.(`[Telegram] не отправлено в ${chatId}: ${result.error}`);
      }
    }
  }
}

export async function notifyOrderChanges({
  profileId,
  rows,
  previousRows,
  assumeFresh = false,
  now,
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;

  const byProfile = new Map();
  for (const row of list) {
    const pid = Number(profileId ?? row?.profileId ?? row?.profile_id);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!byProfile.has(pid)) byProfile.set(pid, []);
    byProfile.get(pid).push(row);
  }

  for (const [pid, groupRows] of byProfile) {
    const config = await loadTelegramConfig(pid);
    if (!config?.enabled || !config.botToken || !config.chatIds?.length) continue;
    const diff = diffOrdersForTelegram(groupRows, previousRows, {
      profileId: pid,
      assumeFresh,
      now,
    });
    for (const eventKey of ['new_order', 'sale', 'order_cancelled']) {
      if (config.events?.[eventKey] !== true) continue;
      const groups = (diff[eventKey] || []).filter((group) =>
        rememberSend(`${pid}|${eventKey}|${group.marketplace}|${group.orderId}`)
      );
      if (!groups.length) continue;
      await sendToChats(config, formatOrderEventMessages(eventKey, groups));
    }
  }
}

/** Первое появление runtime-уведомления — в Telegram, если событие включено. */
export async function forwardRuntimeNotification(notification) {
  const pid = Number(
    notification?.profile_id ?? notification?.profileId ?? notification?.meta?.profile_id ?? notification?.meta?.profileId
  );
  if (!Number.isFinite(pid) || pid <= 0) return;
  const channel = channelKeyForNotificationType(notification?.type);
  if (!channel) return;
  const result = await query(
    `SELECT notification_settings FROM profiles WHERE id = $1 LIMIT 1`,
    [pid]
  );
  const settings = result.rows?.[0]?.notification_settings;
  if (!isTelegramEventEnabled(settings, channel)) return;
  const config = parseNotificationSettings(settings).telegram;
  const title = String(notification?.title || 'Уведомление').slice(0, 200);
  const message = String(notification?.message || '').slice(0, 1500);
  const text = message && message !== title
    ? `<b>${escapeHtml(title)}</b>\n${escapeHtml(message)}`
    : `<b>${escapeHtml(title)}</b>`;
  const dedupe = `${pid}|${channel}|${notification?.dedupe_key || notification?.id || title}`;
  if (!rememberSend(dedupe)) return;
  await sendToChats(config, [text]);
}
