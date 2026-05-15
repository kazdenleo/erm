/**
 * Refresh supplier stocks for one SKU (usage: node scripts/admin/refresh_supplier_stock_sku.js E500108)
 */
import supplierStocksService from '../../src/services/supplierStocks.service.js';
import supplierStocksPgService from '../../src/services/supplier_stocks.service.js';
import { query, closePool } from '../../src/config/database.js';

const sku = process.argv[2] || 'E500108';

async function main() {
  for (const supplier of ['mikado', 'moskvorechie']) {
    try {
      const data = await supplierStocksService.getSupplierStock({
        supplier,
        sku
      });
      console.log(`${supplier} API:`, data);
      if (data && (data.stock != null || data.price != null)) {
        await supplierStocksPgService.upsert(supplier, sku, {
          stock: data.stock ?? 0,
          price: data.price ?? null,
          deliveryDays: data.deliveryDays ?? data.delivery_days ?? 0,
          stockName: data.stockName ?? data.stock_name ?? null,
          source: 'api',
          cached_at: new Date()
        });
        console.log(`${supplier} upsert OK`);
      }
    } catch (e) {
      console.error(`${supplier} failed:`, e.message);
    }
  }

  const prod = await query('SELECT id FROM products WHERE sku = $1', [sku]);
  const pid = prod.rows[0]?.id;
  const rows = await query(
    `SELECT ss.stock, s.code, ss.cached_at
     FROM supplier_stocks ss
     JOIN suppliers s ON ss.supplier_id = s.id
     WHERE ss.product_id = $1
     ORDER BY s.code`,
    [pid]
  );
  console.log('\nDB supplier_stocks:', rows.rows);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
