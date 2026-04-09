/** Вкладки операций склада (совпадают с режимами WarehouseOperations) */
export const WAREHOUSE_OPERATION_OPS = [
  { op: 'table', label: '📊 Таблица остатков', to: '/stock-levels/warehouse' },
  { op: 'receipts_list', label: '📑 Приёмки', to: '/stock-levels/warehouse?op=receipts_list' },
  { op: 'writeoff', label: '📤 Списание', to: '/stock-levels/warehouse?op=writeoff' },
  { op: 'return_supplier', label: '↩️ Возврат поставщику', to: '/stock-levels/warehouse?op=return_supplier' },
  { op: 'return_customer', label: '📥 Возврат от клиентов', to: '/stock-levels/warehouse?op=return_customer' },
  { op: 'inventory', label: '📋 Инвентаризация', to: '/stock-levels/warehouse?op=inventory' },
];

export const WAREHOUSE_VALID_OPS = new Set(WAREHOUSE_OPERATION_OPS.map((t) => t.op));

/** Текущий режим из query ?op= */
export function warehouseOpFromSearch(searchParams) {
  const raw = (searchParams.get('op') || '').trim().toLowerCase();
  if (!raw || raw === 'table') return 'table';
  return WAREHOUSE_VALID_OPS.has(raw) ? raw : 'table';
}
