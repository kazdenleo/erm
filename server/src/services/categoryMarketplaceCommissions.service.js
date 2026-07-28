/**
 * Превью комиссий по схемам продаж для сопоставленных категорий Ozon и Яндекс.Маркет.
 * Ozon: через калькулятор цен по товару-образцу из ERP-категории.
 * YM: через pricesService.getYMPrices по товару-образцу из ERP-категории (как в расчёте цен).
 * Результаты сохраняются в marketplace_category_commission_cache (ночное обновление / кнопка).
 */

import { query } from '../config/database.js';
import pricesService from './prices.service.js';
import integrationsService from './integrations.service.js';
import logger from '../utils/logger.js';
import {
  shouldSkipEmptyCategoryOverwrite,
  evaluateCommissionRefreshHealth,
  isCommissionCacheStale,
  notifyCommissionIssue,
  COMMISSION_CACHE_STALE_DAYS,
} from '../utils/commissionGuards.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, { expires: number, value: unknown }>} */
const memoryCache = new Map();

function getCached(ns, key) {
  const entry = memoryCache.get(`${ns}:${key}`);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    memoryCache.delete(`${ns}:${key}`);
    return null;
  }
  return entry.value;
}

function setCached(ns, key, value, ttlMs = CACHE_TTL_MS) {
  memoryCache.set(`${ns}:${key}`, { expires: Date.now() + ttlMs, value });
}

const OZON_CACHE_NS = 'category_mp_commission';
const YM_CACHE_NS = 'category_mp_commission_ym';

const YM_REFERENCE = {
  price: 1000,
  length: 10,
  width: 10,
  height: 10,
  weight: 1,
};

function normalizeOzonCategoryId(id) {
  if (id == null || id === '') return '';
  return String(id).trim().replace(/^ozon_/i, '');
}

function normalizeYmCategoryId(id) {
  if (id == null || id === '') return '';
  return String(id).trim();
}

/** Варианты id для поиска в marketplace_mappings и category_mappings */
function ozonCategoryIdVariants(id) {
  const base = normalizeOzonCategoryId(id);
  if (!base) return [];
  const variants = new Set([base, `ozon_${base}`]);
  if (base.includes('_')) {
    const [descId, typeId] = base.split('_');
    if (descId) variants.add(descId);
    if (descId && typeId) variants.add(`${descId}_${typeId}`);
  }
  return [...variants];
}

function normalizePreviewOzonItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let id = '';
    let userCategoryId = null;
    if (item != null && typeof item === 'object') {
      id = normalizeOzonCategoryId(item.id ?? item.ozonCategoryId ?? item.categoryId);
      userCategoryId = item.userCategoryId ?? item.user_category_id ?? null;
    } else {
      id = normalizeOzonCategoryId(item);
    }
    if (!id) continue;
    const key = `${id}|${userCategoryId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, userCategoryId });
  }
  return out;
}

function rowToCommissionEntry(row) {
  if (!row) return null;
  const schemes = Array.isArray(row.schemes) ? row.schemes : [];
  return {
    schemes,
    note: row.note ?? null,
    sampleOfferId: row.sample_offer_id ?? null,
    updatedAt: row.updated_at ?? null,
    source: row.source ?? null,
  };
}

async function readCommissionsFromDb(marketplace, categoryIds) {
  const mp = String(marketplace || '').toLowerCase();
  const ids = [...new Set((categoryIds || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!ids.length) return {};
  const res = await query(
    `SELECT marketplace, category_id, schemes, note, sample_offer_id, source, updated_at
     FROM marketplace_category_commission_cache
     WHERE marketplace = $1 AND category_id = ANY($2::text[])`,
    [mp, ids]
  );
  const out = {};
  for (const row of res.rows) {
    out[row.category_id] = rowToCommissionEntry(row);
  }
  return out;
}

/**
 * @returns {'skipped_empty'|'written'}
 */
async function upsertCommissionToDb(marketplace, categoryId, data, source = 'manual') {
  const mp = String(marketplace || '').toLowerCase();
  const id = mp === 'ozon' ? normalizeOzonCategoryId(categoryId) : normalizeYmCategoryId(categoryId);
  if (!id) return 'written';
  const schemes = Array.isArray(data?.schemes) ? data.schemes : [];
  // Не затираем уже хорошие комиссии пустым ответом (сбой API / нет габаритов у образца)
  if (schemes.length === 0) {
    const existing = await readCommissionsFromDb(mp, [id]);
    if (shouldSkipEmptyCategoryOverwrite(existing[id]?.schemes, schemes)) {
      logger.warn('[categoryMpCommissions] skip empty overwrite', {
        marketplace: mp,
        categoryId: id,
        note: data?.note,
      });
      await notifyCommissionIssue({
        type: 'commission_empty_overwrite_blocked',
        severity: 'warn',
        marketplace: mp,
        source: 'category_mp_commissions',
        dedupeKey: `${mp}:${id}`,
        title: 'Пустой ответ комиссий отклонён',
        message: `Категория ${mp}/${id}: API вернул пустые схемы, сохранённые комиссии не затёрты. ${data?.note || ''}`.trim(),
        meta: { categoryId: id, note: data?.note || null },
      });
      return 'skipped_empty';
    }
  }
  await query(
    `INSERT INTO marketplace_category_commission_cache
       (marketplace, category_id, schemes, note, sample_offer_id, source, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (marketplace, category_id) DO UPDATE SET
       schemes = EXCLUDED.schemes,
       note = EXCLUDED.note,
       sample_offer_id = EXCLUDED.sample_offer_id,
       source = EXCLUDED.source,
       updated_at = CURRENT_TIMESTAMP`,
    [mp, id, JSON.stringify(schemes), data?.note ?? null, data?.sampleOfferId ?? null, source]
  );
  return 'written';
}

async function getCacheMeta() {
  try {
    const res = await query(
      `SELECT
         MAX(updated_at) AS updated_at,
         COUNT(*)::int AS count,
         COUNT(*) FILTER (
           WHERE schemes IS NOT NULL
             AND jsonb_typeof(schemes) = 'array'
             AND jsonb_array_length(schemes) > 0
         )::int AS filled,
         COUNT(*) FILTER (
           WHERE schemes IS NULL
             OR jsonb_typeof(schemes) <> 'array'
             OR jsonb_array_length(schemes) = 0
         )::int AS empty
       FROM marketplace_category_commission_cache`
    );
    const row = res.rows[0] || {};
    return {
      updatedAt: row.updated_at ?? null,
      count: row.count ?? 0,
      filled: row.filled ?? 0,
      empty: row.empty ?? 0,
      stale: isCommissionCacheStale(row.updated_at, COMMISSION_CACHE_STALE_DAYS),
      staleDays: COMMISSION_CACHE_STALE_DAYS,
    };
  } catch (e) {
    if (String(e.message || '').includes('marketplace_category_commission_cache')) {
      return {
        updatedAt: null,
        count: 0,
        filled: 0,
        empty: 0,
        stale: true,
        staleDays: COMMISSION_CACHE_STALE_DAYS,
      };
    }
    throw e;
  }
}

/**
 * Уведомление, если кэш комиссий старше N дней.
 * @returns {Promise<{ stale: boolean, meta: object, notified: boolean }>}
 */
async function checkAndNotifyStaleCache() {
  const meta = await getCacheMeta();
  if (!meta.stale) {
    return { stale: false, meta, notified: false };
  }
  const ageHint = meta.updatedAt
    ? `Последнее обновление: ${meta.updatedAt}`
    : 'Кэш пуст или никогда не обновлялся';
  const n = await notifyCommissionIssue({
    type: 'commission_cache_stale',
    severity: 'warn',
    source: 'category_mp_commissions',
    dedupeKey: 'global',
    title: 'Комиссии маркетплейсов устарели',
    message: `Кэш комиссий Ozon/YM старше ${COMMISSION_CACHE_STALE_DAYS} дн. Обновите комиссии (кнопка в категории или дождитесь ночного задания). ${ageHint}. Заполнено: ${meta.filled}, пустых: ${meta.empty}.`,
    meta: { ...meta },
  });
  return { stale: true, meta, notified: Boolean(n) };
}

/**
 * Сопоставления ERP-категорий → id категории МП (+ user_category_id для образца товара).
 * @returns {{ ozon: Array<{ id: string, userCategoryId: number|null }>, ym: Array<{ id: string, userCategoryId: number|null }> }}
 */
async function collectDistinctMappedCategoryIds() {
  const ozonRes = await query(
    `
    SELECT DISTINCT ON (norm_id)
      norm_id AS id,
      user_category_id
    FROM (
      SELECT
        REPLACE(TRIM(uc.marketplace_mappings->>'ozon'), 'ozon_', '') AS norm_id,
        uc.id AS user_category_id
      FROM user_categories uc
      WHERE uc.marketplace_mappings->>'ozon' IS NOT NULL
        AND TRIM(uc.marketplace_mappings->>'ozon') <> ''
      UNION ALL
      SELECT
        REPLACE(TRIM(c.marketplace_category_id), 'ozon_', '') AS norm_id,
        NULL::bigint AS user_category_id
      FROM category_mappings cm
      JOIN categories c ON c.id = cm.category_id AND c.marketplace = 'ozon'
      WHERE cm.marketplace = 'ozon'
        AND c.marketplace_category_id IS NOT NULL
        AND TRIM(c.marketplace_category_id) <> ''
    ) t
    WHERE norm_id IS NOT NULL AND TRIM(norm_id) <> ''
    ORDER BY norm_id, user_category_id NULLS LAST
    `
  );
  const ymRes = await query(
    `
    SELECT DISTINCT ON (norm_id)
      norm_id AS id,
      user_category_id
    FROM (
      SELECT
        TRIM(uc.marketplace_mappings->>'ym') AS norm_id,
        uc.id AS user_category_id
      FROM user_categories uc
      WHERE uc.marketplace_mappings->>'ym' IS NOT NULL
        AND TRIM(uc.marketplace_mappings->>'ym') <> ''
      UNION ALL
      SELECT
        TRIM(uc.marketplace_mappings->>'yandex') AS norm_id,
        uc.id AS user_category_id
      FROM user_categories uc
      WHERE uc.marketplace_mappings->>'yandex' IS NOT NULL
        AND TRIM(uc.marketplace_mappings->>'yandex') <> ''
      UNION ALL
      SELECT
        TRIM(c.marketplace_category_id) AS norm_id,
        NULL::bigint AS user_category_id
      FROM category_mappings cm
      JOIN categories c ON c.id = cm.category_id AND c.marketplace = 'ym'
      WHERE cm.marketplace = 'ym'
        AND c.marketplace_category_id IS NOT NULL
        AND TRIM(c.marketplace_category_id) <> ''
    ) t
    WHERE norm_id IS NOT NULL AND TRIM(norm_id) <> ''
    ORDER BY norm_id, user_category_id NULLS LAST
    `
  );
  return {
    ozon: ozonRes.rows
      .map((r) => ({
        id: normalizeOzonCategoryId(r.id),
        userCategoryId: r.user_category_id ?? null,
      }))
      .filter((r) => r.id),
    ym: ymRes.rows
      .map((r) => ({
        id: normalizeYmCategoryId(r.id),
        userCategoryId: r.user_category_id ?? null,
      }))
      .filter((r) => r.id),
  };
}

function ozonSchemesFromCalculator(calc) {
  const raw = calc?.fullCommissions || calc?.rawCommissions || {};
  let fbs = calc?.commissions?.FBS?.percent;
  let fbo = calc?.commissions?.FBO?.percent;
  if (fbs == null) {
    fbs = raw.sales_percent_fbs ?? raw.fbs_sales_percent ?? raw.fbs_percent;
  }
  if (fbo == null) {
    fbo = raw.sales_percent_fbo ?? raw.fbo_sales_percent ?? raw.fbo_percent;
  }
  const schemes = [];
  if (fbs != null && Number.isFinite(Number(fbs))) {
    schemes.push({ key: 'FBS', label: 'FBS', shortLabel: 'FBS', percent: Number(fbs) });
  }
  if (fbo != null && Number.isFinite(Number(fbo))) {
    schemes.push({ key: 'FBO', label: 'FBO', shortLabel: 'FBO', percent: Number(fbo) });
  }
  return schemes;
}

async function findOzonSampleByUserCategory(userCategoryId) {
  if (userCategoryId == null) return null;
  const res = await query(
    `
    SELECT
      p.id AS product_id,
      TRIM(ps.sku) AS offer_id
    FROM products p
    JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ozon'
    LEFT JOIN product_mp_calculator_cache cache
      ON cache.product_id = p.id AND cache.marketplace = 'ozon' AND cache.calculator IS NOT NULL
    WHERE p.user_category_id = $1
      AND TRIM(COALESCE(ps.sku, '')) <> ''
    ORDER BY
      (cache.calculator->'commissions'->'FBS'->>'percent') IS NOT NULL DESC,
      (cache.calculator->'commissions'->'FBO'->>'percent') IS NOT NULL DESC,
      p.updated_at DESC NULLS LAST,
      p.id DESC
    LIMIT 1
    `,
    [userCategoryId]
  );
  const row = res.rows[0];
  if (!row?.offer_id) return null;
  return { offer_id: row.offer_id, product_id: row.product_id };
}

async function findOzonSampleViaCategoryMappings(ozonCategoryId) {
  const variants = ozonCategoryIdVariants(ozonCategoryId);
  if (variants.length === 0) return null;

  const res = await query(
    `
    SELECT
      p.id AS product_id,
      TRIM(ps.sku) AS offer_id
    FROM category_mappings cm
    JOIN categories c ON c.id = cm.category_id AND c.marketplace = 'ozon'
    JOIN products p ON p.id = cm.product_id
    JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ozon'
    LEFT JOIN product_mp_calculator_cache cache
      ON cache.product_id = p.id AND cache.marketplace = 'ozon' AND cache.calculator IS NOT NULL
    WHERE cm.marketplace = 'ozon'
      AND (
        c.marketplace_category_id = ANY($1::text[])
        OR REPLACE(c.marketplace_category_id, 'ozon_', '') = ANY($1::text[])
      )
      AND TRIM(COALESCE(ps.sku, '')) <> ''
    ORDER BY
      (cache.calculator->'commissions'->'FBS'->>'percent') IS NOT NULL DESC,
      p.updated_at DESC NULLS LAST,
      p.id DESC
    LIMIT 1
    `,
    [variants]
  );
  const row = res.rows[0];
  if (!row?.offer_id) return null;
  return { offer_id: row.offer_id, product_id: row.product_id };
}

async function findOzonSampleViaUserCategoryMapping(ozonCategoryId) {
  const variants = ozonCategoryIdVariants(ozonCategoryId);
  if (variants.length === 0) return null;

  const res = await query(
    `
    SELECT
      p.id AS product_id,
      TRIM(ps.sku) AS offer_id
    FROM user_categories uc
    JOIN products p ON p.user_category_id = uc.id
    JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ozon'
    LEFT JOIN product_mp_calculator_cache cache
      ON cache.product_id = p.id AND cache.marketplace = 'ozon' AND cache.calculator IS NOT NULL
    WHERE uc.marketplace_mappings->>'ozon' = ANY($1::text[])
      AND TRIM(COALESCE(ps.sku, '')) <> ''
    ORDER BY
      (cache.calculator->'commissions'->'FBS'->>'percent') IS NOT NULL DESC,
      p.updated_at DESC NULLS LAST,
      p.id DESC
    LIMIT 1
    `,
    [variants]
  );
  const row = res.rows[0];
  if (!row?.offer_id) return null;
  return { offer_id: row.offer_id, product_id: row.product_id };
}

async function findOzonSampleForCategory(ozonCategoryId, userCategoryId = null) {
  if (userCategoryId != null) {
    const byErp = await findOzonSampleByUserCategory(userCategoryId);
    if (byErp) return byErp;
  }
  const byMapping = await findOzonSampleViaUserCategoryMapping(ozonCategoryId);
  if (byMapping) return byMapping;
  return findOzonSampleViaCategoryMappings(ozonCategoryId);
}

async function loadOzonCalculatorForProduct(productId, offerId, scope, { allowLive = true } = {}) {
  const cacheRes = await query(
    `SELECT calculator FROM product_mp_calculator_cache
     WHERE product_id = $1 AND marketplace = 'ozon' AND calculator IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [productId]
  );
  const cached = cacheRes.rows[0]?.calculator;
  if (cached && typeof cached === 'object') {
    return cached;
  }

  if (!allowLive) return null;

  try {
    const prices = await pricesService.getOzonPrices(offerId, {
      source: 'live',
      integrationScope: scope,
    });
    const calc =
      prices?.found && prices?.calculator
        ? prices.calculator
        : prices?.calculator ?? prices?.data?.calculator ?? null;
    return calc && typeof calc === 'object' ? calc : null;
  } catch (e) {
    logger.warn('[categoryMpCommissions] Ozon calculator failed', {
      offerId,
      productId,
      error: e?.message,
    });
    return null;
  }
}

