/**
 * Обязательные поля для документов движения товара (организация, поставщик, склад).
 */

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
