/**
 * Import Category Mappings
 * Импорт маппингов категорий из JSON в PostgreSQL
 */

import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

async function importCategoryMappings() {
  console.log('[Import] Starting category mappings import...');
  
  try {
    const categoryMappings = await readData('categoryMappings');
    
    if (!categoryMappings || typeof categoryMappings !== 'object') {
      console.log('[Import] No category mappings found or invalid format');
      return;
    }
    
    let imported = 0;
    let updated = 0;
    let errors = 0;
    
    await transaction(async (client) => {
      for (const [key, mapping] of Object.entries(categoryMappings)) {
        try {
          // Парсим ключ: "categoryId_marketplace" (например: "1760021100890_wb")
          // ВАЖНО: ключ содержит categoryId, а не productId!
          const lastUnderscoreIndex = key.lastIndexOf('_');
          if (lastUnderscoreIndex === -1) {
            console.log(`[Import] Invalid key format: ${key}`);
            errors++;
            continue;
          }
          
          const categoryId = key.substring(0, lastUnderscoreIndex);
          const marketplace = key.substring(lastUnderscoreIndex + 1);
          
          // В БД используются: ozon, wb, ym (в JSON уже в правильном формате)
          const normalizedMarketplace = marketplace;
          
          // Ищем продукты по categoryId из JSON файла products.json
          // categoryId в JSON - это старый ID категории, который хранился в products.categoryId
          // Нужно найти все продукты с таким categoryId
          // Но в БД category_id может быть null, поэтому ищем через исходные данные
          
          // Читаем исходный файл products.json для поиска по categoryId
          const { readData: readDataUtil } = await import('../../src/utils/storage.js');
          const productsJson = await readDataUtil('products');
          
          // Находим продукты с таким categoryId
          const matchingProducts = Array.isArray(productsJson) 
            ? productsJson.filter(p => String(p.categoryId) === categoryId)
            : [];
          
          if (matchingProducts.length === 0) {
            console.log(`[Import] No products found with categoryId: ${categoryId} for key: ${key}`);
            errors++;
            continue;
          }
          
          // Импортируем маппинг для каждого найденного продукта
          for (const productJson of matchingProducts) {
            // Ищем продукт в БД по SKU
            const productResult = await client.query(
              'SELECT id FROM products WHERE sku = $1',
              [productJson.sku]
            );
            
            if (productResult.rows.length === 0) {
              console.log(`[Import] Product not found in DB for SKU: ${productJson.sku}`);
              continue;
            }
            
            const productDbId = productResult.rows[0].id;
            const categoryIdValue = mapping.marketplaceCategoryId || mapping.category_id || null;
            
            // Проверяем существование маппинга
            const existing = await client.query(
              'SELECT id FROM category_mappings WHERE product_id = $1 AND marketplace = $2',
              [productDbId, normalizedMarketplace]
            );
            
            if (existing.rows.length > 0) {
              // Обновляем существующий
              await client.query(`
                UPDATE category_mappings SET
                  category_id = $3,
                  updated_at = CURRENT_TIMESTAMP
                WHERE product_id = $1 AND marketplace = $2
              `, [productDbId, normalizedMarketplace, categoryIdValue]);
              updated++;
            } else {
              // Вставляем новый
              await client.query(`
                INSERT INTO category_mappings (product_id, marketplace, category_id)
                VALUES ($1, $2, $3)
              `, [productDbId, normalizedMarketplace, categoryIdValue]);
              imported++;
            }
          }
        } catch (error) {
          console.error(`[Import] Error importing category mapping "${key}":`, error.message);
          errors++;
        }
      }
    });
    
    console.log(`[Import] Category mappings import completed: ${imported} imported, ${updated} updated, ${errors} errors`);
  } catch (error) {
    console.error('[Import] Category mappings import failed:', error);
    throw error;
  }
}

// Запуск импорта
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('12_import_category_mappings.js'))) {
  importCategoryMappings()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importCategoryMappings;

