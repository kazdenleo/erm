/**
 * Create User Categories
 * Создает пользовательские категории и связывает товары с ними
 */

import { query, transaction } from '../src/config/database.js';
import { readData } from '../src/utils/storage.js';

async function createUserCategories() {
  console.log('[Create] Starting to create user categories...');
  
  try {
    // Читаем товары
    const products = await readData('products');
    if (!Array.isArray(products) || products.length === 0) {
      console.log('[Create] No products found');
      return;
    }
    
    // Определяем категории по названиям товаров
    const categoriesMap = {
      'Фильтры воздушные': {
        name: 'Фильтры воздушные',
        description: 'Фильтры воздушные для автомобилей',
        oldId: '1760021100890'
      },
      'Тормозные колодки': {
        name: 'Тормозные колодки',
        description: 'Тормозные колодки для автомобилей',
        oldId: '1760021113013'
      }
    };
    
    let createdCategories = {};
    
    await transaction(async (client) => {
      // Создаем категории
      for (const [key, catData] of Object.entries(categoriesMap)) {
        try {
          // Проверяем, существует ли категория
          const existing = await client.query(
            'SELECT id FROM user_categories WHERE name = $1',
            [catData.name]
          );
          
          if (existing.rows.length > 0) {
            createdCategories[catData.oldId] = existing.rows[0].id;
            console.log(`[Create] Category "${catData.name}" already exists with ID: ${existing.rows[0].id}`);
          } else {
            // Создаем категорию
            const result = await client.query(
              'INSERT INTO user_categories (name, description) VALUES ($1, $2) RETURNING id',
              [catData.name, catData.description]
            );
            
            const newId = result.rows[0].id;
            createdCategories[catData.oldId] = newId;
            console.log(`[Create] Created category "${catData.name}" with ID: ${newId} (old ID: ${catData.oldId})`);
          }
        } catch (error) {
          console.error(`[Create] Error creating category "${catData.name}":`, error.message);
        }
      }
      
      // Связываем товары с категориями
      let updated = 0;
      for (const product of products) {
        try {
          if (!product.categoryId || !product.sku) {
            continue;
          }
          
          const oldCategoryId = String(product.categoryId);
          const newCategoryId = createdCategories[oldCategoryId];
          
          if (!newCategoryId) {
            console.log(`[Create] No category mapping found for product ${product.sku}, categoryId: ${oldCategoryId}`);
            continue;
          }
          
          // Обновляем товар
          await client.query(
            'UPDATE products SET user_category_id = $1 WHERE sku = $2',
            [newCategoryId, product.sku]
          );
          
          updated++;
          console.log(`[Create] Updated product ${product.sku}: user_category_id = ${newCategoryId}`);
        } catch (error) {
          console.error(`[Create] Error updating product ${product.sku}:`, error.message);
        }
      }
      
      console.log(`[Create] Linked ${updated} products to user categories`);
    });
    
    // Сохраняем мапу ID для будущего использования
    if (Object.keys(createdCategories).length > 0) {
      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      
      const idMapFile = path.join(__dirname, '../data/user_category_id_map.json');
      fs.writeFileSync(idMapFile, JSON.stringify(createdCategories, null, 2));
      console.log(`[Create] ID mapping saved to ${idMapFile}`);
    }
    
    console.log('[Create] Done');
  } catch (error) {
    console.error('[Create] Failed:', error);
    throw error;
  }
}

// Запуск
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('create_user_categories.js'))) {
  createUserCategories()
    .then(() => {
      console.log('[Create] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Create] Fatal error:', error);
      process.exit(1);
    });
}

export default createUserCategories;

