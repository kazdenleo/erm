/**
 * Подсказка склада поставщика для нашего склада (города).
 */

import { query } from '../config/database.js';
import { warehouseNamesSameCity } from './supplierProcurementArrival.js';

export { warehouseNamesSameCity };

/**
 * Имя склада поставщика (Москва / СПБ / …) для нашего основного склада.
 * Берём привязанный warehouses.type=supplier.
 */
export async function resolveSupplierWarehouseNameForMainWarehouse(
  mainWarehouseId,
  supplierId,
  { profileId = null } = {}
) {
  const wid = Number(mainWarehouseId);
  const sid = Number(supplierId);
  if (!Number.isFinite(wid) || wid < 1 || !Number.isFinite(sid) || sid < 1) return null;

  const params = [sid, wid];
  let profileSql = '';
  if (profileId != null && String(profileId).trim() !== '') {
    params.push(profileId);
    profileSql = ` AND (w.profile_id = $${params.length} OR w.profile_id IS NULL)`;
  }

  const r = await query(
    `SELECT w.name, w.address
       FROM warehouses w
      WHERE w.type = 'supplier'
        AND w.supplier_id = $1
        AND (
          w.main_warehouse_id = $2
          OR EXISTS (
            SELECT 1 FROM supplier_warehouse_main_links l
             WHERE l.supplier_warehouse_id = w.id AND l.main_warehouse_id = $2
          )
        )
        ${profileSql}
      ORDER BY w.id ASC
      LIMIT 1`,
    params
  );
  const row = r.rows?.[0];
  if (!row) return null;
  const name = String(row.name || '').trim();
  if (name) return name;
  const addr = String(row.address || '').trim();
  return addr || null;
}