async function getOzonCategoryCommissionsLive(ozonCategoryId, scope, userCategoryId = null) {
  const id = normalizeOzonCategoryId(ozonCategoryId);
  if (!id) {
    return { schemes: [], note: 'Не указана категория Ozon' };
  }

  const cacheKey = `ozon_cat_comm:${id}`;
  const cached = getCached(OZON_CACHE_NS, cacheKey);
  if (cached) return cached;

  const sample = await findOzonSampleForCategory(id, userCategoryId);
  if (!sample?.offer_id) {
    return {
      schemes: [],
      note: 'Добавьте товар с артикулом Ozon в эту категорию для расчёта комиссии',
    };
  }

  const calc = await loadOzonCalculatorForProduct(sample.product_id, sample.offer_id, scope);
  const schemes = ozonSchemesFromCalculator(calc);
  const result = {
    schemes,
    note:
      schemes.length === 0
        ? 'Комиссия не получена из калькулятора Ozon (проверьте артикул и интеграцию)'
        : `Из API Ozon v5 (товар ${sample.offer_id}). В расчёте мин. цен — FBS; FBO справочно (как WB показывает FBO для мин. цен).`,
    sampleOfferId: sample.offer_id,
  };

  if (schemes.length > 0) {
    setCached(OZON_CACHE_NS, cacheKey, result, CACHE_TTL_MS);
  }
  return result;
}

function normalizePreviewYmItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let id = '';
    let userCategoryId = null;
    if (item != null && typeof item === 'object') {
      id = normalizeYmCategoryId(item.id ?? item.ymCategoryId ?? item.categoryId);
      userCategoryId = item.userCategoryId ?? item.user_category_id ?? null;
    } else {
      id = normalizeYmCategoryId(item);
    }
    if (!id) continue;
    const key = `${id}|${userCategoryId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, userCategoryId });
  }
  return out;
}

function extractYmFeePercentFromResponse(json, calcPrice) {
  const offers = json?.result?.offers || [];
  if (!offers.length || !offers[0].tariffs?.length) return null;
  const tariffs = offers[0].tariffs.filter(Boolean);
  const feeTariff = tariffs.find(
    (t) => String(t?.type || '').trim().toUpperCase() === 'FEE'
  );
  if (!feeTariff) return null;

  const valueParam = feeTariff.parameters?.find((p) => p.name === 'valueType');
  if (valueParam?.value === 'relative') {
    const v = feeTariff.parameters?.find((p) => p.name === 'value');
    if (v?.value != null && v.value !== '') {
      return parseFloat(String(v.value).replace(',', '.'));
    }
    return feeTariff.amount && calcPrice > 0 ? (feeTariff.amount / calcPrice) * 100 : null;
  }
  return feeTariff.amount && calcPrice > 0 ? (feeTariff.amount / calcPrice) * 100 : null;
}

async function findYmSampleViaCategoryMappings(ymCategoryId) {
  const id = normalizeYmCategoryId(ymCategoryId);
  if (!id) return null;

  const res = await query(
    `
    SELECT
      p.id AS product_id,
      TRIM(ps.sku) AS offer_id
    FROM category_mappings cm
    JOIN categories c ON c.id = cm.category_id AND c.marketplace = 'ym'
    JOIN products p ON p.id = cm.product_id
    JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ym'
    LEFT JOIN product_mp_calculator_cache cache
      ON cache.product_id = p.id AND cache.marketplace = 'ym' AND cache.calculator IS NOT NULL
    WHERE cm.marketplace = 'ym'
      AND TRIM(c.marketplace_category_id) = $1
      AND TRIM(COALESCE(ps.sku, '')) <> ''
    ORDER BY
      (cache.calculator->'commissions'->'FBS'->>'percent') IS NOT NULL DESC,
      (p.length IS NOT NULL AND p.width IS NOT NULL AND p.height IS NOT NULL AND p.weight IS NOT NULL) DESC,
      p.updated_at DESC NULLS LAST,
      p.id DESC
    LIMIT 1
    `,
    [id]
  );
  const row = res.rows[0];
  if (!row?.offer_id) return null;
  return { offer_id: row.offer_id, product_id: row.product_id };
}

async function findYmSampleViaUserCategoryMapping(ymCategoryId) {
  const id = normalizeYmCategoryId(ymCategoryId);
  if (!id) return null;

  const res = await query(
    `
    SELECT
      p.id AS product_id,
      TRIM(ps.sku) AS offer_id
    FROM user_categories uc
    JOIN products p ON p.user_category_id = uc.id
    JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ym'
    LEFT JOIN product_mp_calculator_cache cache
      ON cache.product_id = p.id AND cache.marketplace = 'ym' AND cache.calculator IS NOT NULL
    WHERE uc.marketplace_mappings->>'ym' = $1
      AND TRIM(COALESCE(ps.sku, '')) <> ''
    ORDER BY
      (cache.calculator->'commissions'->'FBS'->>'percent') IS NOT NULL DESC,
      (p.length IS NOT NULL AND p.width IS NOT NULL AND p.height IS NOT NULL AND p.weight IS NOT NULL) DESC,
      p.updated_at DESC NULLS LAST,
      p.id DESC
    LIMIT 1
    `,
    [id]
  );
  const row = res.rows[0];
  if (!row?.offer_id) return null;
  return { offer_id: row.offer_id, product_id: row.product_id };
}

async function findYmSampleForCategory(ymCategoryId, userCategoryId = null) {
  if (userCategoryId != null) {
    const byErp = await findYmSampleByUserCategory(userCategoryId);
    if (byErp) return byErp;
  }
  const byMapping = await findYmSampleViaUserCategoryMapping(ymCategoryId);
  if (byMapping) return byMapping;
  return findYmSampleViaCategoryMappings(ymCategoryId);
}

async function loadYmCalculatorForProduct(
  productId,
  offerId,
  ymCategoryId,
  userCategoryId,
  scope,
  { allowLive = true } = {}
) {
  const cacheRes = await query(
    `SELECT calculator FROM product_mp_calculator_cache
     WHERE product_id = $1 AND marketplace = 'ym' AND calculator IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [productId]
  );
  const cached = cacheRes.rows[0]?.calculator;
  if (cached && typeof cached === 'object') {
    return cached;
  }

  if (!allowLive) return null;

  try {
    const res = await pricesService.getYMPrices(offerId, ymCategoryId, userCategoryId, {
      source: 'live',
      integrationScope: scope,
    });
    if (res.found && res.calculator) return res.calculator;
    return null;
  } catch (e) {
    logger.warn('[categoryMpCommissions] YM calculator failed', {
      offerId,
      productId,
      error: e?.message,
    });
    return null;
  }
}

