/**
 * Журнал изменений цен МП (стратегия / ручное) + выборка за N дней.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';

export const PRICE_CHANGE_RETENTION_DAYS = 7;

const MP_LABELS = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };
const MODE_LABELS = {
  floor: 'Минимум (пол)',
  target_margin: 'Целевая маржа',
  competitor: 'От конкурентов',
  sales: 'От продаж',
  hybrid: 'Гибрид',
  manual: 'Вручную',
};

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function sameMoney(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

/**
 * Человекочитаемая причина из strategy_details / meta.
 */
export function formatPriceChangeReason({ source, reason, meta, strategyName, mode } = {}) {
  if (reason && String(reason).trim()) return String(reason).trim();

  const m = meta && typeof meta === 'object' ? meta : {};
  const src = String(source || m.source || '').toLowerCase();
  const md = String(mode || m.mode || '').toLowerCase();
  const name = strategyName || m.strategyName || null;

  if (src === 'manual' || m.reason === 'manual_selling_price' || md === 'manual') {
    return 'Ручное изменение фактической цены';
  }
  if (m.reason === 'no_strategy') {
    return 'Нет активной стратегии — цена = пол (минимум)';
  }
  if (m.heldByBand === true) {
    return `Стратегия «${name || MODE_LABELS[md] || md || '—'}»: без изменения (внутри коридора)`;
  }
  if (name) {
    return `Стратегия «${name}» (${MODE_LABELS[md] || md || 'режим'})`;
  }
  if (md && MODE_LABELS[md]) {
    return `Стратегия: ${MODE_LABELS[md]}`;
  }
  if (src === 'strategy') return 'Пересчёт по стратегии';
  if (src === 'min_recalc') return 'Пересчёт минимальной цены';
  return 'Изменение цены';
}

/**
 * Записать изменение, если цена реально изменилась.
 * Не бросает наружу — ошибки только в лог.
 */
export async function logMarketplacePriceChange(entry = {}) {
  try {
    const productId = Number(entry.productId ?? entry.product_id);
    const marketplace = String(entry.marketplace || '').trim().toLowerCase();
    if (!Number.isFinite(productId) || productId < 1) return null;
    if (!['ozon', 'wb', 'ym'].includes(marketplace)) return null;

    const minBefore = numOrNull(entry.minPriceBefore ?? entry.min_price_before);
    const minAfter = numOrNull(entry.minPriceAfter ?? entry.min_price_after);
    const sellBefore = numOrNull(entry.sellingPriceBefore ?? entry.selling_price_before);
    const sellAfter = numOrNull(entry.sellingPriceAfter ?? entry.selling_price_after);

    if (sameMoney(minBefore, minAfter) && sameMoney(sellBefore, sellAfter)) {
      return null;
    }

    const source = String(entry.source || 'strategy').slice(0, 32);
    const meta =
      entry.meta && typeof entry.meta === 'object'
        ? entry.meta
        : entry.details && typeof entry.details === 'object'
          ? entry.details
          : null;
    const reason =
      entry.reason != null && String(entry.reason).trim()
        ? String(entry.reason).trim().slice(0, 500)
        : formatPriceChangeReason({
            source,
            meta,
            strategyName: entry.strategyName ?? meta?.strategyName,
            mode: entry.mode ?? meta?.mode,
          });

    const strategyIdRaw = entry.pricingStrategyId ?? entry.pricing_strategy_id ?? meta?.strategyId;
    const strategyId =
      strategyIdRaw != null && Number.isFinite(Number(strategyIdRaw))
        ? Number(strategyIdRaw)
        : null;
    const profileIdRaw = entry.profileId ?? entry.profile_id;
    const profileId =
      profileIdRaw != null && Number.isFinite(Number(profileIdRaw)) ? Number(profileIdRaw) : null;

    const r = await query(
      `INSERT INTO marketplace_price_changes
         (product_id, marketplace, source, reason,
          min_price_before, min_price_after,
          selling_price_before, selling_price_after,
          pricing_strategy_id, profile_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING id, created_at`,
      [
        productId,
        marketplace,
        source,
        reason,
        minBefore,
        minAfter,
        sellBefore,
        sellAfter,
        strategyId,
        profileId,
        meta ? JSON.stringify(meta) : null,
      ]
    );
    return r.rows?.[0] || null;
  } catch (e) {
    if (String(e.message || '').includes('marketplace_price_changes')) {
      logger.warn('[PriceChanges] log skipped (таблица?):', e.message);
      return null;
    }
    logger.warn('[PriceChanges] log failed:', e?.message || e);
    return null;
  }
}

