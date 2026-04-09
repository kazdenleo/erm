/**
 * Import Warehouse Mappings
 * Импорт маппингов складов из JSON в PostgreSQL
 */

import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

async function importWarehouseMappings() {
  console.log('[Import] Starting warehouse mappings import...');
  
  try {
    const warehouseMappings = await readData('warehouse_mappings');
    
    if (!warehouseMappings || typeof warehouseMappings !== 'object') {
      console.log('[Import] No warehouse mappings found or invalid format');
      return;
    }
    
    let imported = 0;
    let updated = 0;
    let errors = 0;
    
    await transaction(async (client) => {
      for (const [key, mapping] of Object.entries(warehouseMappings)) {
        try {
          // Парсим ключ: "stock_warehouseId" (например: "stock_1760885229837")
          let warehouseId = null;
          
          if (key.startsWith('stock_')) {
            warehouseId = key.replace('stock_', '');
          } else {
            warehouseId = key;
          }
          
          // Проверяем существование склада по ID из JSON (может быть строка "stock_1760885229837")
          // Сначала пробуем найти по полному ID
          let warehouseResult = await client.query(
            'SELECT id FROM warehouses WHERE id::text = $1',
            [warehouseId]
          );
          
          // Если не нашли, пробуем найти по ID без префикса "stock_"
          if (warehouseResult.rows.length === 0 && warehouseId.startsWith('stock_')) {
            const cleanId = warehouseId.replace('stock_', '');
            warehouseResult = await client.query(
              'SELECT id FROM warehouses WHERE id::text = $1',
              [cleanId]
            );
          }
          
          // Если все еще не нашли, ищем в исходном файле warehouses.json
          if (warehouseResult.rows.length === 0) {
            const { readData: readDataUtil } = await import('../../src/utils/storage.js');
            const warehousesJson = await readDataUtil('warehouses');
            const warehouseJson = Array.isArray(warehousesJson) 
              ? warehousesJson.find(w => String(w.id) === warehouseId || String(w.id) === key)
              : null;
            
            if (warehouseJson) {
              // Ищем склад в БД по адресу или типу
              warehouseResult = await client.query(
                'SELECT id FROM warehouses WHERE address = $1 AND type = $2 LIMIT 1',
                [warehouseJson.address || '', warehouseJson.type || '']
              );
            }
          }
          
          if (warehouseResult.rows.length === 0) {
            console.log(`[Import] Warehouse not found for key: ${key} (warehouseId: ${warehouseId})`);
            errors++;
            continue;
          }
          
          const warehouseDbId = warehouseResult.rows[0].id;
          let marketplaceWarehouseId = mapping.wbWarehouseId || mapping.marketplace_warehouse_id || null;
          
          // Обрабатываем "undefined" как null
          if (marketplaceWarehouseId === 'undefined' || marketplaceWarehouseId === undefined) {
            marketplaceWarehouseId = null;
          }
          
          // В БД используются: ozon, wb, ym
          const marketplace = mapping.marketplace === 'wildberries' ? 'wb' : 
                             mapping.marketplace === 'yandex' ? 'ym' : 
                             mapping.marketplace || 'wb'; // По умолчанию WB
          
          // Пропускаем, если нет marketplace_warehouse_id
          if (!marketplaceWarehouseId) {
            console.log(`[Import] Skipping warehouse mapping "${key}" - no marketplace_warehouse_id`);
            continue;
          }
          
          // Проверяем существование маппинга
          const existing = await client.query(
            'SELECT id FROM warehouse_mappings WHERE warehouse_id = $1 AND marketplace = $2',
            [warehouseDbId, marketplace]
          );
          
          if (existing.rows.length > 0) {
            // Обновляем существующий
            await client.query(`
              UPDATE warehouse_mappings SET
                marketplace_warehouse_id = $3,
                updated_at = CURRENT_TIMESTAMP
              WHERE warehouse_id = $1 AND marketplace = $2
            `, [warehouseDbId, marketplace, marketplaceWarehouseId]);
            updated++;
          } else {
            // Вставляем новый
            await client.query(`
              INSERT INTO warehouse_mappings (warehouse_id, marketplace, marketplace_warehouse_id)
              VALUES ($1, $2, $3)
            `, [warehouseDbId, marketplace, marketplaceWarehouseId]);
            imported++;
          }
        } catch (error) {
          console.error(`[Import] Error importing warehouse mapping "${key}":`, error.message);
          errors++;
        }
      }
    });
    
    console.log(`[Import] Warehouse mappings import completed: ${imported} imported, ${updated} updated, ${errors} errors`);
  } catch (error) {
    console.error('[Import] Warehouse mappings import failed:', error);
    throw error;
  }
}

// Запуск импорта
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('13_import_warehouse_mappings.js'))) {
  importWarehouseMappings()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importWarehouseMappings;

