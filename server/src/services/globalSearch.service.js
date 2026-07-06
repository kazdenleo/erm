/**
 * Глобальный поиск: товары, заказы, закупки.
 */

import { query } from '../config/database.js';

function escapeLike(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function normalizeQuery(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

class GlobalSearchService {
  async search(profileId, rawQuery, { limit = 8 } = {}) {
    const pid = profileId != null ? Number(profileId) : null;
    const q = normalizeQuery(rawQuery);
    if (!Number.isFinite(pid) || pid < 1 || !q) {
      return { query: q, products: [], orders: [], purchases: [] };
    }

    const cap = Math.min(Math.max(1, parseInt(limit, 10) || 8), 20);
    const pattern = `%${escapeLike(q)}%`;
    const digitsOnly = /^\d+$/.test(q);

    const [productsRes, ordersRes, purchasesRes] = await Promise.all([
      query(
        `SELECT DISTINCT ON (p.id)
                p.id, p.sku, p.name
         FROM products p
         LEFT JOIN barcodes bc ON bc.product_id = p.id
         LEFT JOIN product_skus ps ON ps.product_id = p.id
         WHERE p.profile_id = $1
           AND (
             p.name ILIKE $2 ESCAPE '\\'
             OR p.sku ILIKE $2 ESCAPE '\\'
             OR COALESCE(bc.barcode, '') ILIKE $2 ESCAPE '\\'
             OR COALESCE(TRIM(ps.sku::text), '') ILIKE $2 ESCAPE '\\'
             OR COALESCE(ps.marketplace_product_id::text, '') ILIKE $2 ESCAPE '\\'
           )
         ORDER BY p.id, p.name ASC
         LIMIT $3`,
        [pid, pattern, cap]
      ),
      query(
        `SELECT o.id, o.marketplace, o.order_id, o.product_name, o.status, o.offer_id,
                COALESCE(p.sku, '') AS product_sku
         FROM orders o
         LEFT JOIN products p ON p.id = o.product_id
         WHERE o.profile_id = $1
           AND (
             o.order_id ILIKE $2 ESCAPE '\\'
             OR COALESCE(o.product_name, '') ILIKE $2 ESCAPE '\\'
             OR COALESCE(o.customer_name, '') ILIKE $2 ESCAPE '\\'
             OR COALESCE(o.offer_id, '') ILIKE $2 ESCAPE '\\'
             OR COALESCE(o.marketplace_sku::text, '') ILIKE $2 ESCAPE '\\'
             OR COALESCE(p.sku, '') ILIKE $2 ESCAPE '\\'
             OR COALESCE(p.name, '') ILIKE $2 ESCAPE '\\'
           )
         ORDER BY o.created_at DESC NULLS LAST, o.id DESC
         LIMIT $3`,
        [pid, pattern, cap]
      ),
      query(
        `SELECT DISTINCT ON (pu.id)
                pu.id, pu.status, pu.note, s.name AS supplier_name
         FROM purchases pu
         LEFT JOIN suppliers s ON s.id = pu.supplier_id
         LEFT JOIN purchase_items pi ON pi.purchase_id = pu.id
         LEFT JOIN products pr ON pr.id = pi.product_id
         WHERE pu.profile_id = $1
           AND (
             COALESCE(pu.note, '') ILIKE $2 ESCAPE '\\'
             OR COALESCE(pr.name, '') ILIKE $2 ESCAPE '\\'
             OR COALESCE(pr.sku, '') ILIKE $2 ESCAPE '\\'
             ${digitsOnly ? 'OR pu.id = $4' : ''}
           )
         ORDER BY pu.id DESC, pu.created_at DESC
         LIMIT $3`,
        digitsOnly ? [pid, pattern, cap, parseInt(q, 10)] : [pid, pattern, cap]
      ),
    ]);

    return {
      query: q,
      products: (productsRes.rows || []).map((r) => ({
        id: Number(r.id),
        sku: r.sku || null,
        name: r.name || null,
      })),
      orders: (ordersRes.rows || []).map((r) => ({
        id: Number(r.id),
        marketplace: r.marketplace,
        orderId: r.order_id,
        productName: r.product_name || null,
        productSku: r.product_sku || null,
        offerId: r.offer_id || null,
        status: r.status || null,
      })),
      purchases: (purchasesRes.rows || []).map((r) => ({
        id: Number(r.id),
        status: r.status || null,
        note: r.note || null,
        supplierName: r.supplier_name || null,
      })),
    };
  }
}

export default new GlobalSearchService();
