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

const IDENT_KIND_LABEL = {
  sku: 'Артикул ERP',
  seller_sku: 'Артикул продавца',
  manufacturer_sku: 'Артикул производителя',
  barcode: 'Штрихкод',
};

function identRoleLabel(kind, marketplace) {
  if (kind === 'sku') return 'Артикул ERP';
  if (kind === 'barcode') return 'Штрихкод';
  if (kind === 'manufacturer_sku') {
    const mp = mpLabel(marketplace);
    return marketplace ? `Артикул производителя ${mp}` : 'Артикул производителя';
  }
  const mp = mpLabel(marketplace);
  return marketplace ? `Артикул продавца ${mp}` : 'Артикул продавца';
}

function identNorm(s) {
  return String(s || '').trim().toLowerCase();
}

function identDisplay(s) {
  const t = String(s || '').trim();
  return t || '';
}

function sharedScalar(products, getter) {
  if (!products.length) return null;
  const displays = products.map((p) => identDisplay(getter(p)));
  if (displays.some((v) => !v)) return null;
  const norms = displays.map(identNorm);
  if (new Set(norms).size !== 1) return null;
  return displays[0];
}

async function enrichDuplicateGroups(groups) {
  const ids = [...new Set(groups.flatMap((g) => (g.products || []).map((p) => Number(p.productId)).filter((n) => n > 0)))];
  if (!ids.length) return groups;

  let infoRows = [];
  let skuRows = [];
  let bcRows = [];
  try {
    const [infoRes, skuRes, bcRes] = await Promise.all([
      query(
        `SELECT p.id, p.sku, p.name, p.mp_wb_vendor_code, p.ozon_draft, p.ym_draft, b.name AS brand_name
           FROM products p
           LEFT JOIN brands b ON b.id = p.brand_id
          WHERE p.id = ANY($1::bigint[])`,
        [ids]
      ),
      query(
        `SELECT product_id, marketplace, sku
           FROM product_skus
          WHERE product_id = ANY($1::bigint[])`,
        [ids]
      ),
      query(
        `SELECT product_id, barcode
           FROM barcodes
          WHERE product_id = ANY($1::bigint[])
          ORDER BY id`,
        [ids]
      ),
    ]);
    infoRows = infoRes.rows || [];
    skuRows = skuRes.rows || [];
    bcRows = bcRes.rows || [];
  } catch {
    return groups;
  }

  const byId = new Map();
  for (const row of infoRows) {
    const ozonDraft = row.ozon_draft && typeof row.ozon_draft === 'object' ? row.ozon_draft : {};
    const ymDraft = row.ym_draft && typeof row.ym_draft === 'object' ? row.ym_draft : {};
    byId.set(Number(row.id), {
      sku: identDisplay(row.sku),
      productName: identDisplay(row.name),
      brand: identDisplay(row.brand_name),
      skuOzon: '',
      skuWb: identDisplay(row.mp_wb_vendor_code),
      skuYm: '',
      manufacturerOzon: identDisplay(ozonDraft.vendorCode),
      manufacturerYm: identDisplay(ymDraft.vendorCode),
      barcodes: [],
    });
  }
  for (const row of skuRows) {
    const rec = byId.get(Number(row.product_id));
    if (!rec) continue;
    const mp = String(row.marketplace || '').toLowerCase();
    const sku = identDisplay(row.sku);
    if (!sku) continue;
    if (mp === 'ozon') rec.skuOzon = sku;
    else if (mp === 'wb') rec.skuWb = sku;
    else if (mp === 'ym') rec.skuYm = sku;
  }
  for (const row of bcRows) {
    const rec = byId.get(Number(row.product_id));
    if (!rec) continue;
    const bc = identDisplay(row.barcode);
    if (bc && !rec.barcodes.includes(bc)) rec.barcodes.push(bc);
  }

  return groups.map((g) => {
    const products = (g.products || []).map((p) => {
      const extra = byId.get(Number(p.productId)) || {};
      return {
        ...p,
        sku: extra.sku || p.sku || '',
        productName: extra.productName || p.productName || '',
        brand: extra.brand || '',
        skuOzon: extra.skuOzon || '',
        skuWb: extra.skuWb || '',
        skuYm: extra.skuYm || '',
        manufacturerOzon: extra.manufacturerOzon || '',
        manufacturerYm: extra.manufacturerYm || '',
        barcodes: extra.barcodes || [],
      };
    });

    const same = [];
    const pushSame = (label, value) => {
      if (!value) return;
      if (same.some((s) => s.label === label && identNorm(s.value) === identNorm(value))) return;
      same.push({ label, value });
    };
    // Только идентификаторы; бренд и название не сверяем.
    pushSame('Артикул ERP', sharedScalar(products, (p) => p.sku));
    pushSame('Артикул продавца Ozon', sharedScalar(products, (p) => p.skuOzon));
    pushSame('Артикул продавца WB', sharedScalar(products, (p) => p.skuWb));
    pushSame('Артикул продавца Я.Маркет', sharedScalar(products, (p) => p.skuYm));
    pushSame('Артикул производителя Ozon', sharedScalar(products, (p) => p.manufacturerOzon));
    pushSame('Артикул производителя Я.Маркет', sharedScalar(products, (p) => p.manufacturerYm));

    const bcCount = new Map();
    for (const p of products) {
      const seen = new Set();
      for (const bc of p.barcodes || []) {
        const n = identNorm(bc);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        const prev = bcCount.get(n) || { value: bc, count: 0 };
        prev.count += 1;
        bcCount.set(n, prev);
      }
    }
    for (const x of bcCount.values()) {
      if (x.count >= 2) pushSame('Штрихкод', x.value);
    }

    // Отдельно по каждому типу: что именно одинаково у карточек группы.
    const matchedFields = [...same];
    const trigger = identNorm(g.value);
    const kindLab = (g.kindLabels && g.kindLabels[0]) || '';
    const triggerCovered = matchedFields.some((f) => identNorm(f.value) === trigger);
    if (!triggerCovered && g.value) {
      matchedFields.unshift({ label: kindLab || 'Совпадение', value: g.value });
    }

    return { ...g, products, matchedFields };
  });
}

