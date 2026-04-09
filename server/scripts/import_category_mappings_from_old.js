/**
 * Import Category Mappings from Old Format
 * Импортирует маппинги категорий из старого формата categoryMappings.json
 * 
 * Формат: { "{userCategoryId}_{marketplace}": { marketplaceCategoryId, marketplace, ... } }
 * 
 * Маппинги привязываются ко всем товарам, которые принадлежат пользовательской категории
 */

import { query, transaction } from '../src/config/database.js';
import { readData } from '../src/utils/storage.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function importCategoryMappings() {
  console.log('[Import] Starting to import category mappings from old format...');
  
  try {
    // Читаем маппинги из JSON файла
    const mappingsFile = path.join(__dirname, '../data/categoryMappings.json');
    if (!fs.existsSync(mappingsFile)) {
      console.log('[Import] categoryMappings.json not found');
      return;
    }
    
    const mappingsData = JSON.parse(fs.readFileSync(mappingsFile, 'utf8'));
    console.log(`[Import] Found ${Object.keys(mappingsData).length} mappings in file`);
    
    // Читаем мапу старых ID -> новых ID пользовательских категорий
    let userCategoryIdMap = {};
    const idMapFile = path.join(__dirname, '../data/user_category_id_map.json');
    if (fs.existsSync(idMapFile)) {
      userCategoryIdMap = JSON.parse(fs.readFileSync(idMapFile, 'utf8'));
      console.log(`[Import] Loaded user category ID mapping: ${Object.keys(userCategoryIdMap).length} entries`);
    }
    
    let created = 0;
    let skipped = 0;
    let errors = 0;
    
    await transaction(async (client) => {
      for (const [key, mapping] of Object.entries(mappingsData)) {
        try {
          // Парсим ключ: "{oldCategoryId}_{marketplace}"
          const parts = key.split('_');
          if (parts.length < 2) {
            console.log(`[Import] Invalid mapping key format: ${key}`);
            skipped++;
            continue;
          }
          
          const oldCategoryId = parts[0];
          const marketplace = parts.slice(1).join('_'); // Может быть "wb", "ozon", "ym"
          
          // Находим новую пользовательскую категорию
          const newUserCategoryId = userCategoryIdMap[oldCategoryId];
          if (!newUserCategoryId) {
            console.log(`[Import] User category not found for old ID: ${oldCategoryId}`);
            skipped++;
            continue;
          }
          
          // Находим категорию маркетплейса
          // marketplaceCategoryId может быть "wb_5409" или "ozon_96175"
          let marketplaceCategoryId = mapping.marketplaceCategoryId;
          if (marketplaceCategoryId && marketplaceCategoryId.includes('_')) {
            // Убираем префикс маркетплейса
            marketplaceCategoryId = marketplaceCategoryId.split('_').slice(1).join('_');
          }
          
          if (!marketplaceCategoryId) {
            console.log(`[Import] No marketplace category ID in mapping: ${key}`);
            skipped++;
            continue;
          }
          
          // Ищем категорию маркетплейса в базе
          const categoryResult = await client.query(
            'SELECT id FROM categories WHERE marketplace = $1 AND marketplace_category_id = $2 LIMIT 1',
            [marketplace, marketplaceCategoryId]
          );
          
          if (categoryResult.rows.length === 0) {
            console.log(`[Import] Marketplace category not found: ${marketplace} - ${marketplaceCategoryId}`);
            // Пропускаем, но не ошибка - категория может быть не импортирована
            skipped++;
            continue;
          }
          
          const marketplaceCategoryDbId = categoryResult.rows[0].id;
          
          // Находим все товары, которые принадлежат этой пользовательской категории
          const productsResult = await client.query(
            'SELECT id FROM products WHERE user_category_id = $1',
            [newUserCategoryId]
          );
          
          if (productsResult.rows.length === 0) {
            console.log(`[Import] No products found for user category ID: ${newUserCategoryId}`);
            skipped++;
            continue;
          }
          
          // Создаем маппинги для всех товаров этой категории
          for (const productRow of productsResult.rows) {
            const productId = productRow.id;
            
            // Проверяем, не существует ли уже маппинг
            const existing = await client.query(
              'SELECT id FROM category_mappings WHERE product_id = $1 AND marketplace = $2',
              [productId, marketplace]
            );
            
            if (existing.rows.length > 0) {
              // Обновляем существующий маппинг
              await client.query(
                'UPDATE category_mappings SET category_id = $1 WHERE product_id = $2 AND marketplace = $3',
                [marketplaceCategoryDbId, productId, marketplace]
              );
            } else {
              // Создаем новый маппинг
              await client.query(
                'INSERT INTO category_mappings (product_id, marketplace, category_id) VALUES ($1, $2, $3)',
                [productId, marketplace, marketplaceCategoryDbId]
              );
            }
            
            created++;
          }
          
          console.log(`[Import] Created/updated ${productsResult.rows.length} mappings for ${key}`);
        } catch (error) {
          console.error(`[Import] Error processing mapping ${key}:`, error.message);
          errors++;
        }
      }
    });
    
    console.log(`[Import] Category mappings import completed: ${created} created/updated, ${skipped} skipped, ${errors} errors`);
  } catch (error) {
    console.error('[Import] Failed:', error);
    throw error;
  }
}

// Запуск
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('import_category_mappings_from_old.js'))) {
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

