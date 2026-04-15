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
  async create({ productId, type, quantityChange, balanceAfter = null, reason = null, meta = null, warehouseId = null, profileId = null }) {
    const profId = normalizeProfileId(profileId);
    const sql = `
      INSERT INTO stock_movements
        (product_id, type, quantity_change, balance_after, reason, meta, warehouse_id, profile_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const params = [
      productId,
      type,
      quantityChange,
      balanceAfter,
      reason,
      meta ? JSON.stringify(meta) : null,
      warehouseId != null && warehouseId !== '' ? warehouseId : null,
      profId
    ];
    const result = await query(sql, params);
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
      SELECT id, product_id, created_at, type, reason, quantity_change, balance_after, meta, warehouse_id
      FROM stock_movements
      WHERE product_id = $1 AND profile_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `
      : `
      SELECT id, product_id, created_at, type, reason, quantity_change, balance_after, meta, warehouse_id
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

