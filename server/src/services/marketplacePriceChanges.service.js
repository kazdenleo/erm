/**
 * Журнал изменений цен МП (стратегия / ручное) + выборка за N дней.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';

export const PRICE_CHANGE_RETENTION_DAYS = 30;

const MP_LABELS = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };
const MODE_LABELS = {
  floor: 'Минимум (пол)',
  target_margin: 'Целевая маржа',
  competitor: 'От конкурентов',
  sales: 'От продаж',
  hybrid: 'Гибрид',
  manual: 'Вручную',
};
const SOURCE_LABELS = {
  strategy: 'Стратегия',
  manual: 'Вручную',
  min_recalc: 'Пересчёт минимума',
};

function rubLabel(v) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return null;
  return `${Math.round(Number(v))} ₽`;
}

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
  if (m.cappedByCeiling === true) {
    const cap = m.ceiling != null ? ` (потолок ${m.ceiling} ₽)` : '';
    if (name) {
      return `Стратегия «${name}» (${MODE_LABELS[md] || md || 'режим'}): ограничена макс. ценой${cap}`;
    }
    return `Стратегия ограничена максимальной ценой${cap}`;
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
 * Шаги расчёта из strategy_details / meta — «на каких основаниях» сменилась цена.
 */
export function formatPriceChangeGrounds(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const details = m.details && typeof m.details === 'object' ? m.details : m;
  const steps = Array.isArray(details.steps)
    ? details.steps
    : Array.isArray(m.steps)
      ? m.steps
      : [];
  const lines = [];

  for (const s of steps) {
    const step = String(s?.step || '');
    if (step === 'floor' || step === 'base_floor') {
      const p = rubLabel(s.price);
      if (p) lines.push(`База — минимум (пол): ${p}`);
    } else if (step === 'target_margin') {
      const p = rubLabel(s.price);
      const cost = rubLabel(s.cost);
      const pct = s.margin_percent != null ? `${s.margin_percent}%` : null;
      lines.push(
        ['Целевая маржа', pct, cost ? `от себестоимости ${cost}` : null, p ? `→ ${p}` : null]
          .filter(Boolean)
          .join(' ')
      );
    } else if (step === 'competitor') {
      if (s.applied === false) {
        if (s.reason === 'ozon_no_competitors') {
          lines.push('Конкуренты: на Ozon шаг не применяется');
        } else if (s.reason === 'disabled') {
          lines.push('Конкуренты: шаг выключен');
        } else {
          lines.push('Конкуренты: нет данных — оставили базу');
        }
      } else {
        const agg = rubLabel(s.competitorAgg);
        const p = rubLabel(s.price);
        const off = [];
        if (s.offset_percent) off.push(`${s.offset_percent}%`);
        if (s.offset_rub) off.push(`${s.offset_rub} ₽`);
        const bits = ['Конкуренты'];
        if (agg) bits.push(agg);
        if (off.length) bits.push(`смещение ${off.join(', ')}`);
        if (p) bits.push(`→ ${p}`);
        lines.push(bits.join(' '));
      }
    } else if (step === 'sales') {
      if (s.applied === false) {
        lines.push('Продажи: шаг выключен');
      } else {
        const bandLabel = s.band === 'high' ? 'высокие' : s.band === 'low' ? 'низкие' : 'средние';
        const vel = s.perDay != null ? `${s.perDay} шт/день` : null;
        const win = s.windowDays != null ? `за ${s.windowDays} дн.` : null;
        const sold = s.soldQty != null ? `${s.soldQty} шт` : null;
        const p = rubLabel(s.price);
        lines.push(
          [`Продажи (${bandLabel})`, sold, vel, win, p ? `→ ${p}` : null].filter(Boolean).join(', ')
        );
      }
    } else if (step === 'max_change') {
      const p = rubLabel(s.price);
      lines.push(`Ограничение шага за пересчёт${p ? ` → ${p}` : ''}`);
    } else if (step === 'clamp_floor') {
      lines.push(
        `Подтянули до пола: ${rubLabel(s.from) || '—'} → ${rubLabel(s.to) || '—'}`
      );
    } else if (step === 'band_hold') {
      continue;
    }
  }

  if (m.reason === 'manual_selling_price' && lines.length === 0) {
    lines.push('Фактическую цену задали вручную (стратегия не перезаписывает)');
  }
  if (m.reason === 'no_strategy' && lines.length === 0) {
    const floor = rubLabel(m.floor ?? m.sellingPrice);
    lines.push(floor ? `Нет стратегии — цена равна полу ${floor}` : 'Нет активной стратегии');
  }
  if (String(m.source || '').toLowerCase() === 'min_recalc' && lines.length === 0) {
    lines.push('Изменился расчётный минимум (комиссии, логистика, себестоимость или наценка)');
  }

  return lines;
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
 * История за N дней (по умолчанию 30).
 */
export async function listMarketplacePriceChanges(opts = {}) {
  const days = Math.max(1, Math.min(90, Number(opts.days) || PRICE_CHANGE_RETENTION_DAYS));
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
  const searchRaw = opts.search != null ? String(opts.search).trim() : '';

  const params = [days];
  let i = 2;
  const where = [`c.created_at >= CURRENT_TIMESTAMP - ($1::text || ' days')::interval`];
  where.push(
    `(c.min_price_before IS DISTINCT FROM c.min_price_after
      OR c.selling_price_before IS DISTINCT FROM c.selling_price_after)`
  );
  if (Number.isFinite(productId) && productId > 0) {
    where.push(`c.product_id = $${i++}`);
    params.push(productId);
  } else if (searchRaw) {
    const safe = searchRaw.replace(/[%_\\]/g, ' ').slice(0, 80);
    if (safe) {
      where.push(`(p.sku ILIKE $${i} OR p.name ILIKE $${i})`);
      params.push(`%${safe}%`);
      i += 1;
    }
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
    sourceLabel: SOURCE_LABELS[row.source] || row.source,
    grounds: formatPriceChangeGrounds(row.meta),
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
  formatPriceChangeGrounds,
  logMarketplacePriceChange,
  pruneMarketplacePriceChanges,
  listMarketplacePriceChanges,
};
