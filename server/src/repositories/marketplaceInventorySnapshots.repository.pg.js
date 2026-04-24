import { query } from '../config/database.js';

export class MarketplaceInventorySnapshotsRepositoryPG {
  async createSnapshot({ profileId = null, organizationId = null, marketplace, source = null, notes = null }) {
    const res = await query(
      `
      INSERT INTO marketplace_inventory_snapshots (profile_id, organization_id, marketplace, source, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, profile_id, organization_id, marketplace, created_at, source, notes
    `,
      [profileId, organizationId != null ? Number(organizationId) : null, String(marketplace), source, notes]
    );
    return res.rows?.[0] || null;
  }

  async insertLines(snapshotId, lines) {
    const sid = Number(snapshotId);
    if (!Number.isFinite(sid) || sid < 1) return 0;
    const list = Array.isArray(lines) ? lines : [];
    if (list.length === 0) return 0;

    const cols = `snapshot_id, state, external_sku, warehouse_name, quantity, wb_vendor_code`;
    const params = [];
    const placeholders = [];
    let p = 1;
    for (const line of list) {
      const state = String(line?.state ?? '').trim();
      const externalSku = String(line?.externalSku ?? line?.external_sku ?? '').trim();
      if (!state || !externalSku) continue;
      const warehouseName =
        line?.warehouseName != null && String(line.warehouseName).trim() !== ''
          ? String(line.warehouseName).trim()
          : null;
      const qty = Math.trunc(Number(line?.quantity ?? 0));
      const wbVendorRaw = line?.wbVendorCode ?? line?.wb_vendor_code;
      const wbVendorCode =
        wbVendorRaw != null && String(wbVendorRaw).trim() !== '' ? String(wbVendorRaw).trim() : null;
      params.push(sid, state, externalSku, warehouseName, Number.isFinite(qty) ? qty : 0, wbVendorCode);
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    }
    if (placeholders.length === 0) return 0;

    const res = await query(
      `INSERT INTO marketplace_inventory_snapshot_lines (${cols}) VALUES ${placeholders.join(', ')}`,
      params
    );
    return res.rowCount || 0;
  }

