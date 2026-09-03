/**
 * Очередь «Работа с карточками»: товары, по которым нужна реакция
 * (низкая оборачиваемость, нет остатка, качество, размеры).
 * Одна строка = товар + маркетплейс (остатки не суммируем между МП).
 */

import marketplaceTurnoverAnalyticsService from './marketplaceTurnoverAnalytics.service.js';
import marketplaceCardQualityService from './marketplaceCardQuality.service.js';
import { query } from '../config/database.js';
import { describePackDimensionMismatch } from '../utils/packDimensionsDiff.js';

const MP_LABEL = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс' };

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mpLabel(marketplace) {
  return MP_LABEL[marketplace] || marketplace || 'МП';
}

function rowKey(productId, sku, erpSku, marketplace) {
  const pid = Number(productId) || 0;
  const base = pid > 0 ? `p:${pid}` : `s:${sku || erpSku || '—'}`;
  return `${base}|${marketplace || '—'}`;
}

function buildReasons(row, { slowDays }) {
  const reasons = [];
  const days = row.daysOfStock;
  const tooSlow =
    row.status === 'dead' ||
    row.status === 'slow' ||
    (days != null && Number.isFinite(days) && days > slowDays && row.stockQty > 0);

  if (tooSlow) {
    const isDead = row.status === 'dead';
    reasons.push({
      code: 'low_turnover',
      label: isDead ? 'Не продаётся при остатке' : 'Низкая оборачиваемость',
      hint: isDead
        ? `Остаток ${row.stockQty} шт., продаж за период нет. Улучшить карточку, цену или рекламу.`
        : `Запаса хватит на ${days != null ? days : '—'} дн. Карточка продаёт слишком медленно.`,
      severity: isDead ? 'high' : 'medium',
    });
  }

  if (row.status === 'stockout') {
    reasons.push({
      code: 'stockout',
      label: 'Продажи без остатка на МП',
      hint: `Продано ${row.soldQty} шт., остаток на складе МП 0. Пополнить FBO или проверить выгрузку остатков.`,
      severity: 'high',
    });
  }

  return reasons.map((r) => ({
    ...r,
    marketplace: row.marketplace,
    daysOfStock: row.daysOfStock,
    turnover: row.turnover,
    stockQty: row.stockQty,
    soldQty: row.soldQty,
  }));
}

function severityRank(s) {
  if (s === 'high') return 0;
  if (s === 'medium') return 1;
  return 2;
}

function qualityHintPart(r) {
  const mp = mpLabel(r.marketplace);
  const score = r.score != null && Number.isFinite(Number(r.score)) ? Math.round(Number(r.score)) : '—';
  const threshold = r.threshold != null ? r.threshold : '—';
  return `${mp}: ${score} из 100, порог ${threshold}`;
}

function mergeReasons(reasons) {
  const uniqueReasons = [];
  const seen = new Set();
  for (const r of reasons || []) {
    const collapseQuality = r.code === 'low_content_rating';
    const k = collapseQuality ? r.code : `${r.code}|${r.marketplace || ''}`;
    if (seen.has(k)) {
      if (!collapseQuality) continue;
      const prev = uniqueReasons.find((x) => x.code === 'low_content_rating');
      if (!prev) continue;
      const part = qualityHintPart(r);
      if (prev.hint && !String(prev.hint).includes(part)) {
        prev.hint = `${prev.hint}; ${part}`;
      }
      if (severityRank(r.severity) < severityRank(prev.severity)) prev.severity = r.severity;
      continue;
    }
    seen.add(k);
    uniqueReasons.push(
      collapseQuality
        ? { ...r, label: 'Качество', hint: qualityHintPart(r) }
        : r.code === 'dim_mismatch'
          ? { ...r, label: 'Размеры' }
          : r
    );
  }
  for (const r of uniqueReasons) {
    if (r.code === 'low_content_rating') {
      r.hint = `${r.hint}. Дополните фото, описание и характеристики.`;
    }
  }
  uniqueReasons.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return uniqueReasons;
}

