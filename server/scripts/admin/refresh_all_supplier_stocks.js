/**
 * Массовое обновление остатков поставщиков в supplier_stocks (все товары).
 * Usage: node scripts/admin/refresh_all_supplier_stocks.js
 */
import productsService from '../../src/services/products.service.js';
import { closePool } from '../../src/config/database.js';

async function main() {
  console.log('[refresh_all_supplier_stocks] Starting full supplier stocks refresh…');
  const result = await productsService.refreshSupplierStocks(null);
  console.log('[refresh_all_supplier_stocks] Done:', result);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
