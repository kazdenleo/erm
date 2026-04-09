/**
 * Import Supplier Stocks
 * РРјРїРѕСЂС‚ РѕСЃС‚Р°С‚РєРѕРІ РїРѕСЃС‚Р°РІС‰РёРєРѕРІ РёР· JSON РІ PostgreSQL
 */

import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

async function importSupplierStocks() {
  console.log('[Import] Starting supplier stocks import...');
  
  try {
    const stockCache = await readData('supplierStockCache');
    if (!stockCache || typeof stockCache !== 'object') {
      console.log('[Import] No supplier stock cache found');
      return;
    }
    
    let imported = 0;
    let updated = 0;
    let errors = 0;
    
    await transaction(async (client) => {
      // РџРѕР»СѓС‡Р°РµРј РјР°РїРїРёРЅРі supplier codes -> IDs
      const suppliersResult = await client.query('SELECT id, code FROM suppliers');
      const supplierMap = {};
      suppliersResult.rows.forEach(row => {
        supplierMap[row.code] = row.id;
      });
      
      // РС‚РµСЂРёСЂСѓРµРј РїРѕ РїРѕСЃС‚Р°РІС‰РёРєР°Рј
      for (const [supplierCode, products] of Object.entries(stockCache)) {
        const supplierId = supplierMap[supplierCode];
        if (!supplierId) {
          console.log(`[Import] Supplier "${supplierCode}" not found, skipping...`);
          continue;
        }
        
        // РС‚РµСЂРёСЂСѓРµРј РїРѕ С‚РѕРІР°СЂР°Рј РїРѕСЃС‚Р°РІС‰РёРєР°
        for (const [sku, stockData] of Object.entries(products)) {
          try {
            // РќР°С…РѕРґРёРј product_id РїРѕ SKU
            const productResult = await client.query(
              'SELECT id FROM products WHERE sku = $1',
              [sku]
            );
            
            if (productResult.rows.length === 0) {
              // РўРѕРІР°СЂ РЅРµ РЅР°Р№РґРµРЅ, РїСЂРѕРїСѓСЃРєР°РµРј
              continue;
            }
            
            const productId = productResult.rows[0].id;
            
            // РџСЂРѕРІРµСЂСЏРµРј СЃСѓС‰РµСЃС‚РІРѕРІР°РЅРёРµ
            const existing = await client.query(
              'SELECT id FROM supplier_stocks WHERE supplier_id = $1 AND product_id = $2',
              [supplierId, productId]
            );
            
            const stockRecord = {
              stock: stockData.stock || 0,
              price: stockData.price ? parseFloat(stockData.price) : null,
              delivery_days: stockData.deliveryDays !== undefined ? parseInt(stockData.deliveryDays) : 0,
              stock_name: stockData.stockName || null,
              source: stockData.source || 'cache',
              warehouses: stockData.warehouses ? JSON.stringify(stockData.warehouses) : null,
              cached_at: new Date()
            };
            
            if (existing.rows.length > 0) {
              // РћР±РЅРѕРІР»СЏРµРј СЃСѓС‰РµСЃС‚РІСѓСЋС‰СѓСЋ Р·Р°РїРёСЃСЊ
              await client.query(`
                UPDATE supplier_stocks SET
                  stock = $3,
                  price = $4,
                  delivery_days = $5,
                  stock_name = $6,
                  source = $7,
                  warehouses = $8,
                  cached_at = $9,
                  updated_at = CURRENT_TIMESTAMP
                WHERE supplier_id = $1 AND product_id = $2
              `, [
                supplierId,
                productId,
                stockRecord.stock,
                stockRecord.price,
                stockRecord.delivery_days,
                stockRecord.stock_name,
                stockRecord.source,
                stockRecord.warehouses,
                stockRecord.cached_at
              ]);
              updated++;
            } else {
              // Р’СЃС‚Р°РІР»СЏРµРј РЅРѕРІСѓСЋ Р·Р°РїРёСЃСЊ
              await client.query(`
                INSERT INTO supplier_stocks (
                  supplier_id, product_id, stock, price, delivery_days,
                  stock_name, source, warehouses, cached_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              `, [
                supplierId,
                productId,
                stockRecord.stock,
                stockRecord.price,
                stockRecord.delivery_days,
                stockRecord.stock_name,
                stockRecord.source,
                stockRecord.warehouses,
                stockRecord.cached_at
              ]);
              imported++;
            }
          } catch (error) {
            console.error(`[Import] Error importing stock for ${supplierCode}:${sku}:`, error.message);
            errors++;
          }
        }
      }
    });
    
    console.log(`[Import] Supplier stocks import completed: ${imported} imported, ${updated} updated, ${errors} errors`);
  } catch (error) {
    console.error('[Import] Supplier stocks import failed:', error);
    throw error;
  }
}

// Р—Р°РїСѓСЃРє РёРјРїРѕСЂС‚Р°
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('09_import_supplier_stocks.js'))) {
  importSupplierStocks()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importSupplierStocks;