function ymCommissionResultFromCalculator(calc, sampleOfferId) {
  const schemes = ymSchemesFromCalculator(calc);
  if (!schemes.length) return null;
  return {
    schemes,
    note: sampleOfferId
      ? `Из тарифа YM FEE (товар ${sampleOfferId}). В расчёте мин. цен — FBS.`
      : null,
    sampleOfferId: sampleOfferId || null,
  };
}

async function findYmSampleByUserCategory(userCategoryId) {
  if (userCategoryId == null) return null;
  const res = await query(
    `
    SELECT
      p.id AS product_id,
      TRIM(ps.sku) AS offer_id
    FROM products p
    JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ym'
    LEFT JOIN product_mp_calculator_cache cache
      ON cache.product_id = p.id AND cache.marketplace = 'ym' AND cache.calculator IS NOT NULL
    WHERE p.user_category_id = $1
      AND TRIM(COALESCE(ps.sku, '')) <> ''
    ORDER BY
      (cache.calculator->'commissions'->'FBS'->>'percent') IS NOT NULL DESC,
      (p.length IS NOT NULL AND p.width IS NOT NULL AND p.height IS NOT NULL AND p.weight IS NOT NULL) DESC,
      p.updated_at DESC NULLS LAST,
      p.id DESC
    LIMIT 1
    `,
    [userCategoryId]
  );
  const row = res.rows[0];
  if (!row?.offer_id) return null;
  return { offer_id: row.offer_id, product_id: row.product_id };
}

