/**
 * Загрузка календаря склада для закупок.
 */

import { query } from '../config/database.js';
import { normalizeWeekendDays } from './warehouseWorkingCalendar.js';

/**
 * @param {number|string|null} warehouseId
 * @param {number|string|null} profileId
 * @returns {Promise<number[]>}
 */
export async function loadWarehouseWeekendDays(warehouseId, profileId) {
  const wid = warehouseId != null ? Number(warehouseId) : null;
  const pid = profileId != null ? Number(profileId) : null;
  if (!Number.isFinite(wid) || wid < 1 || !Number.isFinite(pid) || pid < 1) {
    return [];
  }
  const r = await query(
    `SELECT weekend_days FROM warehouses WHERE id = $1 AND profile_id = $2 LIMIT 1`,
    [wid, pid]
  );
  return normalizeWeekendDays(r.rows?.[0]?.weekend_days);
}
