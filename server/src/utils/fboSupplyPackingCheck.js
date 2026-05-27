/**
 * Сверка плана поставки и фактической сборки (грузоместа).
 */

import { query } from '../config/database.js';

/**
 * @param {number|string} supplyId
 * @returns {Promise<{ allMatch: boolean, hasItems: boolean, discrepancies: Array<{ supplyItemId: number, planned: number, packed: number, discrepancy: number }> }>}
 */
export async function evaluateSupplyPacking(supplyId) {
  const sid = Number(supplyId);
  const r = await query(
    `SELECT i.id AS supply_item_id,
            i.quantity::int AS planned,
            COALESCE(SUM(cc.quantity), 0)::int AS packed
     FROM fbo_supply_items i
     LEFT JOIN fbo_supply_cargo_contents cc ON cc.fbo_supply_item_id = i.id
     LEFT JOIN fbo_supply_cargo_units cu
       ON cu.id = cc.cargo_unit_id AND cu.fbo_supply_id = i.fbo_supply_id
     WHERE i.fbo_supply_id = $1
     GROUP BY i.id, i.quantity
     ORDER BY i.id`,
    [sid]
  );
  const lines = r.rows || [];
  const discrepancies = [];
  for (const row of lines) {
    const planned = Number(row.planned) || 0;
    const packed = Number(row.packed) || 0;
    if (packed !== planned) {
      discrepancies.push({
        supplyItemId: Number(row.supply_item_id),
        planned,
        packed,
        discrepancy: packed - planned,
      });
    }
  }
  return {
    allMatch: lines.length > 0 && discrepancies.length === 0,
    hasItems: lines.length > 0,
    discrepancies,
  };
}

/**
 * Сверка сборки без смены статуса (статус меняется вручную, кроме запрета «Готов к поставке»).
 * @returns {Promise<{ allMatch: boolean, hasItems: boolean, status: string, reverted: boolean }>}
 */
export async function syncSupplyStatusForPacking(supplyId) {
  const { allMatch, hasItems } = await evaluateSupplyPacking(supplyId);
  const statusR = await query(`SELECT status FROM fbo_supplies WHERE id = $1 LIMIT 1`, [supplyId]);
  const status = statusR.rows?.[0]?.status || 'new';
  return { allMatch, hasItems, status, reverted: false };
}

export function assertCanSetReadyForSupply(packingEval) {
  if (!packingEval.hasItems) {
    const err = new Error('В поставке нет строк товаров');
    err.statusCode = 400;
    throw err;
  }
  if (!packingEval.allMatch) {
    const err = new Error(
      'Нельзя перевести в «Готов к поставке»: есть расхождения между планом и сборкой. Упакуйте по каждой позиции ровно запланированное количество.'
    );
    err.statusCode = 400;
    err.code = 'FBO_PACKING_DISCREPANCY';
    err.details = packingEval.discrepancies;
    throw err;
  }
}
