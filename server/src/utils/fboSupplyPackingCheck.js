/**
 * Сверка плана поставки и фактической сборки (грузоместа).
 */

import { query } from '../config/database.js';
import { getFboSupplyStatusRank } from '../constants/fboSupplyStatuses.js';

const STATUSES_REQUIRING_COMPLETE_PACKING = new Set(['ready_for_supply']);

/** Статусы до «Готова к отгрузке», из которых можно автопродвинуть по полной упаковке. */
const STATUSES_PROMOTE_TO_READY = new Set(['new', 'collecting', 'packing']);

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
    if (planned <= 0) {
      if (packed > 0) {
        discrepancies.push({
          supplyItemId: Number(row.supply_item_id),
          planned,
          packed,
          discrepancy: packed - planned,
        });
      }
      continue;
    }
    if (packed !== planned) {
      discrepancies.push({
        supplyItemId: Number(row.supply_item_id),
        planned,
        packed,
        discrepancy: packed - planned,
      });
    }
  }
  const hasPlannedQty = lines.some((row) => (Number(row.planned) || 0) > 0);
  return {
    allMatch: hasPlannedQty && discrepancies.length === 0,
    hasItems: lines.length > 0,
    hasPlannedQty,
    discrepancies,
  };
}

/** Сверка плана/факта из уже посчитанного packing.itemStats (без лишнего запроса в БД). */
export function packingEvalFromItemStats(itemStats = []) {
  const discrepancies = [];
  for (const row of itemStats) {
    const supplyItemId = Number(row.supplyItemId);
    if (!Number.isFinite(supplyItemId)) continue;
    const planned = Number(row.planned) || 0;
    const packed = Number(row.packed) || 0;
    if (planned <= 0) {
      if (packed > 0) {
        discrepancies.push({
          supplyItemId,
          planned,
          packed,
          discrepancy: packed - planned,
        });
      }
      continue;
    }
    if (packed !== planned) {
      discrepancies.push({
        supplyItemId,
        planned,
        packed,
        discrepancy: packed - planned,
      });
    }
  }
  const hasPlannedQty = itemStats.some((row) => (Number(row.planned) || 0) > 0);
  return {
    allMatch: hasPlannedQty && discrepancies.length === 0,
    hasItems: itemStats.length > 0,
    hasPlannedQty,
    discrepancies,
  };
}

async function resolveIncompleteWorkStatus(supplyId) {
  const cargoR = await query(
    `SELECT 1 FROM fbo_supply_cargo_units WHERE fbo_supply_id = $1 LIMIT 1`,
    [supplyId]
  );
  if (cargoR.rows?.length) return 'packing';
  const collectR = await query(
    `SELECT 1 FROM fbo_supply_items
     WHERE fbo_supply_id = $1 AND COALESCE(collected_quantity, 0) > 0
     LIMIT 1`,
    [supplyId]
  );
  if (collectR.rows?.length) return 'collecting';
  return 'new';
}

/**
 * Поднять статус поставки минимум до target, если текущий «раньше» по цепочке.
 * Не трогает shipped/closed/return и статусы уже не ниже target.
 * @returns {Promise<{ status: string, changed: boolean }>}
 */
