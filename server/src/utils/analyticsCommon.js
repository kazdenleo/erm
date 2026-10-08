/**
 * Общие помощники для сервисов аналитики: профиль, период, фильтры МП/схемы.
 */

import repositoryFactory from '../config/repository-factory.js';

export function requireAnalyticsProfile(profileId) {
  const pid = profileId != null ? Number(profileId) : null;
  if (!Number.isFinite(pid) || pid < 1) {
    const err = new Error('Профиль не определён');
    err.statusCode = 403;
    throw err;
  }
  if (!repositoryFactory.isUsingPostgreSQL()) {
    const err = new Error('Доступно только с PostgreSQL');
    err.statusCode = 501;
    throw err;
  }
  return pid;
}

export function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Сегодня в календаре МСК (YYYY-MM-DD). */
export function todayYmdMoscow() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

export function parseDateYmd(raw, fallback = null) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback;
}

export function addDaysYmd(ymd, delta) {
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

export function daysInclusive(fromYmd, toYmd) {
  const [y1, m1, d1] = fromYmd.split('-').map((x) => parseInt(x, 10));
  const [y2, m2, d2] = toYmd.split('-').map((x) => parseInt(x, 10));
  const start = Date.UTC(y1, m1 - 1, d1);
  const end = Date.UTC(y2, m2 - 1, d2);
  return Math.max(1, Math.floor((end - start) / 86400000) + 1);
}

/** Период по умолчанию: последние `days` дней, включая сегодня (МСК). */
export function resolvePeriod(dateFrom, dateTo, days = 28) {
  const today = todayYmdMoscow();
  const toYmd = parseDateYmd(dateTo, today);
  const fromYmd = parseDateYmd(dateFrom, addDaysYmd(toYmd, -(Math.max(1, days) - 1)));
  if (fromYmd > toYmd) return { fromYmd: toYmd, toYmd: fromYmd, days: daysInclusive(toYmd, fromYmd) };
  return { fromYmd, toYmd, days: daysInclusive(fromYmd, toYmd) };
}

/** Все даты периода (YYYY-MM-DD). */
export function listDaysYmd(fromYmd, toYmd) {
  const out = [];
  let cur = fromYmd;
  let guard = 0;
  while (cur <= toYmd && guard < 1000) {
    out.push(cur);
    cur = addDaysYmd(cur, 1);
    guard += 1;
  }
  return out;
}

/** 'all' | 'ozon' | 'wb' | 'ym' */
export function normalizeMp(raw) {
  const v = String(raw || 'all').trim().toLowerCase();
  if (v === 'wb' || v === 'wildberries') return 'wb';
  if (v === 'ym' || v === 'yandex' || v === 'yandexmarket') return 'ym';
  if (v === 'ozon') return 'ozon';
  return 'all';
}

/** Варианты написания МП в таблицах (для ANY(...)). */
export function mpDbVariants(mp) {
  if (mp === 'wb') return ['wb', 'wildberries'];
  if (mp === 'ym') return ['ym', 'yandex', 'yandexmarket'];
  if (mp === 'ozon') return ['ozon'];
  return null;
}

export function normalizeScheme(raw) {
  const v = String(raw || 'all').trim().toLowerCase();
  if (v === 'fbo' || v === 'fbs') return v;
  return 'all';
}

export function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

export const MP_LABELS = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс Маркет' };

/** Нормализация marketplace из orders / claims (wildberries → wb и т.п.). */
export function normMpCode(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'wildberries') return 'wb';
  if (v === 'yandex' || v === 'yandexmarket') return 'ym';
  return v;
}
