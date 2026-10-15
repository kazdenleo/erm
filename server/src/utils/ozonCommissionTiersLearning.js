/**
 * Обучение ставок комиссии Ozon ≤100 / 101–300 из ответов API (мода по SKU).
 * Хранилище: data/ozonCommissionTiersCache.json
 */

import { readData, writeData } from './storage.js';
import logger from './logger.js';
import {
  OZON_COMMISSION_PERCENT_LE100,
  OZON_COMMISSION_PERCENT_LE300,
  OZON_COMMISSION_TIER_100,
  OZON_COMMISSION_TIER_300,
  computeLearnedOzonLowTierRates,
  mergeLearnedOzonLowTierRates,
} from './ozonCommissionTiers.js';

const CACHE_KEY = 'ozonCommissionTiersCache';
const MIN_SAMPLES = Number(process.env.OZON_COMMISSION_TIER_LEARN_MIN_SAMPLES || 3);

/** @type {{ le100: number, le300: number, updatedAt?: string|null, samplesLe100?: number, samplesLe300?: number }|null} */
let memoryCache = null;

export function getDefaultOzonLowTierRates() {
  return {
    le100: OZON_COMMISSION_PERCENT_LE100,
    le300: OZON_COMMISSION_PERCENT_LE300,
  };
}

/**
 * @returns {Promise<{ le100: number, le300: number, updatedAt?: string|null, samplesLe100?: number, samplesLe300?: number }>}
 */
export async function loadLearnedOzonLowTierRates() {
  if (memoryCache?.le100 != null && memoryCache?.le300 != null) {
    return memoryCache;
  }
  try {
    const raw = await readData(CACHE_KEY);
    const le100 = Number(raw?.le100);
    const le300 = Number(raw?.le300);
    memoryCache = {
      le100: Number.isFinite(le100) && le100 > 0 ? le100 : OZON_COMMISSION_PERCENT_LE100,
      le300: Number.isFinite(le300) && le300 > 0 ? le300 : OZON_COMMISSION_PERCENT_LE300,
      updatedAt: raw?.updatedAt || null,
      samplesLe100: Number(raw?.samplesLe100) || 0,
      samplesLe300: Number(raw?.samplesLe300) || 0,
    };
  } catch (e) {
    logger.warn('[ozonCommissionTiers] load failed', { error: e?.message || e });
    memoryCache = { ...getDefaultOzonLowTierRates(), updatedAt: null };
  }
  return memoryCache;
}

/**
 * @param {{ le100?: number|null, le300?: number|null, samplesLe100?: number, samplesLe300?: number }} learned
 */
export async function saveLearnedOzonLowTierRates(learned) {
  const prev = await loadLearnedOzonLowTierRates();
  const next = {
    le100:
      learned?.le100 != null && Number(learned.le100) > 0
        ? Number(learned.le100)
        : prev.le100,
    le300:
      learned?.le300 != null && Number(learned.le300) > 0
        ? Number(learned.le300)
        : prev.le300,
    samplesLe100: Number(learned?.samplesLe100) || prev.samplesLe100 || 0,
    samplesLe300: Number(learned?.samplesLe300) || prev.samplesLe300 || 0,
    updatedAt: new Date().toISOString(),
    thresholds: { le100: OZON_COMMISSION_TIER_100, le300: OZON_COMMISSION_TIER_300 },
    source: 'ozon_v5_product_info_prices',
  };
  await writeData(CACHE_KEY, next);
  memoryCache = {
    le100: next.le100,
    le300: next.le300,
    updatedAt: next.updatedAt,
    samplesLe100: next.samplesLe100,
    samplesLe300: next.samplesLe300,
  };
  logger.info('[ozonCommissionTiers] learned low-tier rates saved', {
    le100: next.le100,
    le300: next.le300,
    samplesLe100: next.samplesLe100,
    samplesLe300: next.samplesLe300,
  });
  return memoryCache;
}

/**
 * Выучить ставки из массива калькуляторов / сырых сэмплов и сохранить.
 * @param {Array<object>} calculators
 */
export async function learnAndPersistOzonLowTierRatesFromCalculators(calculators) {
  const samples = [];
  for (const calc of calculators || []) {
    if (!calc || typeof calc !== 'object') continue;
    const price = Number(calc.commission_price_basis ?? calc.price);
    if (!Number.isFinite(price) || price < 0) continue;
    const fbs = Number(calc.commissions?.FBS?.percent);
    const fbo = Number(calc.commissions?.FBO?.percent);
    samples.push({
      price,
      percentFbs: Number.isFinite(fbs) && fbs > 0 ? fbs : null,
      percentFbo: Number.isFinite(fbo) && fbo > 0 ? fbo : null,
    });
  }
  const learned = computeLearnedOzonLowTierRates(samples, { minSamples: MIN_SAMPLES });
  if (learned.le100 == null && learned.le300 == null) {
    return { updated: false, learned, rates: await loadLearnedOzonLowTierRates() };
  }
  const prev = await loadLearnedOzonLowTierRates();
  const merged = mergeLearnedOzonLowTierRates(prev, learned);
  const rates = await saveLearnedOzonLowTierRates({
    ...merged,
    samplesLe100: learned.samplesLe100,
    samplesLe300: learned.samplesLe300,
  });
  return { updated: true, learned, rates };
}

/** Сброс in-memory кэша (тесты). */
export function _resetLearnedOzonLowTierRatesMemory() {
  memoryCache = null;
}
