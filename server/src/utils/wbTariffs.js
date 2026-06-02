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
