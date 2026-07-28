/**
 * Защита расчёта мин. цен от пустых/устаревших комиссий МП.
 * Не подставляем «случайные» высокие проценты по умолчанию — лучше не обновлять цену.
 */

import logger from './logger.js';
import { addRuntimeNotification } from './runtime-notifications.js';

/** Кэш комиссий по категориям старше этого порога → уведомление «устарели». */
export const COMMISSION_CACHE_STALE_DAYS = Number(process.env.COMMISSION_CACHE_STALE_DAYS || 5);

/** Минимум для «usable» комиссии (%). 0% на МП почти никогда не бывает и даёт заниженные мин. цены. */
export const MIN_USABLE_COMMISSION_PERCENT = 0.01;

/** Антиспам runtime-уведомлений по ключу (мс). */
const NOTIFY_COOLDOWN_MS = Number(process.env.COMMISSION_NOTIFY_COOLDOWN_MS || 60 * 60 * 1000);

/** @type {Map<string, number>} */
const lastNotifyAt = new Map();

/**
 * Вес в карточке YM — граммы; API тарифов ждёт кг.
 * @param {number|string|null|undefined} weightRaw
 * @returns {number|null}
 */
export function ymWeightGramsToKg(weightRaw) {
  if (weightRaw == null || weightRaw === '') return null;
  const n = Number(weightRaw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n / 1000) * 1000) / 1000;
}

/**
 * Процент комиссии, который реально идёт в calculateMinPrice.
 * WB → FBO (иначе FBS); Ozon/YM → FBS (иначе FBO).
 * @returns {number|null}
 */
export function extractMinPriceCommissionPercent(calculator, marketplace) {
  const commissions = calculator?.commissions;
  if (!commissions || typeof commissions !== 'object') return null;
  const mp = String(marketplace || '').toLowerCase();
  let raw;
  if (mp === 'wb' || mp === 'wildberries') {
    raw = commissions.FBO?.percent ?? commissions.FBS?.percent;
  } else {
    raw = commissions.FBS?.percent ?? commissions.FBO?.percent;
  }
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function hasUsableCommissionPercent(calculator, marketplace) {
  const p = extractMinPriceCommissionPercent(calculator, marketplace);
  return p != null && p >= MIN_USABLE_COMMISSION_PERCENT;
}

/**
 * Не затирать хороший кэш пустым (схемы категории Ozon/YM).
 * @param {Array|null|undefined} existingSchemes
 * @param {Array|null|undefined} newSchemes
 */
export function shouldSkipEmptyCategoryOverwrite(existingSchemes, newSchemes) {
  const existingLen = Array.isArray(existingSchemes) ? existingSchemes.length : 0;
  const newLen = Array.isArray(newSchemes) ? newSchemes.length : 0;
  return newLen === 0 && existingLen > 0;
}

/**
 * Не затирать product_mp_calculator_cache с валидной комиссией пустым/нулевым калькулятором.
 */
export function shouldSkipEmptyCalculatorOverwrite(existingCalculator, newCalculator, marketplace) {
  if (!hasUsableCommissionPercent(existingCalculator, marketplace)) return false;
  return !hasUsableCommissionPercent(newCalculator, marketplace);
}

export function isCommissionCacheStale(updatedAt, maxAgeDays = COMMISSION_CACHE_STALE_DAYS) {
  if (!updatedAt) return true;
  const t = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(String(updatedAt));
  if (!Number.isFinite(t)) return true;
  const maxMs = Math.max(1, Number(maxAgeDays) || COMMISSION_CACHE_STALE_DAYS) * 24 * 60 * 60 * 1000;
  return Date.now() - t > maxMs;
}

/**
 * @param {{ beforeFilled: number, beforeEmpty: number, afterFilled: number, afterEmpty: number, skippedEmptyOverwrite?: number, error?: string|null }} stats
 */
export function evaluateCommissionRefreshHealth(stats) {
  const beforeFilled = Number(stats?.beforeFilled) || 0;
  const beforeEmpty = Number(stats?.beforeEmpty) || 0;
  const afterFilled = Number(stats?.afterFilled) || 0;
  const afterEmpty = Number(stats?.afterEmpty) || 0;
  const skipped = Number(stats?.skippedEmptyOverwrite) || 0;
  const emptyRise = afterEmpty > beforeEmpty;
  const filledDrop = afterFilled < beforeFilled;
  const failed = Boolean(stats?.error);
  const unhealthy = failed || emptyRise || (filledDrop && afterEmpty > 0);
  return {
    unhealthy,
    failed,
    emptyRise,
    filledDrop,
    skippedEmptyOverwrite: skipped,
    beforeFilled,
    beforeEmpty,
    afterFilled,
    afterEmpty,
  };
}

/**
 * Runtime-уведомление с cooldown, чтобы массовый пересчёт не засыпал UI.
 * @returns {Promise<object|null>} созданное уведомление или null (cooldown / ошибка)
 */
export async function notifyCommissionIssue(input) {
  const type = input?.type || 'commission_cache_missing';
  const marketplace = input?.marketplace || 'all';
  const key = `${type}:${marketplace}:${input?.dedupeKey || ''}`;
  const now = Date.now();
  const prev = lastNotifyAt.get(key) || 0;
  if (now - prev < NOTIFY_COOLDOWN_MS && !input?.force) {
    logger.warn('[commissionGuards] notify suppressed (cooldown)', { key, type });
    return null;
  }
  lastNotifyAt.set(key, now);

  const severity = input?.severity || (type === 'commission_cache_stale' ? 'warn' : 'error');
  const titles = {
    commission_cache_missing: 'Нет комиссии для мин. цены',
    commission_cache_stale: 'Комиссии маркетплейсов устарели',
    commission_refresh_degraded: 'Обновление комиссий ухудшило кэш',
    commission_refresh_failed: 'Сбой обновления комиссий',
    commission_empty_overwrite_blocked: 'Пустой ответ комиссий отклонён',
  };

  try {
    return await addRuntimeNotification({
      type,
      severity,
      source: input?.source || 'commission_guards',
      marketplace: marketplace === 'all' ? undefined : marketplace,
      title: input?.title || titles[type] || 'Проблема с комиссиями МП',
      message: String(input?.message || '').slice(0, 2000),
      meta: input?.meta,
    });
  } catch (e) {
    logger.warn('[commissionGuards] notify failed', { error: e?.message || e });
    return null;
  }
}

/** Только для тестов. */
export function _resetNotifyCooldownForTests() {
  lastNotifyAt.clear();
}
