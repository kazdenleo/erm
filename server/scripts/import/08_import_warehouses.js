/**
 * Import Warehouses
 * РРјРїРѕСЂС‚ СЃРєР»Р°РґРѕРІ РёР· JSON РІ PostgreSQL
 */

import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

async function importWarehouses() {
  console.log('[Import] Starting warehouses import...');
  
  try {
    const warehouses = await readData('warehouses');
    if (!Array.isArray(warehouses) || warehouses.length === 0) {
      console.log('[Import] No warehouses found');
      return;
    }
    
    console.log(`[Import] Found ${warehouses.length} warehouses`);
    
    let imported = 0;
    let updated = 0;
    let errors = 0;
    
    await transaction(async (client) => {
      for (const warehouse of warehouses) {
        try {
          // РџРѕР»СѓС‡Р°РµРј supplier_id РµСЃР»Рё РµСЃС‚СЊ
          let supplierId = null;
          if (warehouse.supplierId) {
            const supplierResult = await client.query(
              'SELECT id FROM suppliers WHERE code = $1',
              [warehouse.supplierId]
            );
            if (supplierResult.rows.length > 0) {
              supplierId = supplierResult.rows[0].id;
            }
          }
          
          // РџРѕР»СѓС‡Р°РµРј main_warehouse_id РµСЃР»Рё РµСЃС‚СЊ
          let mainWarehouseId = null;
          if (warehouse.mainWarehouseId) {
            // РС‰РµРј РїРѕ СЃС‚Р°СЂРѕРјСѓ ID РёР»Рё СЃРѕР·РґР°РµРј РјР°РїРїРёРЅРі
            const mainWarehouseResult = await client.query(
              'SELECT id FROM warehouses WHERE id::text = $1 OR id::text = $2 LIMIT 1',
              [String(warehouse.mainWarehouseId), warehouse.mainWarehouseId]
            );
            if (mainWarehouseResult.rows.length > 0) {
              mainWarehouseId = mainWarehouseResult.rows[0].id;
            }
          }
          
          // РСЃРїРѕР»СЊР·СѓРµРј СЃС‚Р°СЂС‹Р№ ID РµСЃР»Рё СЌС‚Рѕ С‡РёСЃР»Рѕ, РёРЅР°С‡Рµ РіРµРЅРµСЂРёСЂСѓРµРј РЅРѕРІС‹Р№
          let warehouseId = null;
          if (warehouse.id && !isNaN(warehouse.id)) {
            warehouseId = parseInt(warehouse.id);
          }
          
          // РџСЂРѕРІРµСЂСЏРµРј СЃСѓС‰РµСЃС‚РІРѕРІР°РЅРёРµ
          const existing = warehouseId ? await client.query(
            'SELECT id FROM warehouses WHERE id = $1',
            [warehouseId]
          ) : { rows: [] };
          
          const warehouseData = {
            type: warehouse.type || 'warehouse',
            address: warehouse.address || null,
            supplier_id: supplierId,
            main_warehouse_id: mainWarehouseId,
            created_at: warehouse.createdAt ? new Date(warehouse.createdAt) : new Date(),
            updated_at: warehouse.updatedAt ? new Date(warehouse.updatedAt) : new Date()
          };
          
          if (existing.rows.length > 0 && warehouseId) {
            // РћР±РЅРѕРІР»СЏРµРј СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ СЃРєР»Р°Рґ
            await client.query(`
              UPDATE warehouses SET
                type = $2,
                address = $3,
                supplier_id = $4,
                main_warehouse_id = $5,
                updated_at = $6
              WHERE id = $1
            `, [
              warehouseId,
              warehouseData.type,
              warehouseData.address,
              warehouseData.supplier_id,
              warehouseData.main_warehouse_id,
              warehouseData.updated_at
            ]);
            updated++;
          } else {
            // Р’СЃС‚Р°РІР»СЏРµРј РЅРѕРІС‹Р№ СЃРєР»Р°Рґ
            const insertQuery = warehouseId 
              ? `INSERT INTO warehouses (id, type, address, supplier_id, main_warehouse_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`
              : `INSERT INTO warehouses (type, address, supplier_id, main_warehouse_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
            
            const params = warehouseId
              ? [warehouseId, warehouseData.type, warehouseData.address, warehouseData.supplier_id, warehouseData.main_warehouse_id, warehouseData.created_at, warehouseData.updated_at]
              : [warehouseData.type, warehouseData.address, warehouseData.supplier_id, warehouseData.main_warehouse_id, warehouseData.created_at, warehouseData.updated_at];
            
            await client.query(insertQuery, params);
            imported++;
          }
        } catch (error) {
          console.error(`[Import] Error importing warehouse ${warehouse.id}:`, error.message);
          errors++;
        }
      }
    });
    
    console.log(`[Import] Warehouses import completed: ${imported} imported, ${updated} updated, ${errors} errors`);
  } catch (error) {
    console.error('[Import] Warehouses import failed:', error);
    throw error;
  }
}

// Р—Р°РїСѓСЃРє РёРјРїРѕСЂС‚Р°
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('08_import_warehouses.js'))) {
  importWarehouses()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importWarehouses;