function finalizeItems(map, reasonFilter) {
  let items = [...map.values()].map((item) => {
    const uniqueReasons = mergeReasons(item.reasons);
    const severity = uniqueReasons.some((r) => r.severity === 'high') ? 'high' : 'medium';
    return {
      ...item,
      marketplaceLabel: mpLabel(item.marketplace),
      reasons: uniqueReasons,
      reasonCodes: [...new Set(uniqueReasons.map((r) => r.code))],
      primaryReason: uniqueReasons[0] || null,
      severity,
    };
  });

  if (reasonFilter && reasonFilter !== 'all') {
    items = items.filter((i) => i.reasonCodes.includes(reasonFilter));
  }

  items.sort((a, b) => {
    const sr = severityRank(a.severity) - severityRank(b.severity);
    if (sr !== 0) return sr;
    const mpCmp = String(a.marketplace || '').localeCompare(String(b.marketplace || ''), 'ru');
    if (mpCmp !== 0) return mpCmp;
    return (b.stockQty || 0) - (a.stockQty || 0);
  });

  return items;
}

async function listPackDimensionMismatches({ profileId, marketplace = 'all' } = {}) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return [];
  const mpFilter = String(marketplace || 'all').toLowerCase();
  const mps =
    mpFilter && mpFilter !== 'all' && ['ozon', 'wb', 'ym'].includes(mpFilter)
      ? [mpFilter]
      : ['ozon', 'wb', 'ym'];
  let rows = [];
  try {
    const res = await query(
      `SELECT DISTINCT ON (p.id, ps.marketplace)
              p.id, p.sku, p.name, p.length, p.width, p.height, p.weight,
              p.ozon_draft, p.wb_draft, p.ym_draft, p.wb_attributes,
              ps.marketplace
         FROM products p
         JOIN product_skus ps ON ps.product_id = p.id
        WHERE p.profile_id = $1
          AND COALESCE(p.is_archived, false) = false
          AND ps.marketplace = ANY($2::text[])
        ORDER BY p.id, ps.marketplace`,
      [pid, mps]
    );
    rows = res.rows || [];
  } catch {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const mp = String(row.marketplace || '').toLowerCase();
    const diff = describePackDimensionMismatch(row, mp);
    if (!diff) continue;
    out.push({
      productId: Number(row.id) || null,
      sku: row.sku,
      erpSku: row.sku,
      productName: row.name,
      marketplace: mp,
      hint: `В ERP: ${diff.erpText}. На ${mpLabel(mp)}: ${diff.mpText}. Сверьте и обновите карточку.`,
    });
  }
  return out;
}