export async function pruneMarketplacePriceChanges(
  retentionDays = PRICE_CHANGE_RETENTION_DAYS
) {
  const days = Math.max(1, Math.min(90, Number(retentionDays) || PRICE_CHANGE_RETENTION_DAYS));
  try {
    const r = await query(
      `DELETE FROM marketplace_price_changes
       WHERE created_at < CURRENT_TIMESTAMP - ($1::text || ' days')::interval
       RETURNING id`,
      [String(days)]
    );
    const deleted = r.rowCount || 0;
    if (deleted > 0) {
      logger.info('[PriceChanges] pruned old rows', { deleted, days });
    }
    return { deleted, days };
  } catch (e) {
    if (String(e.message || '').includes('marketplace_price_changes')) {
      return { deleted: 0, days, skipped: true };
    }
    throw e;
  }
}

/**
 * История за N дней (по умолчанию 7).
 */
export async function listMarketplacePriceChanges(opts = {}) {
  const days = Math.max(1, Math.min(30, Number(opts.days) || PRICE_CHANGE_RETENTION_DAYS));
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const productId =
    opts.productId != null && opts.productId !== '' ? Number(opts.productId) : null;
  const marketplace =
    opts.marketplace != null && String(opts.marketplace).trim()
      ? String(opts.marketplace).trim().toLowerCase()
      : null;
  const profileId =
    opts.profileId != null && opts.profileId !== '' ? Number(opts.profileId) : null;

  const params = [days];
  let i = 2;
  const where = [`c.created_at >= CURRENT_TIMESTAMP - ($1::text || ' days')::interval`];
  if (Number.isFinite(productId) && productId > 0) {
    where.push(`c.product_id = $${i++}`);
    params.push(productId);
  }
  if (marketplace && ['ozon', 'wb', 'ym'].includes(marketplace)) {
    where.push(`c.marketplace = $${i++}`);
    params.push(marketplace);
  }
  if (Number.isFinite(profileId) && profileId > 0) {
    where.push(`(c.profile_id = $${i} OR p.profile_id = $${i})`);
    params.push(profileId);
    i += 1;
  }

  params.push(limit, offset);
  const limitIdx = i++;
  const offsetIdx = i;

  const r = await query(
    `SELECT c.id, c.product_id, c.marketplace, c.created_at, c.source, c.reason,
            c.min_price_before, c.min_price_after,
            c.selling_price_before, c.selling_price_after,
            c.pricing_strategy_id, c.profile_id, c.meta,
            p.sku AS product_sku, p.name AS product_name,
            ps.name AS strategy_name
     FROM marketplace_price_changes c
     LEFT JOIN products p ON p.id = c.product_id
     LEFT JOIN pricing_strategies ps ON ps.id = c.pricing_strategy_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const countR = await query(
    `SELECT COUNT(*)::int AS n
     FROM marketplace_price_changes c
     LEFT JOIN products p ON p.id = c.product_id
     WHERE ${where.join(' AND ')}`,
    countParams
  );

  const items = (r.rows || []).map((row) => ({
    id: Number(row.id),
    productId: Number(row.product_id),
    productSku: row.product_sku || null,
    productName: row.product_name || null,
    marketplace: row.marketplace,
    marketplaceLabel: MP_LABELS[row.marketplace] || row.marketplace,
    createdAt: row.created_at,
    source: row.source,
    reason: row.reason,
    minPriceBefore: row.min_price_before != null ? Number(row.min_price_before) : null,
    minPriceAfter: row.min_price_after != null ? Number(row.min_price_after) : null,
    sellingPriceBefore: row.selling_price_before != null ? Number(row.selling_price_before) : null,
    sellingPriceAfter: row.selling_price_after != null ? Number(row.selling_price_after) : null,
    pricingStrategyId:
      row.pricing_strategy_id != null ? Number(row.pricing_strategy_id) : null,
    strategyName: row.strategy_name || null,
    meta: row.meta || null,
  }));

  return {
    days,
    total: countR.rows?.[0]?.n ?? items.length,
    limit,
    offset,
    items,
  };
}

export default {
  PRICE_CHANGE_RETENTION_DAYS,
  formatPriceChangeReason,
  logMarketplacePriceChange,
  pruneMarketplacePriceChanges,
  listMarketplacePriceChanges,
};
