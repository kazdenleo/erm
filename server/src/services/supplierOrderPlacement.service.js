/**
 * Отправка закупки поставщику через внешний API (Mikado / Moskvorechie).
 * Пока — заглушка для тестовой кнопки «Заказать»; реальные вызовы API подключим отдельно.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';

export async function trySubmitPurchaseToSupplier({ purchaseId, supplierId, profileId } = {}) {
  const pid = purchaseId != null ? Number(purchaseId) : null;
  const sid = supplierId != null ? Number(supplierId) : null;
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(sid) || sid < 1) {
    return {
      submitted: false,
      reason: 'invalid_args',
      message: 'Не указана закупка или поставщик',
    };
  }

  const sup = await query(`SELECT id, name, code FROM suppliers WHERE id = $1 LIMIT 1`, [sid]);
  const supplier = sup.rows?.[0];
  if (!supplier) {
    return { submitted: false, reason: 'supplier_not_found', message: 'Поставщик не найден' };
  }

  const items = await query(
    `SELECT pi.product_id, pi.expected_quantity, p.sku, p.brand, p.name
     FROM purchase_items pi
     INNER JOIN purchases pu ON pu.id = pi.purchase_id
     INNER JOIN products p ON p.id = pi.product_id
     WHERE pi.purchase_id = $1
       AND ($2::bigint IS NULL OR pu.profile_id = $2::bigint)`,
    [pid, profileId != null ? Number(profileId) : null]
  );

  logger.info('[SupplierOrderPlacement] test submit (API pending)', {
    purchaseId: pid,
    supplierId: sid,
    supplierCode: supplier.code,
    lines: (items.rows || []).length,
    profileId,
  });

  return {
    submitted: false,
    reason: 'supplier_api_pending',
    message:
      'Закупка создана в ERM; вызов API поставщика будет подключён на следующем этапе автоматизации',
    supplierName: supplier.name,
    supplierCode: supplier.code,
    lineCount: items.rows?.length ?? 0,
  };
}

export default { trySubmitPurchaseToSupplier };
