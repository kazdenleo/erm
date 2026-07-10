/**
 * Stock Movements Repository (PostgreSQL)
 * Журнал движений остатков по товарам
 */

import { query } from '../config/database.js';
import { NET_RESERVED_SUM_EXPR_SQL } from '../constants/netReservedStockSql.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

class StockMovementsRepositoryPG {
  /**
   * Создать запись движения остатков
   * @param {object} params
   * @param {number} params.productId
   * @param {string} params.type - 'receipt' | 'writeoff' | 'shipment' | 'reserve' | 'unreserve' | 'inventory' | 'manual'
   * @param {number} params.quantityChange - положительное или отрицательное число
   * @param {number|null} params.balanceAfter - остаток после операции (может быть null, если не считаем)
   * @param {string|null} params.reason - человекочитаемое описание
   * @param {object|null} params.meta - произвольные дополнительные данные (JSON)
   */
  async create({
    productId,
    type,
    quantityChange,
    balanceAfter = null,
    incomingAfter = null,
    reservedAfter = null,
    reason = null,
    meta = null,
    warehouseId = null,
    profileId = null,
  }) {
    const profId = normalizeProfileId(profileId);
    const sql = `
      INSERT INTO stock_movements
        (product_id, type, quantity_change, balance_after, incoming_after, reserved_after, reason, meta, warehouse_id, profile_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
    const params = [
      productId,
      type,
      quantityChange,
      balanceAfter,
      incomingAfter,
      reservedAfter,
      reason,
      meta ? JSON.stringify(meta) : null,
      warehouseId != null && warehouseId !== '' ? warehouseId : null,
      profId,
    ];
    const result = await query(sql, params);
    return result.rows[0] || null;
  }

  /**
   * Запись движения со снимком products.* после того, как вызывающий код уже обновил остатки (в той же транзакции).
   * @param {import('pg').PoolClient|null} client — если null, используется пул
   */
  async insertSnapshotAfterProduct(
    client,
    {
      productId,
      type,
      quantityChange,
      reason = null,
      meta = null,
      warehouseId = null,
      profileId = null,
      skipReservedQtySync = false,
    } = {}
  ) {
    const run = client && typeof client.query === 'function' ? client.query.bind(client) : query;
    const metaJson = meta == null ? null : typeof meta === 'string' ? meta : JSON.stringify(meta);
    const wh = warehouseId != null && warehouseId !== '' ? warehouseId : null;
    const profOverride = normalizeProfileId(profileId);
    const typeNormPre = type != null ? String(type).trim().toLowerCase() : '';
    const qc = Number(quantityChange);
    if (typeNormPre === 'reserve' && (!Number.isFinite(qc) || qc >= 0)) {
      const err = new Error('Резерв: quantity_change должно быть отрицательным');
      err.statusCode = 400;
      throw err;
    }
    const sql = `
      INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, incoming_after, reserved_after, reason, meta, warehouse_id, profile_id)
      SELECT $1::bigint, $2::varchar(32), $3::int,
             COALESCE(p.quantity, 0)::int,
             COALESCE(p.incoming_quantity, 0)::int,
             CASE
               WHEN $2::varchar IN ('reserve', 'unreserve') THEN GREATEST(0, (
                 COALESCE((
                   SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
                   FROM stock_movements sm
                   WHERE sm.product_id = p.id AND sm.type IN ('reserve', 'unreserve')
                 ), 0)
                 + CASE
                   WHEN $2::varchar = 'reserve' AND $3::int < 0 THEN (-$3::int)
                   WHEN $2::varchar = 'reserve' AND $3::int > 0 THEN $3::int
                   WHEN $2::varchar = 'unreserve' AND $3::int > 0 THEN (-$3::int)
                   WHEN $2::varchar = 'unreserve' AND $3::int < 0 THEN $3::int
                   ELSE 0
                 END
               ))::int
               ELSE COALESCE((
                 SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
                 FROM stock_movements sm
                 WHERE sm.product_id = p.id AND sm.type IN ('reserve', 'unreserve')
               ), COALESCE(p.reserved_quantity, 0), 0)::int
             END,
             $4, $5::jsonb, $6,
             COALESCE($7::bigint, p.profile_id)
      FROM products p
      WHERE p.id = $1::bigint
      RETURNING *
    `;
    const params = [productId, type, quantityChange, reason, metaJson, wh, profOverride];
    const result = await run(sql, params);
    const movement = result.rows[0] || null;
    const typeNorm = type != null ? String(type).trim().toLowerCase() : '';
    if (movement && !skipReservedQtySync && typeNorm !== 'reserve' && typeNorm !== 'unreserve') {
      await run(
        `UPDATE products p
         SET reserved_quantity = COALESCE((
           SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int
           FROM stock_movements sm
           WHERE sm.product_id = p.id AND sm.type IN ('reserve', 'unreserve')
         ), 0),
         updated_at = CURRENT_TIMESTAMP
         WHERE p.id = $1::bigint`,
        [productId]
      );
    }
    return movement;
  }

  /**
   * Получить историю движений по товару
   * @param {number|string} productId
   * @param {object} options
   * @param {number} [options.limit=100]
   */
  async findByProduct(productId, { limit = 100, profileId = null, warehouseId = null } = {}) {
    const numericId = typeof productId === 'string' ? parseInt(productId, 10) : productId;
    if (!numericId || Number.isNaN(numericId)) {
      return [];
    }
    const pid = normalizeProfileId(profileId);
    const whRaw = warehouseId != null && warehouseId !== '' ? Number(warehouseId) : null;
    const whId = Number.isFinite(whRaw) && whRaw > 0 ? whRaw : null;

    const params = [numericId];
    const where = ['product_id = $1'];
    if (whId != null) {
      params.push(whId);
      const whIdx = params.length;
      // Старые записи могли иметь warehouse_id только в meta — показываем их в фильтре по складу.
      where.push(
        `(warehouse_id = $${whIdx} OR (
          warehouse_id IS NULL
          AND COALESCE((meta->>'warehouse_id')::bigint, (meta->>'warehouseId')::bigint) = $${whIdx}
        ))`
      );
    }
    if (pid != null) {
      params.push(pid);
      // У старых записей profile_id мог быть NULL — разрешаем показывать их внутри профиля.
      where.push(`(profile_id = $${params.length} OR profile_id IS NULL)`);
    }
    params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
    const limitIdx = params.length;

    const sql = `
      SELECT id, product_id, created_at, type, reason, quantity_change, balance_after, incoming_after, reserved_after, meta, warehouse_id
      FROM stock_movements
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitIdx}
    `;
    const result = await query(sql, params);
    return result.rows || [];
  }

  /**
   * Список ручных списаний (type = writeoff) с фильтрами по организации и складу.
   */
  async findWriteoffs({
    limit = 200,
    offset = 0,
    profileId = null,
    organizationId = null,
    warehouseId = null,
  } = {}) {
    const pid = normalizeProfileId(profileId);
    const lim = Math.max(1, Math.min(500, Number(limit) || 200));
    const off = Math.max(0, Number(offset) || 0);

    const orgRaw =
      organizationId != null && organizationId !== '' ? Number(organizationId) : null;
    const orgId = Number.isFinite(orgRaw) && orgRaw > 0 ? orgRaw : null;
    const whRaw = warehouseId != null && warehouseId !== '' ? Number(warehouseId) : null;
    const whId = Number.isFinite(whRaw) && whRaw > 0 ? whRaw : null;

    const params = [];
    const where = [`LOWER(TRIM(sm.type::text)) = 'writeoff'`];

    if (pid != null) {
      params.push(pid);
      where.push(
        `(sm.profile_id = $${params.length} OR sm.profile_id IS NULL)`
      );
      where.push(`(p.profile_id = $${params.length} OR p.profile_id IS NULL)`);
    }
    if (whId != null) {
      params.push(whId);
      where.push(`sm.warehouse_id = $${params.length}`);
    }
    if (orgId != null) {
      params.push(orgId);
      where.push(`w.organization_id = $${params.length}`);
    }

    params.push(lim);
    const limitIdx = params.length;
    params.push(off);
    const offsetIdx = params.length;

    const sql = `
      SELECT sm.id,
             sm.created_at,
             sm.quantity_change,
             sm.reason,
             sm.warehouse_id,
             sm.product_id,
             sm.meta,
             p.sku AS product_sku,
             p.name AS product_name,
             w.address AS warehouse_name,
             w.organization_id,
             o.name AS organization_name
      FROM stock_movements sm
      INNER JOIN products p ON p.id = sm.product_id
      LEFT JOIN warehouses w ON w.id = sm.warehouse_id
      LEFT JOIN organizations o ON o.id = w.organization_id
      WHERE ${where.join(' AND ')}
      ORDER BY sm.created_at DESC, sm.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const result = await query(sql, params);
    return result.rows || [];
  }
}

export default new StockMovementsRepositoryPG();

