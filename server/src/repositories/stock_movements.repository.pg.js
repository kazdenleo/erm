/**
 * Stock Movements Repository (PostgreSQL)
 * Журнал движений остатков по товарам
 */

import { query } from '../config/database.js';

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
  async insertSnapshotAfterProduct(client, { productId, type, quantityChange, reason = null, meta = null, warehouseId = null, profileId = null }) {
    const run = client && typeof client.query === 'function' ? client.query.bind(client) : query;
    const metaJson = meta == null ? null : typeof meta === 'string' ? meta : JSON.stringify(meta);
    const wh = warehouseId != null && warehouseId !== '' ? warehouseId : null;
    const profOverride = normalizeProfileId(profileId);
    const sql = `
      INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, incoming_after, reserved_after, reason, meta, warehouse_id, profile_id)
      SELECT $1::bigint, $2::varchar(32), $3::int,
             COALESCE(p.quantity, 0)::int,
             COALESCE(p.incoming_quantity, 0)::int,
             COALESCE(p.reserved_quantity, 0)::int,
             $4, $5::jsonb, $6,
             COALESCE($7::bigint, p.profile_id)
      FROM products p
      WHERE p.id = $1::bigint
      RETURNING *
    `;
    const params = [productId, type, quantityChange, reason, metaJson, wh, profOverride];
    const result = await run(sql, params);
    return result.rows[0] || null;
  }

  /**
   * Получить историю движений по товару
   * @param {number|string} productId
   * @param {object} options
   * @param {number} [options.limit=100]
   */
  async findByProduct(productId, { limit = 100, profileId = null } = {}) {
    const numericId = typeof productId === 'string' ? parseInt(productId, 10) : productId;
    if (!numericId || Number.isNaN(numericId)) {
      return [];
    }
    const pid = normalizeProfileId(profileId);

    const sql = pid
      ? `
      SELECT id, product_id, created_at, type, reason, quantity_change, balance_after, incoming_after, reserved_after, meta, warehouse_id
      FROM stock_movements
      WHERE product_id = $1 AND profile_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `
      : `
      SELECT id, product_id, created_at, type, reason, quantity_change, balance_after, incoming_after, reserved_after, meta, warehouse_id
      FROM stock_movements
      WHERE product_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `;
    const result = pid
      ? await query(sql, [numericId, limit, pid])
      : await query(sql, [numericId, limit]);
    return result.rows || [];
  }
}

export default new StockMovementsRepositoryPG();

