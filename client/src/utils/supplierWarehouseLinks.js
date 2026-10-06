/** Наши склады, к которым привязан склад поставщика (mainWarehouseIds или старое mainWarehouseId). */
export function supplierWarehouseMainIds(w) {
  if (!w) return [];
  const list = Array.isArray(w.mainWarehouseIds)
    ? w.mainWarehouseIds
    : Array.isArray(w.main_warehouse_ids)
      ? w.main_warehouse_ids
      : [];
  const ids = list.map((v) => String(v).trim()).filter(Boolean);
  const single = w.mainWarehouseId ?? w.main_warehouse_id;
  if (ids.length === 0 && single != null && String(single).trim() !== '') {
    ids.push(String(single).trim());
  }
  return [...new Set(ids)];
}

export function isSupplierWarehouseLinkedTo(w, mainWarehouseId) {
  if (mainWarehouseId == null || String(mainWarehouseId).trim() === '') return false;
  return supplierWarehouseMainIds(w).includes(String(mainWarehouseId).trim());
}