class MarketplaceCardWorkService {
  async getQueue({
    profileId,
    dateFrom = null,
    dateTo = null,
    marketplace = 'all',
    scheme = 'all',
    reason = 'all',
    fastDays = 10,
    slowDays = 45,
    minTurnover = 1.5,
  } = {}) {
    const turnoverData = await marketplaceTurnoverAnalyticsService.getTurnover({
      profileId,
      dateFrom,
      dateTo,
      marketplace,
      scheme,
    });

    const thresholds = {
      fastDays: Math.max(1, toNum(fastDays, 10)),
      slowDays: Math.max(1, toNum(slowDays, 45)),
      minTurnover: Math.max(0.1, toNum(minTurnover, 1.5)),
    };

    const byKey = new Map();
    for (const row of turnoverData.items || []) {
      const reasons = buildReasons(row, thresholds);
      if (!reasons.length) continue;
      const pid = Number(row.productId) || 0;
      const mp = row.marketplace || '—';
      const key = rowKey(pid, row.sku, row.erpSku, mp);
      const prev = byKey.get(key) || {
        productId: pid || null,
        sku: row.sku,
        erpSku: row.erpSku,
        productName: row.productName,
        marketplace: mp,
        reasons: [],
        soldQty: 0,
        soldAmount: 0,
        stockQty: 0,
        daysOfStock: row.daysOfStock,
        turnover: row.turnover,
        status: row.status,
      };
      prev.soldQty = Number(row.soldQty) || 0;
      prev.soldAmount = Number(row.soldAmount) || 0;
      prev.stockQty = Number(row.stockQty) || 0;
      prev.daysOfStock = row.daysOfStock;
      prev.turnover = row.turnover;
      prev.status = row.status;
      if ((!prev.erpSku || prev.erpSku === '—') && row.erpSku) prev.erpSku = row.erpSku;
      if ((!prev.productName || prev.productName === '—') && row.productName) prev.productName = row.productName;
      prev.reasons.push(...reasons);
      byKey.set(key, prev);
    }

    const reasonFilterRaw = String(reason || 'all').trim();
    const reasonFilter =
      reasonFilterRaw === 'overstock' || reasonFilterRaw === 'high_turnover'
        ? 'low_turnover'
        : reasonFilterRaw;

    const qualitySettings = await marketplaceCardQualityService.getSettings(profileId);
    if (qualitySettings.showInCardWork) {
      const qualityRows = await marketplaceCardQualityService.listBelowThreshold({
        profileId,
        marketplace,
      });
      for (const q of qualityRows) {
        const pid = Number(q.productId) || 0;
        const mp = String(q.marketplace || '').toLowerCase();
        if (mp !== 'ozon' && mp !== 'ym') continue;
        const key = rowKey(pid, q.sku, q.erpSku, mp);
        const reasonItem = {
          code: 'low_content_rating',
          label: 'Качество',
          hint: qualityHintPart({ marketplace: mp, score: q.score, threshold: q.threshold }),
          severity: Number(q.score) < q.threshold * 0.6 ? 'high' : 'medium',
          marketplace: mp,
          score: q.score,
          threshold: q.threshold,
        };
        const prev = byKey.get(key);
        if (prev) {
          prev.reasons.push(reasonItem);
          continue;
        }
        byKey.set(key, {
          productId: pid || null,
          sku: q.sku,
          erpSku: q.erpSku,
          productName: q.productName,
          marketplace: mp,
          reasons: [reasonItem],
          soldQty: 0,
          soldAmount: 0,
          stockQty: 0,
        });
      }
    }

    const dimRows = await listPackDimensionMismatches({ profileId, marketplace });
    for (const d of dimRows) {
      const pid = Number(d.productId) || 0;
      const mp = String(d.marketplace || '').toLowerCase();
      const key = rowKey(pid, d.sku, d.erpSku, mp);
      const reasonItem = {
        code: 'dim_mismatch',
        label: 'Размеры',
        hint: d.hint,
        severity: 'medium',
        marketplace: mp,
      };
      const prev = byKey.get(key);
      if (prev) {
        if (!prev.reasons.some((r) => r.code === 'dim_mismatch')) prev.reasons.push(reasonItem);
        continue;
      }
      byKey.set(key, {
        productId: pid || null,
        sku: d.sku,
        erpSku: d.erpSku,
        productName: d.productName,
        marketplace: mp,
        reasons: [reasonItem],
        soldQty: 0,
        soldAmount: 0,
        stockQty: 0,
      });
    }

    const items = finalizeItems(byKey, reasonFilter);

    return {
      period: turnoverData.period,
      marketplace: turnoverData.marketplace,
      scheme: turnoverData.scheme,
      thresholds,
      cardQuality: qualitySettings,
      summary: {
        cardsCount: items.length,
        highCount: items.filter((i) => i.severity === 'high').length,
        highTurnoverCount: items.filter((i) => i.reasonCodes.includes('low_turnover')).length,
        overstockCount: items.filter((i) => i.reasonCodes.includes('low_turnover')).length,
        lowTurnoverCount: items.filter((i) => i.reasonCodes.includes('low_turnover')).length,
        stockoutCount: items.filter((i) => i.reasonCodes.includes('stockout')).length,
        lowContentRatingCount: items.filter((i) => i.reasonCodes.includes('low_content_rating')).length,
        dimMismatchCount: items.filter((i) => i.reasonCodes.includes('dim_mismatch')).length,
      },
      items,
    };
  }
}

export default new MarketplaceCardWorkService();