/**
 * Товары с совпадающими идентификаторами одного типа:
 * артикул ERP ↔ ERP, артикул продавца ↔ продавца, артикул производителя ↔ производителя, ШК ↔ ШК.
 * Разные типы между собой не склеиваем (ERP DTSM3001 ≠ артикул продавца DTSM3001).
 */
async function listIdentifierDuplicates({ profileId } = {}) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) {
    return { groups: [], productCount: 0 };
  }
  let rows = [];
  try {
    const res = await query(
      `WITH active AS (
          SELECT p.id, p.sku, p.name, p.mp_wb_vendor_code, p.ozon_draft, p.ym_draft
            FROM products p
           WHERE p.profile_id = $1
             AND COALESCE(p.is_archived, false) = false
        ),
        idents AS (
          SELECT a.id AS product_id, a.sku AS erp_sku, a.name,
                 'sku'::text AS kind, NULL::text AS marketplace,
                 LOWER(TRIM(a.sku)) AS norm, TRIM(a.sku) AS display
            FROM active a
           WHERE TRIM(COALESCE(a.sku, '')) <> ''
          UNION ALL
          SELECT a.id, a.sku, a.name,
                 'seller_sku', ps.marketplace,
                 LOWER(TRIM(ps.sku::text)), TRIM(ps.sku::text)
            FROM active a
            JOIN product_skus ps ON ps.product_id = a.id
           WHERE TRIM(COALESCE(ps.sku::text, '')) <> ''
          UNION ALL
          SELECT a.id, a.sku, a.name,
                 'seller_sku', 'wb',
                 LOWER(TRIM(a.mp_wb_vendor_code)), TRIM(a.mp_wb_vendor_code)
            FROM active a
           WHERE TRIM(COALESCE(a.mp_wb_vendor_code, '')) <> ''
             AND NOT EXISTS (
               SELECT 1 FROM product_skus ps
                WHERE ps.product_id = a.id
                  AND ps.marketplace = 'wb'
                  AND LOWER(TRIM(ps.sku::text)) = LOWER(TRIM(a.mp_wb_vendor_code))
             )
          UNION ALL
          SELECT a.id, a.sku, a.name,
                 'manufacturer_sku', 'ozon',
                 LOWER(TRIM(a.ozon_draft->>'vendorCode')),
                 TRIM(a.ozon_draft->>'vendorCode')
            FROM active a
           WHERE TRIM(COALESCE(a.ozon_draft->>'vendorCode', '')) <> ''
          UNION ALL
          SELECT a.id, a.sku, a.name,
                 'manufacturer_sku', 'ym',
                 LOWER(TRIM(a.ym_draft->>'vendorCode')),
                 TRIM(a.ym_draft->>'vendorCode')
            FROM active a
           WHERE TRIM(COALESCE(a.ym_draft->>'vendorCode', '')) <> ''
          UNION ALL
          SELECT a.id, a.sku, a.name,
                 'barcode', NULL,
                 LOWER(TRIM(b.barcode)), TRIM(b.barcode)
            FROM active a
            JOIN barcodes b ON b.product_id = a.id
           WHERE TRIM(COALESCE(b.barcode, '')) <> ''
        ),
        collisions AS (
          SELECT kind, norm, COUNT(DISTINCT product_id) AS product_count, MIN(display) AS display
            FROM idents
           GROUP BY kind, norm
          HAVING COUNT(DISTINCT product_id) > 1
        )
        SELECT i.kind, i.marketplace, c.display, i.norm,
               i.product_id, i.erp_sku, i.name
          FROM idents i
          JOIN collisions c ON c.kind = i.kind AND c.norm = i.norm
         ORDER BY c.product_count DESC, i.kind, i.norm, i.erp_sku NULLS LAST, i.product_id`,
      [pid]
    );
    rows = res.rows || [];
  } catch (e) {
    return { groups: [], productCount: 0 };
  }

  const byKey = new Map();
  for (const row of rows) {
    const kind = String(row.kind || '');
    const norm = String(row.norm || '');
    if (!kind || !norm) continue;
    const key = `${kind}|${norm}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        kind,
        value: String(row.display || row.erp_sku || norm),
        products: new Map(),
      };
      byKey.set(key, group);
    }
    const productId = Number(row.product_id) || 0;
    if (productId < 1) continue;
    let prod = group.products.get(productId);
    if (!prod) {
      prod = {
        productId,
        sku: row.erp_sku || '',
        productName: row.name || '',
        roles: [],
      };
      group.products.set(productId, prod);
    }
    const role = identRoleLabel(row.kind, row.marketplace);
    if (!prod.roles.includes(role)) prod.roles.push(role);
  }

  const groups = [...byKey.values()]
    .map((g) => {
      const products = [...g.products.values()].sort((a, b) =>
        String(a.sku || '').localeCompare(String(b.sku || ''), 'ru')
      );
      return {
        value: g.value,
        kinds: [g.kind],
        kindLabels: [IDENT_KIND_LABEL[g.kind] || g.kind],
        products,
      };
    })
    .filter((g) => g.products.length > 1)
    .sort(
      (a, b) =>
        b.products.length - a.products.length ||
        String(a.kindLabels[0] || '').localeCompare(String(b.kindLabels[0] || ''), 'ru') ||
        String(a.value).localeCompare(String(b.value), 'ru')
    );

  const enriched = await enrichDuplicateGroups(groups);
  const productIds = new Set();
  for (const g of enriched) {
    for (const p of g.products) productIds.add(p.productId);
  }
  return { groups: enriched, productCount: productIds.size };
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
  /** Дубли идентификаторов — без отчёта продаж и периода. */
  async getDuplicates({ profileId } = {}) {
    return listIdentifierDuplicates({ profileId });
  }

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
