import { query, closePool } from '../../src/config/database.js';
import {
  sumPurchasableSupplierWarehouseStock,
  warehouseNamesSameCity,
} from '../../src/utils/supplierProcurementArrival.js';
import { resolveSupplierWarehouseNameForMainWarehouse } from '../../src/utils/citySupplierWarehouse.js';

async function main() {
  const wh = await query(
    `SELECT id, name, type, supplier_id, main_warehouse_id, address, profile_id
     FROM warehouses
     WHERE type = 'supplier' OR id IN (1,4)
     ORDER BY type, id`
  );
  console.log('warehouses');
  for (const r of wh.rows) console.log(JSON.stringify(r));

  const links = await query(`SELECT * FROM supplier_warehouse_main_links LIMIT 50`).catch(
    () => ({ rows: [] })
  );
  console.log('links', links.rows);

  for (const mainId of [1, 4]) {
    for (const sid of [1, 2, 3]) {
      const hint = await resolveSupplierWarehouseNameForMainWarehouse(mainId, sid, {
        profileId: 1,
      });
      console.log({ mainId, sid, hint });
    }
  }

  const stocks = await query(
    `SELECT ss.product_id, p.sku, ss.supplier_id, s.name, ss.stock, ss.warehouses,
            s.api_config->'warehouses' AS cfg_wh
     FROM supplier_stocks ss
     JOIN products p ON p.id = ss.product_id
     JOIN suppliers s ON s.id = ss.supplier_id
     WHERE p.sku IN ('CN1070K','AN1031') AND ss.supplier_id = 1`
  );
  for (const r of stocks.rows) {
    console.log('\nsku', r.sku, 'agg', r.stock);
    console.log('stock wh', JSON.stringify(r.warehouses)?.slice(0, 500));
    console.log('cfg wh', JSON.stringify(r.cfg_wh)?.slice(0, 500));
    for (const hint of ['Микадо', 'Москва', 'Москва2', 'Киров', null]) {
      const p = sumPurchasableSupplierWarehouseStock({
        apiConfig: { warehouses: r.cfg_wh },
        stockWarehouses: r.warehouses,
        aggregatedStock: r.stock,
        warehouseNameHint: hint,
      });
      console.log('  hint', hint, '→', p, 'sameCity Микадо/Москва', warehouseNamesSameCity('Микадо', 'Москва'));
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
