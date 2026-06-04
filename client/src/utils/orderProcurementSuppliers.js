/** Поставщики из открытых закупок для заказа «В закупке». */

export function getOrderProcurementSuppliers(order) {
  const raw = order?.procurementSuppliers ?? order?.procurement_suppliers;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .map((s) => ({
        supplierName: String(s.supplierName ?? s.supplier_name ?? '').trim(),
        supplierId: s.supplierId ?? s.supplier_id ?? null,
        purchaseId: s.purchaseId ?? s.purchase_id ?? null,
        quantity:
          s.quantity != null && Number.isFinite(Number(s.quantity)) && Number(s.quantity) > 0
            ? Number(s.quantity)
            : null,
      }))
      .filter((s) => s.supplierName);
  }
  const legacy = order?.procurementSupplierName ?? order?.procurement_supplier_name;
  if (legacy != null && String(legacy).trim() !== '') {
    return [
      {
        supplierName: String(legacy).trim(),
        supplierId: order?.procurementSupplierId ?? order?.procurement_supplier_id ?? null,
        purchaseId: order?.procurementPurchaseId ?? order?.procurement_purchase_id ?? null,
        quantity: null,
      },
    ];
  }
  return [];
}

/** Объединить поставщиков по нескольким строкам заказа (группа WB и т.д.). */
export function aggregateProcurementSuppliersFromOrders(orderRows) {
  const byKey = new Map();
  for (const o of orderRows || []) {
    for (const s of getOrderProcurementSuppliers(o)) {
      const k = `${s.supplierId ?? ''}|${s.purchaseId ?? ''}|${s.supplierName}`;
      const cur = byKey.get(k);
      if (!cur) {
        byKey.set(k, { ...s });
        continue;
      }
      if (s.quantity != null) {
        cur.quantity = (cur.quantity ?? 0) + s.quantity;
      }
    }
  }
  return [...byKey.values()];
}

export function formatProcurementSupplierEntry(s) {
  const name = s?.supplierName || '—';
  const q = s?.quantity;
  if (q != null && Number.isFinite(q) && q > 0) {
    return `${name} (${q} шт.)`;
  }
  return name;
}

export function formatProcurementSuppliersLabel(suppliers) {
  const list = Array.isArray(suppliers) ? suppliers : [];
  if (!list.length) return '';
  return list.map(formatProcurementSupplierEntry).join('; ');
}

/** Одна строка для ячейки заказа (все поставщики из закупки). */
export function getOrderProcurementSupplierName(order) {
  return formatProcurementSuppliersLabel(getOrderProcurementSuppliers(order));
}

export function procurementSuppliersTitle(suppliers) {
  const list = Array.isArray(suppliers) ? suppliers : [];
  if (!list.length) return '';
  return list
    .map((s) => {
      const pid = s.purchaseId != null ? `закупка №${s.purchaseId}` : 'закупка';
      const q =
        s.quantity != null && s.quantity > 0 ? `, ${s.quantity} шт. в ожидании` : '';
      return `${s.supplierName} (${pid}${q})`;
    })
    .join('\n');
}
