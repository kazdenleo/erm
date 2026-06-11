/**
 * Настройки FBO на уровне профиля (склад списания по умолчанию).
 */

import { query } from '../config/database.js';

export async function getProfileFboSettings(profileId) {
  const pid = profileId != null ? Number(profileId) : null;
  if (!Number.isFinite(pid) || pid <= 0) {
    return { fboEnabled: false, fboDeductionWarehouseId: null };
  }
  const r = await query(
    `SELECT fbo_enabled, fbo_deduction_warehouse_id
     FROM profiles
     WHERE id = $1`,
    [pid]
  );
  const row = r.rows?.[0];
  if (!row) {
    return { fboEnabled: false, fboDeductionWarehouseId: null };
  }
  return {
    fboEnabled: row.fbo_enabled === true,
    fboDeductionWarehouseId:
      row.fbo_deduction_warehouse_id != null ? Number(row.fbo_deduction_warehouse_id) : null,
  };
}

/** Склад списания для новой поставки FBO, если в профиле включён режим FBO. */
export async function resolveDefaultFboDeductionWarehouseId(profileId) {
  const { fboEnabled, fboDeductionWarehouseId } = await getProfileFboSettings(profileId);
  if (!fboEnabled || !fboDeductionWarehouseId) return null;
  return fboDeductionWarehouseId;
}