function ymSchemesFromCalculator(calc) {
  const schemes = [];
  const fbs = calc?.commissions?.FBS?.percent;
  if (fbs != null && Number.isFinite(Number(fbs))) {
    schemes.push({
      key: 'FBS',
      label: 'FBS (для расчёта цен)',
      shortLabel: 'FBS',
      percent: Number(fbs),
    });
  }
  return schemes;
}
function ymProgramLabel(program) {
  const p = String(program || '').toUpperCase();
  if (p === 'FBY') return { key: 'FBY', label: 'FBY (склад Маркета)', shortLabel: 'FBO' };
  if (p === 'DBS') return { key: 'DBS', label: 'DBS', shortLabel: 'DBS' };
  return { key: 'FBS', label: 'FBS', shortLabel: 'FBS' };
}

async function fetchYmTariff(categoryId, program, scope) {
  const cacheKey = `ym_cat_comm:${categoryId}:${program}`;
  const cached = getCached(YM_CACHE_NS, cacheKey);
  if (cached) return cached;

  const cfg = await integrationsService.getMarketplaceConfig('yandex', scope);
  const apiKey = cfg?.api_key ?? cfg?.apiKey ?? null;
  if (!apiKey) {
    return { percent: null, error: 'Нет ключа Яндекс.Маркет' };
  }

  const calcPrice = YM_REFERENCE.price;
  const url = `${cfg.apiUrl || 'https://api.partner.market.yandex.ru'}/v2/tariffs/calculate`;
  const body = {
    offers: [
      {
        categoryId: parseInt(String(categoryId), 10) || categoryId,
        price: calcPrice,
        length: YM_REFERENCE.length,
        width: YM_REFERENCE.width,
        height: YM_REFERENCE.height,
        weight: YM_REFERENCE.weight,
        quantity: 1,
      },
    ],
    parameters: {
      sellingProgram: String(program || 'FBS').toUpperCase(),
      currency: 'RUR',
      frequency: 'DAILY',
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = json?.errors?.[0]?.message || json?.message || `HTTP ${res.status}`;
      return { percent: null, error: errMsg };
    }
    if (json.status === 'ERROR' && json.errors?.length) {
      return {
        percent: null,
        error: json.errors[0]?.message || json.errors[0]?.code || 'Ошибка YM',
      };
    }
    const percent = extractYmFeePercentFromResponse(json, calcPrice);
    const out = { percent: percent != null ? Math.round(Number(percent) * 100) / 100 : null };
    if (out.percent != null) {
      setCached(YM_CACHE_NS, cacheKey, out, CACHE_TTL_MS);
    }
    return out;
  } catch (e) {
    return { percent: null, error: e?.message };
  }
}

