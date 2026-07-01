import { useMemo } from 'react';

/** Склады назначения для закупок и приёмок (не склады поставщиков). */
export function stockDestinationWarehouses(warehouses) {
  return (warehouses || []).filter(
    (w) =>
      w &&
      String(w.type || '').toLowerCase() === 'warehouse' &&
      !w.supplierId &&
      !w.supplier_id
  );
}

/** Собственные склады для операций на складе (поступление, возврат, списание). */
export function ownStockWarehouses(warehouses) {
  return (warehouses || []).filter(
    (w) => w && String(w.type || '').toLowerCase() !== 'supplier' && !w.supplierId && !w.supplier_id
  );
}

export function warehouseDisplayLabel(w, fallbackId = null) {
  if (!w) {
    return fallbackId != null && fallbackId !== '' ? `Склад #${fallbackId}` : '—';
  }
  return w.name || w.address || w.city || `Склад #${w.id}`;
}

export function pickSingleEntityId(entities) {
  const list = (entities || []).filter(Boolean);
  if (list.length !== 1) return '';
  const id = list[0]?.id;
  return id != null && id !== '' ? String(id) : '';
}

export function useStockDestinationDefaults(organizations, warehouses, { ownOnly = false } = {}) {
  return useMemo(() => {
    const destWarehouses = ownOnly
      ? ownStockWarehouses(warehouses)
      : stockDestinationWarehouses(warehouses);
    return {
      destWarehouses,
      singleOrganizationId: pickSingleEntityId(organizations),
      singleWarehouseId: pickSingleEntityId(destWarehouses),
    };
  }, [organizations, warehouses, ownOnly]);
}

/** Подставить единственную организацию/склад, если поля ещё пустые. */
export function applySingleOrgWarehouseDefaults({
  singleOrganizationId,
  singleWarehouseId,
  organizationId = '',
  warehouseId = '',
  setOrganizationId,
  setWarehouseId,
}) {
  if (typeof setOrganizationId === 'function' && !String(organizationId || '').trim() && singleOrganizationId) {
    setOrganizationId(singleOrganizationId);
  }
  if (typeof setWarehouseId === 'function' && !String(warehouseId || '').trim() && singleWarehouseId) {
    setWarehouseId(singleWarehouseId);
  }
}
