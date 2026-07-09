/**
 * Обязательные поля для документов движения товара (организация, поставщик, склад).
 */

import { query } from '../config/database.js';

export function requirePositiveEntityId(value, message) {
  const n = value === '' || value == null ? NaN : Number(value);
  if (!Number.isFinite(n) || n < 1) {
    const err = new Error(message);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

/**
 * @param {'receipt'|'return'|'customer_return'} documentType
 */
export function requireWarehouseDocumentScope({
  documentType = 'receipt',
  organizationId,
  supplierId,
  warehouseId,
}) {
  const whId = requirePositiveEntityId(warehouseId, 'Выберите склад');
  const orgId = requirePositiveEntityId(organizationId, 'Выберите организацию');
  const doc = String(documentType || 'receipt').trim().toLowerCase();
  let supplier = null;
  if (doc !== 'customer_return') {
    supplier = requirePositiveEntityId(supplierId, 'Выберите поставщика');
  }
  return { warehouseId: whId, organizationId: orgId, supplierId: supplier };
}

/**
 * Склад должен принадлежать выбранной организации.
 */
export async function assertWarehouseBelongsToOrganization(warehouseId, organizationId) {
  const whId = requirePositiveEntityId(warehouseId, 'Выберите склад');
  const orgId = requirePositiveEntityId(organizationId, 'Выберите организацию');
  const result = await query(
    `SELECT organization_id FROM warehouses WHERE id = $1`,
    [whId]
  );
  const whOrg = result.rows?.[0]?.organization_id;
  if (whOrg == null || Number(whOrg) !== Number(orgId)) {
    const err = new Error('Склад не принадлежит выбранной организации');
    err.statusCode = 400;
    throw err;
  }
  return { warehouseId: whId, organizationId: orgId };
}