async function getYmCategoryCommissionsLive(ymCategoryId, scope, userCategoryId = null) {
  const id = normalizeYmCategoryId(ymCategoryId);
  if (!id) {
    return { schemes: [], note: 'Не указана категория Яндекс.Маркет' };
  }

  const cacheKey = `ym_cat_v2:${id}:${userCategoryId ?? ''}`;
  const cached = getCached(YM_CACHE_NS, cacheKey);
  if (cached) return cached;

  let lastError = null;
  const sample = await findYmSampleForCategory(id, userCategoryId);
  if (sample?.offer_id) {
    const calc = await loadYmCalculatorForProduct(
      sample.product_id,
      sample.offer_id,
      id,
      userCategoryId,
      scope
    );
    const fromCalc = calc ? ymCommissionResultFromCalculator(calc, sample.offer_id) : null;
    if (fromCalc) {
      setCached(YM_CACHE_NS, cacheKey, fromCalc, CACHE_TTL_MS);
      return fromCalc;
    }
    lastError = 'Не удалось получить калькулятор YM по товару категории';
  }

  const fromDb = await readCommissionsFromDb('ym', [id]);
  if (fromDb[id]?.schemes?.length) {
    return fromDb[id];
  }

  // Эталонный тариф по categoryId — даже если образец есть, но без габаритов/веса
  const t = await fetchYmTariff(id, 'FBS', scope);
  if (t.error) lastError = t.error;
  if (t.percent != null && Number.isFinite(Number(t.percent))) {
    const result = {
      schemes: [{ ...ymProgramLabel('FBS'), percent: Number(t.percent) }],
      note: sample?.offer_id
        ? `Тариф YM FEE по категории (товар ${sample.offer_id} без полного калькулятора). В расчёте цен — после заполнения габаритов/веса.`
        : 'Ориентировочно (эталонный товар). Добавьте товар YM с габаритами — комиссия будет как в расчёте цен.',
    };
    setCached(YM_CACHE_NS, cacheKey, result, CACHE_TTL_MS);
    return result;
  }

  const result = {
    schemes: [],
    note: sample?.offer_id
      ? lastError || 'Комиссия YM не получена из калькулятора (проверьте артикул, габариты и интеграцию)'
      : lastError
        ? lastError.includes('403')
          ? 'Тариф YM: доступ запрещён (403). Проверьте Api-Key в «Интеграции → Яндекс.Маркет».'
          : `Тариф YM: ${lastError}`
        : 'Добавьте товар с артикулом YM в эту категорию — комиссия будет как в расчёте цен',
  };

  return result;
}

async function getPreview(body, scope, options = {}) {
  const dbOnly = options.dbOnly === true;
  const ozonItems = normalizePreviewOzonItems(body?.ozon);
  const ymItems = normalizePreviewYmItems(body?.ym);

  const ozonIds = ozonItems.map((i) => i.id);
  const ozonFromDb = dbOnly ? await readCommissionsFromDb('ozon', ozonIds) : {};
  const ymIds = ymItems.map((i) => i.id);
  const ymFromDb = dbOnly ? await readCommissionsFromDb('ym', ymIds) : {};

  const ozon = {};
  for (const item of ozonItems) {
    if (dbOnly) {
      ozon[item.id] = ozonFromDb[item.id] ?? {
        schemes: [],
        note: 'Комиссия не в кэше — нажмите «Обновить комиссии»',
      };
      continue;
    }
    const live = await getOzonCategoryCommissionsLive(item.id, scope, item.userCategoryId);
    ozon[item.id] = live;
    await upsertCommissionToDb('ozon', item.id, live, options.source || 'manual').catch((e) => {
      logger.warn('[categoryMpCommissions] ozon upsert failed', { id: item.id, error: e?.message });
    });
  }

  const ym = {};
  for (const item of ymItems) {
    if (dbOnly) {
      ym[item.id] = ymFromDb[item.id] ?? {
        schemes: [],
        note: 'Комиссия не в кэше — нажмите «Обновить комиссии»',
      };
      continue;
    }
    const live = await getYmCategoryCommissionsLive(item.id, scope, item.userCategoryId);
    ym[item.id] = live;
    await upsertCommissionToDb('ym', item.id, live, options.source || 'manual').catch((e) => {
      logger.warn('[categoryMpCommissions] ym upsert failed', { id: item.id, error: e?.message });
    });
  }

  const meta = dbOnly ? await getCacheMeta() : null;
  return { ozon, ym, meta };
}

