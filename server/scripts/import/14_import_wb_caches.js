/**
 * Import WB Caches
 * Импорт кэшей Wildberries (категории, комиссии, склады) в PostgreSQL
 */

import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

async function importWBCaches() {
  console.log('[Import] Starting WB caches import...');
  
  try {
    const [categoriesCache, commissionsCache, warehousesCache] = await Promise.all([
      readData('wbCategoriesCache').catch(() => null),
      readData('wbCommissionsCache').catch(() => null),
      readData('wbWarehousesCache').catch(() => null)
    ]);
    
    let imported = 0;
    let updated = 0;
    let errors = 0;
    
    await transaction(async (client) => {
      // Импорт кэша категорий
      if (categoriesCache && Array.isArray(categoriesCache)) {
        console.log(`[Import] Importing ${categoriesCache.length} WB categories...`);
        for (const category of categoriesCache) {
          try {
            const cacheKey = `wb_category_${category.subjectID || category.id}`;
            const cacheValue = category;
            
            // Проверяем существование
            const existing = await client.query(
              'SELECT id FROM cache_entries WHERE cache_type = $1 AND cache_key = $2',
              ['wb_categories', cacheKey]
            );
            
            if (existing.rows.length > 0) {
              await client.query(`
                UPDATE cache_entries SET
                  cache_value = $3,
                  updated_at = CURRENT_TIMESTAMP
                WHERE cache_type = $1 AND cache_key = $2
              `, ['wb_categories', cacheKey, JSON.stringify(cacheValue)]);
              updated++;
            } else {
              await client.query(`
                INSERT INTO cache_entries (cache_type, cache_key, cache_value)
                VALUES ($1, $2, $3)
              `, ['wb_categories', cacheKey, JSON.stringify(cacheValue)]);
              imported++;
            }
          } catch (error) {
            console.error(`[Import] Error importing WB category:`, error.message);
            errors++;
          }
        }
      }
      
      // Импорт кэша комиссий
      if (commissionsCache && Array.isArray(commissionsCache)) {
        console.log(`[Import] Importing ${commissionsCache.length} WB commissions...`);
        for (const commission of commissionsCache) {
          try {
            const cacheKey = `wb_commission_${commission.subjectID || commission.id}`;
            const cacheValue = commission;
            
            const existing = await client.query(
              'SELECT id FROM cache_entries WHERE cache_type = $1 AND cache_key = $2',
              ['wb_commissions', cacheKey]
            );
            
            if (existing.rows.length > 0) {
              await client.query(`
                UPDATE cache_entries SET
                  cache_value = $3,
                  updated_at = CURRENT_TIMESTAMP
                WHERE cache_type = $1 AND cache_key = $2
              `, ['wb_commissions', cacheKey, JSON.stringify(cacheValue)]);
              updated++;
            } else {
              await client.query(`
                INSERT INTO cache_entries (cache_type, cache_key, cache_value)
                VALUES ($1, $2, $3)
              `, ['wb_commissions', cacheKey, JSON.stringify(cacheValue)]);
              imported++;
            }
          } catch (error) {
            console.error(`[Import] Error importing WB commission:`, error.message);
            errors++;
          }
        }
      }
      
      // Импорт кэша складов
      if (warehousesCache && Array.isArray(warehousesCache)) {
        console.log(`[Import] Importing ${warehousesCache.length} WB warehouses...`);
        for (const warehouse of warehousesCache) {
          try {
            const cacheKey = `wb_warehouse_${warehouse.id || warehouse.warehouseId || warehouse.name}`;
            const cacheValue = warehouse;
            
            const existing = await client.query(
              'SELECT id FROM cache_entries WHERE cache_type = $1 AND cache_key = $2',
              ['wb_warehouses', cacheKey]
            );
            
            if (existing.rows.length > 0) {
              await client.query(`
                UPDATE cache_entries SET
                  cache_value = $3,
                  updated_at = CURRENT_TIMESTAMP
                WHERE cache_type = $1 AND cache_key = $2
              `, ['wb_warehouses', cacheKey, JSON.stringify(cacheValue)]);
              updated++;
            } else {
              await client.query(`
                INSERT INTO cache_entries (cache_type, cache_key, cache_value)
                VALUES ($1, $2, $3)
              `, ['wb_warehouses', cacheKey, JSON.stringify(cacheValue)]);
              imported++;
            }
          } catch (error) {
            console.error(`[Import] Error importing WB warehouse:`, error.message);
            errors++;
          }
        }
      }
    });
    
    console.log(`[Import] WB caches import completed: ${imported} imported, ${updated} updated, ${errors} errors`);
  } catch (error) {
    console.error('[Import] WB caches import failed:', error);
    throw error;
  }
}

// Запуск импорта
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('14_import_wb_caches.js'))) {
  importWBCaches()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importWBCaches;