export async function ensureFboSupplyStatusAtLeast(supplyId, targetStatus) {
  const sid = Number(supplyId);
  const target = String(targetStatus || '').trim();
  const targetRank = getFboSupplyStatusRank(target);
  if (!Number.isFinite(sid) || sid < 1 || targetRank < 0) {
    return { status: null, changed: false };
  }

  const statusR = await query(`SELECT status FROM fbo_supplies WHERE id = $1 LIMIT 1`, [sid]);
  const current = String(statusR.rows?.[0]?.status || 'new');
  if (current === 'shipped' || current === 'closed' || current === 'return') {
    return { status: current, changed: false };
  }
  // Уже «Готова к отгрузке» — не откатываем стартом сборки/упаковки.
  if (STATUSES_REQUIRING_COMPLETE_PACKING.has(current)) {
    return { status: current, changed: false };
  }
  const curRank = getFboSupplyStatusRank(current);
  if (curRank >= targetRank) {
    return { status: current, changed: false };
  }

  await query(
    `UPDATE fbo_supplies SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [sid, target]
  );
  return { status: target, changed: true };
}

/**
 * После изменения упаковки:
 * — при расхождениях откатываем «Готова к отгрузке» → Упаковка/Сборка/Новая;
 * — при полной упаковке → «Готова к отгрузке»;
 * — при начале упаковки (есть грузоместа, статус Новая/Сборка) → «Упаковка».
 * @returns {Promise<{ allMatch: boolean, hasItems: boolean, status: string, reverted: boolean, promoted: boolean, discrepancies: Array }>}
 */
export async function syncSupplyStatusForPacking(supplyId, { packingEval: precomputed } = {}) {
  const packingEval = precomputed ?? (await evaluateSupplyPacking(supplyId));
  const { allMatch, hasItems, hasPlannedQty, discrepancies } = packingEval;
  const statusR = await query(`SELECT status FROM fbo_supplies WHERE id = $1 LIMIT 1`, [supplyId]);
  let status = statusR.rows?.[0]?.status || 'new';
  let reverted = false;
  let promoted = false;

  const packingIncomplete = hasItems && !allMatch;
  if (packingIncomplete && STATUSES_REQUIRING_COMPLETE_PACKING.has(status)) {
    const next = await resolveIncompleteWorkStatus(supplyId);
    await query(
      `UPDATE fbo_supplies SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [supplyId, next]
    );
    status = next;
    reverted = true;
  } else if (STATUSES_PROMOTE_TO_READY.has(status) && allMatch && hasPlannedQty) {
    const cargoR = await query(
      `SELECT 1 FROM fbo_supply_cargo_units WHERE fbo_supply_id = $1 LIMIT 1`,
      [supplyId]
    );
    if (cargoR.rows?.length) {
      await query(
        `UPDATE fbo_supplies SET status = 'ready_for_supply', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [supplyId]
      );
      status = 'ready_for_supply';
      promoted = true;
    }
  } else if (
    (status === 'new' || status === 'collecting') &&
    packingIncomplete
  ) {
    const cargoR = await query(
      `SELECT 1 FROM fbo_supply_cargo_units WHERE fbo_supply_id = $1 LIMIT 1`,
      [supplyId]
    );
    if (cargoR.rows?.length) {
      await query(
        `UPDATE fbo_supplies SET status = 'packing', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [supplyId]
      );
      status = 'packing';
      promoted = true;
    }
  }

  return { allMatch, hasItems, status, reverted, promoted, discrepancies };
}

function assertPackingComplete(packingEval, statusLabel) {
  if (!packingEval.hasItems) {
    const err = new Error('В поставке нет строк товаров');
    err.statusCode = 400;
    throw err;
  }
  if (!packingEval.allMatch) {
    const err = new Error(
      `Нельзя перевести в «${statusLabel}»: есть расхождения между планом и сборкой. Упакуйте по каждой позиции ровно запланированное количество.`
    );
    err.statusCode = 400;
    err.code = 'FBO_PACKING_DISCREPANCY';
    err.details = packingEval.discrepancies;
    throw err;
  }
}

export function assertCanSetReadyForSupply(packingEval) {
  assertPackingComplete(packingEval, 'Готова к отгрузке');
}

/** @deprecated алиас для старых деплоев / импортов со статусом packed */
export function assertCanSetPackedStatus(packingEval) {
  assertPackingComplete(packingEval, 'Готова к отгрузке');
}

/** Обновить метку «сейчас упаковывают» (окно 5 мин на клиенте). */
export async function touchFboSupplyPackActivity(supplyId) {
  const sid = Number(supplyId);
  if (!Number.isFinite(sid) || sid < 1) return;
  await query(
    `UPDATE fbo_supplies
     SET last_pack_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [sid]
  );
}

/** Обновить метку «сейчас собирают». */
export async function touchFboSupplyCollectActivity(supplyId) {
  const sid = Number(supplyId);
  if (!Number.isFinite(sid) || sid < 1) return;
  await query(
    `UPDATE fbo_supplies
     SET last_collect_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [sid]
  );
}

export function assertPackingReadyForMarketplaceSubmit(packingEval) {
  if (!packingEval.hasItems) {
    const err = new Error('В поставке нет строк товаров');
    err.statusCode = 400;
    throw err;
  }
  if (!packingEval.allMatch) {
    const err = new Error(
      'Нельзя отправить состав на маркетплейс: есть расхождения между планом и сборкой. Упакуйте по каждой позиции ровно запланированное количество.'
    );
    err.statusCode = 400;
    err.code = 'FBO_PACKING_DISCREPANCY';
    err.details = packingEval.discrepancies;
    throw err;
  }
}
