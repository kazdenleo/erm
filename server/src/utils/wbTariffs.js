/**
 * Разбор ответа WB GET /api/v1/tariffs/box (разные обёртки response/data).
 */

export function extractWbWarehouseList(boxTariffsData) {
  if (boxTariffsData == null) return [];
  if (Array.isArray(boxTariffsData)) return boxTariffsData;

  if (typeof boxTariffsData !== 'object') return [];

  const paths = [
    boxTariffsData?.response?.data?.warehouseList,
    boxTariffsData?.response?.data?.warehouse_list,
    boxTariffsData?.response?.warehouseList,
    boxTariffsData?.data?.warehouseList,
    boxTariffsData?.data?.warehouse_list,
    boxTariffsData?.warehouseList,
    boxTariffsData?.warehouse_list,
  ];

  for (const list of paths) {
    if (Array.isArray(list) && list.length > 0) return list;
  }

  return [];
}

export function hasWbTariffsWarehouseList(boxTariffsData) {
  return extractWbWarehouseList(boxTariffsData).length > 0;
}

export function wbTariffWarehouseLabel(row) {
  return (row?.warehouseName ?? row?.geoName ?? '').toString().trim();
}

/** Поиск строки тарифа WB по имени склада или warehouseId (с учётом префикса «Маркетплейс:»). */
export function findWbTariffWarehouse(warehouseList, requestedName) {
  if (!requestedName || !Array.isArray(warehouseList) || !warehouseList.length) return null;
  const req = String(requestedName).trim();
  if (!req) return null;

  // Маппинг часто хранит numeric warehouseId WB, а не geoName из тарифов.
  const reqId = /^\d+$/.test(req) ? req : null;
  if (reqId) {
    const byId = warehouseList.find((w) => {
      const id = w?.warehouseId ?? w?.warehouse_id ?? w?.id ?? null;
      return id != null && String(id).trim() === reqId;
    });
    if (byId) return byId;
  }

  const normalizedName = req.replace(/^Маркетплейс:\s*/i, '').trim();
  return (
    warehouseList.find((w) => {
      const wName = wbTariffWarehouseLabel(w);
      return (
        wName === req ||
        wName === normalizedName ||
        wName.toLowerCase() === req.toLowerCase() ||
        wName.toLowerCase() === normalizedName.toLowerCase()
      );
    }) || null
  );
}
