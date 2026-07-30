/**
 * Дозаполнение product_skus.ozon (offer + finance sku) и product_id в строках отчётов.
 * Finance SKU Ozon (items[].sku) часто ≠ marketplace_product_id — без mp_extra.ozon_sku аналитика
 * уходит в «Без категории».
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from '../services/integrations.service.js';
import { articlesMatch } from '../utils/offerArticleKey.js';

async function upsertOzonProductSku({ productId, offerId, ozonProductId, ozonFinanceSku }) {
  const offer = offerId != null ? String(offerId).trim() : '';
  if (!offer || !productId) return;

  const existing = await query(
    `SELECT id, marketplace_product_id, mp_extra
     FROM product_skus
     WHERE product_id = $1 AND marketplace = 'ozon'
     ORDER BY id ASC
     LIMIT 1`,
    [productId]
  );
  const row = existing.rows[0];
  const extra =
    row?.mp_extra && typeof row.mp_extra === 'object' && !Array.isArray(row.mp_extra)
      ? { ...row.mp_extra }
      : {};
  if (ozonFinanceSku != null && String(ozonFinanceSku).trim() !== '') {
    extra.ozon_sku = String(ozonFinanceSku).trim();
  }
  const mpId =
    ozonProductId != null && String(ozonProductId).trim() !== ''
      ? String(ozonProductId).trim()
      : row?.marketplace_product_id != null
        ? String(row.marketplace_product_id)
        : null;

  if (row) {
    await query(
      `UPDATE product_skus
       SET sku = COALESCE(NULLIF(TRIM(sku), ''), $2),
           marketplace_product_id = COALESCE($3, marketplace_product_id),
           mp_extra = $4::jsonb
       WHERE id = $1`,
      [row.id, offer, mpId, JSON.stringify(extra)]
    );
  } else {
    await query(
      `INSERT INTO product_skus (product_id, marketplace, sku, marketplace_product_id, mp_extra)
       VALUES ($1, 'ozon', $2, $3, $4::jsonb)`,
      [productId, offer, mpId, JSON.stringify(extra)]
    );
  }
}

function pickProductForOffer(products, offerId) {
  const offer = String(offerId || '').trim();
  if (!offer) return null;
  for (const p of products) {
    if (articlesMatch(p.sku, offer) || articlesMatch(p.name, offer)) return p;
    if (Array.isArray(p.skus)) {
      for (const s of p.skus) {
        if (s.marketplace === 'ozon' && articlesMatch(s.sku, offer)) return p;
      }
    }
  }
  return null;
}

/**
 * @param {number} profileId
 * @param {{ limit?: number }} [opts]
 */
