/**
 * Склады для списания остатков (как в «Складские операции» — не поставщик, без supplier_id).
 */

export function extractWarehousesFromApiResponse(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

export function isDeductionWarehouse(w) {
  if (!w) return false;
  if (String(w.type || '').toLowerCase() === 'supplier') return false;
  const sid = w.supplierId ?? w.supplier_id;
  if (sid != null && sid !== '' && Number(sid) !== 0) return false;
  return true;
}

export function filterDeductionWarehouses(warehouses, selectedWarehouseId = null) {
  const all = Array.isArray(warehouses) ? warehouses : [];
  let list = all.filter(isDeductionWarehouse);
  if (!list.length) {
    list = all.filter((w) => String(w?.type || '').toLowerCase() !== 'supplier');
  }
  if (!list.length) list = all;
  if (selectedWarehouseId == null || selectedWarehouseId === '') return list;
  const sid = String(selectedWarehouseId);
  if (list.some((w) => String(w.id) === sid)) return list;
  const extra = all.find((w) => String(w.id) === sid);
  return extra ? [extra, ...list] : list;
}

export function warehouseSelectLabel(w) {
  if (!w) return '—';
  if (String(w.type || '').toLowerCase() === 'warehouse' && w.wbWarehouseName) {
    return w.wbWarehouseName;
  }
  return w.address || w.name || `Склад #${w.id}`;
}
