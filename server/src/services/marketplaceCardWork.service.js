/**
 * Очередь «Работа с карточками»: товары, по которым нужна реакция
 * (слишком высокая оборачиваемость, затоваривание, нет остатка).
 */

import marketplaceTurnoverAnalyticsService from './marketplaceTurnoverAnalytics.service.js';

const MP_LABEL = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс' };

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildReasons(row, { fastDays, slowDays, minTurnover }) {
  const reasons = [];
  const days = row.daysOfStock;
  const turnover = row.turnover;
  const mp = MP_LABEL[row.marketplace] || row.marketplace || 'МП';

  const tooFast =
    (days != null && Number.isFinite(days) && days < fastDays && row.soldQty > 0 && row.stockQty > 0) ||
    (turnover != null && Number.isFinite(turnover) && turnover >= minTurnover && row.stockQty > 0);

  if (tooFast) {
    const daysTxt = days != null ? `${days} дн. запаса` : 'остаток быстро уходит';
    const turnTxt = turnover != null ? `оборачиваемость ${turnover}` : '';
    reasons.push({
      code: 'high_turnover',
      label: 'Слишком высокая оборачиваемость',
      hint: `${mp}: ${[daysTxt, turnTxt].filter(Boolean).join(', ')}. Нужно проверить цену, остаток и карточку.`,
      severity: 'high',
    });
  }

  if (row.status === 'dead' || (days != null && days > slowDays && row.stockQty > 0)) {
    reasons.push({
      code: 'overstock',
      label: row.status === 'dead' ? 'Не продаётся при остатке' : 'Затоварен (медленная оборачиваемость)',
      hint:
        row.status === 'dead'
          ? `${mp}: остаток ${row.stockQty} шт., продаж за период нет. Улучшить карточку, цену или рекламу.`
          : `${mp}: запаса хватит на ${days} дн. Карточка продаёт слишком медленно.`,
      severity: row.status === 'dead' ? 'high' : 'medium',
    });
  }

  if (row.status === 'stockout') {
    reasons.push({
      code: 'stockout',
      label: 'Продажи без остатка на МП',
      hint: `${mp}: продано ${row.soldQty} шт., остаток на складе МП 0. Пополнить FBO или проверить выгрузку остатков.`,
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

    const byProduct = new Map();
    for (const row of turnoverData.items || []) {
      const reasons = buildReasons(row, thresholds);
      if (!reasons.length) continue;
      const pid = Number(row.productId) || 0;
      const key = pid > 0 ? `p:${pid}` : `s:${row.sku || row.erpSku || '—'}`;
      const prev = byProduct.get(key) || {
        productId: pid || null,
        sku: row.sku,
        erpSku: row.erpSku,
        productName: row.productName,
        reasons: [],
        soldQty: 0,
        soldAmount: 0,
        stockQty: 0,
      };
      prev.soldQty += Number(row.soldQty) || 0;
      prev.soldAmount += Number(row.soldAmount) || 0;
      prev.stockQty += Number(row.stockQty) || 0;
      if ((!prev.erpSku || prev.erpSku === '—') && row.erpSku) prev.erpSku = row.erpSku;
      if ((!prev.productName || prev.productName === '—') && row.productName) prev.productName = row.productName;
      prev.reasons.push(...reasons);
      byProduct.set(key, prev);
    }

    const reasonFilter = String(reason || 'all').trim();
    let items = [...byProduct.values()].map((item) => {
      const uniqueReasons = [];
      const seen = new Set();
      for (const r of item.reasons) {
        const k = `${r.code}|${r.marketplace}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniqueReasons.push(r);
      }
      uniqueReasons.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
      const severity = uniqueReasons.some((r) => r.severity === 'high') ? 'high' : 'medium';
      return {
        ...item,
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
      return (b.stockQty || 0) - (a.stockQty || 0);
    });

    return {
      period: turnoverData.period,
      marketplace: turnoverData.marketplace,
      scheme: turnoverData.scheme,
      thresholds,
      summary: {
        cardsCount: items.length,
        highCount: items.filter((i) => i.severity === 'high').length,
        highTurnoverCount: items.filter((i) => i.reasonCodes.includes('high_turnover')).length,
        overstockCount: items.filter((i) => i.reasonCodes.includes('overstock')).length,
        stockoutCount: items.filter((i) => i.reasonCodes.includes('stockout')).length,
      },
      items,
    };
  }
}

export default new MarketplaceCardWorkService();