  async getLatestSnapshotByMarketplace(marketplace, { profileId = null, organizationId = null } = {}) {
    const mp = String(marketplace || '').trim().toLowerCase();
    if (!mp) return null;
    const res = await query(
      `
      SELECT id, profile_id, organization_id, marketplace, created_at, source, notes
      FROM marketplace_inventory_snapshots
      WHERE marketplace = $1
        AND ($2::bigint IS NULL OR profile_id = $2::bigint)
        AND ($3::bigint IS NULL OR organization_id = $3::bigint)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
      [mp, profileId != null ? Number(profileId) : null, organizationId != null ? Number(organizationId) : null]
    );
    return res.rows?.[0] || null;
  }

  async getTotalsBySnapshotId(snapshotId) {
    const sid = Number(snapshotId);
    if (!Number.isFinite(sid) || sid < 1) return [];
    const res = await query(
      `
      SELECT state, SUM(quantity)::int AS qty
      FROM marketplace_inventory_snapshot_lines
      WHERE snapshot_id = $1
      GROUP BY state
      ORDER BY state
    `,
      [sid]
    );
    return res.rows || [];
  }

  /**
   * Сумма себестоимостей по снапшоту: join lines.external_sku → product_skus.sku → products.cost.
   * Важно: считаем только товары, которые сопоставлены с каталогом.
   */
  async getCostSumsBySnapshotId(snapshotId, marketplace) {
    const sid = Number(snapshotId);
    if (!Number.isFinite(sid) || sid < 1) return [];
    const mp = String(marketplace || '').trim().toLowerCase();
    if (!mp) return [];
    const dbMarketplace = mp === 'wildberries' ? 'wb' : mp === 'yandex' ? 'ym' : mp;
    const res = await query(
      `
      SELECT
        l.state,
        SUM(GREATEST(0, l.quantity) * COALESCE(p.cost, 0))::numeric(14,2) AS cost_sum,
        SUM(GREATEST(0, l.quantity))::int AS qty_sum,
        COUNT(DISTINCT ps.product_id)::int AS matched_products
      FROM marketplace_inventory_snapshot_lines l
      JOIN product_skus ps
        ON ps.marketplace = $2::text
       AND (
         TRIM(ps.sku) = TRIM(l.external_sku)
         OR (
           $2::text = 'ozon'
           AND NULLIF(ps.marketplace_product_id, 0) IS NOT NULL
           AND TRIM(l.external_sku) ~ '^[0-9]+$'
           AND ps.marketplace_product_id = (TRIM(l.external_sku))::bigint
         )
         OR (
           $2::text = 'wb'
           AND (
             TRIM(ps.sku) = NULLIF(split_part(TRIM(l.external_sku), ':', 1), '')
             OR (
               NULLIF(split_part(TRIM(l.external_sku), ':', 2), '') IS NOT NULL
               AND TRIM(ps.sku) = NULLIF(split_part(TRIM(l.external_sku), ':', 2), '')
             )
             OR (
               NULLIF(TRIM(REGEXP_REPLACE(TRIM(ps.sku), '^.*?([0-9]+)$', '\\1')), '') IS NOT NULL
               AND (
                 TRIM(REGEXP_REPLACE(TRIM(ps.sku), '^.*?([0-9]+)$', '\\1')) = NULLIF(split_part(TRIM(l.external_sku), ':', 1), '')
                 OR (
                   NULLIF(split_part(TRIM(l.external_sku), ':', 2), '') IS NOT NULL
                   AND TRIM(REGEXP_REPLACE(TRIM(ps.sku), '^.*?([0-9]+)$', '\\1')) = NULLIF(split_part(TRIM(l.external_sku), ':', 2), '')
                 )
               )
             )
             OR (
               NULLIF(TRIM(l.wb_vendor_code), '') IS NOT NULL
               AND LOWER(TRIM(ps.sku)) = LOWER(TRIM(l.wb_vendor_code))
             )
           )
         )
       )
      JOIN products p ON p.id = ps.product_id
      WHERE l.snapshot_id = $1
      GROUP BY l.state
      ORDER BY l.state
    `,
      [sid, dbMarketplace]
    );
    return res.rows || [];
  }

  /**
   * "В пути к клиенту" по заказам в системе (orders.status IN in_transit/shipped),
   * чтобы цифры совпадали с фактическими заказами FBS, даже если API остатков МП не отдаёт in_transit.
   *
   * Матчинг на каталог:
   * - если orders.product_id заполнен — берём его cost
   * - иначе пытаемся сопоставить по product_skus (sku = offer_id / marketplace_sku)
   */
  async getToCustomerFromOrders({ profileId, marketplace }) {
    const pid = profileId != null && String(profileId).trim() !== '' ? Number(profileId) : null;
    if (!Number.isFinite(pid) || pid < 1) return null;
    const mp = String(marketplace || '').trim().toLowerCase();
    if (!mp) return null;
    const dbMp = mp === 'wildberries' ? 'wb' : mp === 'yandex' ? 'ym' : mp;

    const res = await query(
      `
      SELECT
        'to_customer'::text AS state,
        SUM(GREATEST(0, o.quantity))::int AS qty_sum,
        SUM(GREATEST(0, o.quantity) * COALESCE(p_direct.cost, p_sku.cost, 0))::numeric(14,2) AS cost_sum,
        COUNT(DISTINCT COALESCE(p_direct.id, p_sku.id))::int AS matched_products
      FROM orders o
      LEFT JOIN products p_direct ON p_direct.id = o.product_id
      LEFT JOIN product_skus ps
        ON ps.marketplace = $2
       AND TRIM(ps.sku) = TRIM(
         COALESCE(
           NULLIF(o.offer_id, ''),
           NULLIF(o.marketplace_sku::text, '')
         )
       )
      LEFT JOIN products p_sku ON p_sku.id = ps.product_id
      WHERE o.profile_id = $1
        AND o.marketplace = $2
        AND LOWER(COALESCE(o.status, '')) IN ('in_transit', 'shipped')
    `,
      [pid, dbMp]
    );
    return res.rows?.[0] || null;
  }
}

export default new MarketplaceInventorySnapshotsRepositoryPG();