export async function ensureOzonFinanceSkuLinks(profileId, opts = {}) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return { resolved: 0, linkedLines: 0 };

  const limit = Math.min(80, Math.max(1, Number(opts.limit) || 40));

  // 1) Из заказов: marketplace_sku (finance) → offer → product
  const fromOrders = await query(
    `SELECT DISTINCT TRIM(CAST(o.marketplace_sku AS TEXT)) AS finance_sku,
            TRIM(o.offer_id) AS offer_id
     FROM orders o
     WHERE o.profile_id = $1
       AND LOWER(o.marketplace) = 'ozon'
       AND o.marketplace_sku IS NOT NULL
       AND TRIM(CAST(o.marketplace_sku AS TEXT)) <> ''
       AND o.offer_id IS NOT NULL
       AND TRIM(o.offer_id) <> ''`,
    [pid]
  );

  const productsRes = await query(
    `SELECT p.id, p.sku, p.name, p.organization_id,
            COALESCE(
              (SELECT json_agg(json_build_object('marketplace', ps.marketplace, 'sku', ps.sku))
               FROM product_skus ps WHERE ps.product_id = p.id),
              '[]'::json
            ) AS skus
     FROM products p
     WHERE p.profile_id = $1`,
    [pid]
  );
  const products = productsRes.rows || [];

  let resolved = 0;
  for (const row of fromOrders.rows || []) {
    const p = pickProductForOffer(products, row.offer_id);
    if (!p) continue;
    await upsertOzonProductSku({
      productId: p.id,
      offerId: row.offer_id,
      ozonFinanceSku: row.finance_sku,
    });
    resolved += 1;
  }

  // 2) Непривязанные finance SKU из отчётов → Ozon API (по организациям профиля)
  const unlinked = await query(
    `SELECT DISTINCT TRIM(sku) AS finance_sku
     FROM (
       SELECT sku, product_id FROM marketplace_fbo_report_lines
       WHERE profile_id = $1 AND LOWER(TRIM(marketplace)) = 'ozon'
       UNION ALL
       SELECT sku, product_id FROM marketplace_fbs_report_lines
       WHERE profile_id = $1 AND LOWER(TRIM(marketplace)) = 'ozon'
     ) u
     WHERE product_id IS NULL
       AND sku IS NOT NULL AND TRIM(sku) <> '' AND TRIM(sku) <> '0'
       AND TRIM(sku) ~ '^[0-9]+$'
     LIMIT $2`,
    [pid, limit]
  );

  const orgs = await query(
    `SELECT id FROM organizations WHERE profile_id = $1 ORDER BY id ASC`,
    [pid]
  );
  const orgIds = (orgs.rows || []).map((r) => r.id);

  for (const row of unlinked.rows || []) {
    const financeSku = String(row.finance_sku).trim();
    let info = null;
    for (const organizationId of orgIds) {
      try {
        const data = await integrationsService._ozonApiPost(
          '/v3/product/info/list',
          { sku: [Number(financeSku)] },
          { profileId: pid, organizationId }
        );
        const items = data?.result?.items ?? data?.items ?? [];
        if (items[0]) {
          info = items[0];
          break;
        }
      } catch (e) {
        logger.warn('[Ozon finance link] product/info/list failed', {
          financeSku,
          organizationId,
          message: e?.message || String(e),
        });
      }
    }
    if (!info?.offer_id) continue;
    const p = pickProductForOffer(products, info.offer_id);
    if (!p) continue;
    await upsertOzonProductSku({
      productId: p.id,
      offerId: info.offer_id,
      ozonProductId: info.id,
      ozonFinanceSku: info.sku ?? financeSku,
    });
    resolved += 1;
  }

  // 3) Проставить product_id в строках отчётов по mp_extra.ozon_sku / marketplace_product_id / orders map
  const linkSql = `
    UPDATE marketplace_fbo_report_lines l
    SET product_id = m.product_id
    FROM (
      SELECT TRIM(ps.mp_extra->>'ozon_sku') AS mp_sku, ps.product_id
      FROM product_skus ps
      JOIN products p ON p.id = ps.product_id AND p.profile_id = $1
      WHERE ps.marketplace = 'ozon'
        AND NULLIF(TRIM(ps.mp_extra->>'ozon_sku'), '') IS NOT NULL
      UNION
      SELECT TRIM(CAST(ps.marketplace_product_id AS TEXT)), ps.product_id
      FROM product_skus ps
      JOIN products p ON p.id = ps.product_id AND p.profile_id = $1
      WHERE ps.marketplace = 'ozon'
        AND ps.marketplace_product_id IS NOT NULL
    ) m
    WHERE l.profile_id = $1
      AND l.marketplace = 'ozon'
      AND l.product_id IS NULL
      AND TRIM(l.sku) = m.mp_sku`;

  const fbo = await query(linkSql, [pid]);
  const fbs = await query(linkSql.replaceAll('marketplace_fbo_report_lines', 'marketplace_fbs_report_lines'), [pid]);

  const linkedLines = (fbo.rowCount || 0) + (fbs.rowCount || 0);
  logger.info('[Ozon finance link] ensure done', { profileId: pid, resolved, linkedLines });
  return { resolved, linkedLines };
}

export default { ensureOzonFinanceSkuLinks };