async function refreshAllCommissions(scope, source = 'manual') {
  const { ozon, ym } = await collectDistinctMappedCategoryIds();
  const beforeMeta = await getCacheMeta();
  logger.info('[categoryMpCommissions] refreshAll start', {
    ozon: ozon.length,
    ym: ym.length,
    source,
    before: { filled: beforeMeta.filled, empty: beforeMeta.empty },
  });

  let updated = 0;
  let filledNow = 0;
  let emptyNow = 0;
  let skippedEmptyOverwrite = 0;

  for (const item of ozon) {
    const data = await getOzonCategoryCommissionsLive(item.id, scope, item.userCategoryId);
    const writeResult = await upsertCommissionToDb('ozon', item.id, data, source);
    if (writeResult === 'skipped_empty') skippedEmptyOverwrite += 1;
    else updated += 1;
    if (Array.isArray(data?.schemes) && data.schemes.length > 0) filledNow += 1;
    else emptyNow += 1;
  }
  for (const item of ym) {
    const data = await getYmCategoryCommissionsLive(item.id, scope, item.userCategoryId);
    const writeResult = await upsertCommissionToDb('ym', item.id, data, source);
    if (writeResult === 'skipped_empty') skippedEmptyOverwrite += 1;
    else updated += 1;
    if (Array.isArray(data?.schemes) && data.schemes.length > 0) filledNow += 1;
    else emptyNow += 1;
  }

  const meta = await getCacheMeta();
  const health = evaluateCommissionRefreshHealth({
    beforeFilled: beforeMeta.filled,
    beforeEmpty: beforeMeta.empty,
    afterFilled: meta.filled,
    afterEmpty: meta.empty,
    skippedEmptyOverwrite,
  });

  logger.info('[categoryMpCommissions] refreshAll done', {
    updated,
    filledNow,
    emptyNow,
    skippedEmptyOverwrite,
    meta,
    health,
  });

  if (health.unhealthy) {
    await notifyCommissionIssue({
      type: 'commission_refresh_degraded',
      severity: 'error',
      source: source === 'nightly' ? 'scheduler' : 'category_mp_commissions',
      dedupeKey: `refresh:${source}`,
      force: source === 'nightly',
      title: 'Обновление комиссий ухудшило кэш',
      message:
        `После обновления (${source}): заполнено ${meta.filled} (было ${beforeMeta.filled}), ` +
        `пустых ${meta.empty} (было ${beforeMeta.empty}), пропусков пустой перезаписи: ${skippedEmptyOverwrite}. ` +
        `Проверьте интеграции Ozon/YM и образцы товаров в категориях.`,
      meta: { ...health, source },
    });
  } else if (meta.empty > 0) {
    await notifyCommissionIssue({
      type: 'commission_cache_missing',
      severity: 'warn',
      source: source === 'nightly' ? 'scheduler' : 'category_mp_commissions',
      dedupeKey: `empty_after_refresh:${source}`,
      force: source === 'nightly',
      title: 'Часть категорий без комиссий',
      message:
        `После обновления комиссий (${source}): заполнено ${meta.filled}, пустых ${meta.empty} ` +
        `(Ozon ${ozon.length}, YM ${ym.length}). Мин. цены для пустых категорий не будут занижены — прежние значения сохраняются.`,
      meta: { filled: meta.filled, empty: meta.empty, source },
    });
  }

  if (meta.stale) {
    await checkAndNotifyStaleCache();
  }

  return {
    updated,
    ozon: ozon.length,
    ym: ym.length,
    filled: meta.filled,
    empty: meta.empty,
    skippedEmptyOverwrite,
    filledNow,
    emptyNow,
    before: { filled: beforeMeta.filled, empty: beforeMeta.empty },
    health,
    meta,
  };
}

export default {
  getPreview,
  refreshAllCommissions,
  getCacheMeta,
  checkAndNotifyStaleCache,
  getOzonCategoryCommissions: getOzonCategoryCommissionsLive,
  getYmCategoryCommissions: getYmCategoryCommissionsLive,
  ozonCategoryIdVariants,
  normalizeOzonCategoryId,
};
