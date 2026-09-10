/**
 * Числовой ID склада маркетплейса из значения привязки.
 * "1020001624191000" или "1326703 — Теплый стан" → "1326703".
 * Название без ID ("Свой склад РФ") → null.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseMarketplaceWarehouseId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/^(\d{1,20})/);
  return m ? m[1] : null;
}

/**
 * Ключ склада МП для группировки поставок: числовой ID или нормализованное название.
 * "1818583 — Киров" → "1818583"; "Москва" → "москва".
 */
export function shipmentMarketplaceWarehouseKey(raw) {
  const id = parseMarketplaceWarehouseId(raw);
  if (id) return id;
  return String(raw ?? '').trim().toLowerCase();
}

/** Подпись склада из «id — название» или исходная строка. */
export function marketplaceWarehouseLabel(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const m = s.match(/^\d{1,20}\s*[—–-]\s*(.+)$/);
  if (m) return m[1].trim();
  return s;
}

/**
 * Можно ли класть заказ с этим складом МП в открытую поставку.
 * Поставка без marketplaceWarehouseId (старые GI) — только заказы без числового ID склада МП.
 */
export function shipmentsMatchMarketplaceWarehouse(ship, marketplaceWarehouseRaw) {
  const rawShip = ship?.marketplaceWarehouseId ?? ship?.marketplace_warehouse_id;
  const shipHasExplicit = rawShip != null && String(rawShip).trim() !== '';
  if (!shipHasExplicit) {
    return parseMarketplaceWarehouseId(marketplaceWarehouseRaw) == null;
  }
  return shipmentMarketplaceWarehouseKey(rawShip) === shipmentMarketplaceWarehouseKey(marketplaceWarehouseRaw);
}

/**
 * Сопоставить привязку склада МП по числовому ID (не по названию).
 * @param {Array<{ marketplace_warehouse_id?: unknown, marketplaceWarehouseId?: unknown, warehouse_id?: unknown, warehouseId?: unknown }>} rows
 * @param {unknown} marketplaceWarehouseId
 * @returns {number|string|null}
 */
export function matchOwnWarehouseIdByMarketplaceWarehouseId(rows, marketplaceWarehouseId) {
  const incomingId = parseMarketplaceWarehouseId(marketplaceWarehouseId);
  if (!incomingId) return null;
  for (const row of rows || []) {
    const storedId = parseMarketplaceWarehouseId(
      row?.marketplace_warehouse_id ?? row?.marketplaceWarehouseId
    );
    if (storedId && storedId === incomingId) {
      return row.warehouse_id ?? row.warehouseId ?? null;
    }
  }
  return null;
}
