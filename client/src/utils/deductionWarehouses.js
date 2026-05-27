/**
 * Склады для списания остатков (как в «Складские операции» — не поставщик, без supplier_id).
 */

export function extractWarehousesFromApiResponse(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

/** Склад списания — только type=warehouse без привязки к поставщику (как в закупках). */
export function isDeductionWarehouse(w) {
  if (!w) return false;
  if (String(w.type || '').toLowerCase() !== 'warehouse') return false;
  const sid = w.supplierId ?? w.supplier_id;
  if (sid != null && sid !== '' && Number(sid) !== 0) return false;
  return true;
}

export function filterDeductionWarehouses(warehouses, selectedWarehouseId = null) {
  const all = Array.isArray(warehouses) ? warehouses : [];
  const list = all.filter(isDeductionWarehouse);
  if (selectedWarehouseId == null || selectedWarehouseId === '') return list;
  const sid = String(selectedWarehouseId);
  if (list.some((w) => String(w.id) === sid)) return list;
  const extra = all.find((w) => String(w.id) === sid);
  return extra ? [extra, ...list] : list;
}

export function warehouseSelectLabel(w) {
  if (!w) return '—';
  const wb = w.wbWarehouseName ?? w.wb_warehouse_name;
  if (wb && String(wb).trim()) return String(wb).trim();
  const addr = w.address && String(w.address).trim();
  if (addr) return addr;
  return w.name || `Склад #${w.id}`;
}
