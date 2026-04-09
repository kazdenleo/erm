/**
 * Import User Categories
 * Импорт пользовательских категорий из localStorage/файлов в PostgreSQL
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function importUserCategories() {
  console.log('[Import] Starting user categories import...');
  
  try {
    // Пытаемся прочитать категории из файла
    let userCategories = null;
    
    try {
      userCategories = await readData('categories');
      if (!Array.isArray(userCategories)) {
        userCategories = null;
      }
    } catch (error) {
      console.log('[Import] No categories file found, checking localStorage migration...');
    }
    
    // Если нет в файле, проверяем, есть ли данные в старой версии
    // (в реальности нужно будет экспортировать из localStorage браузера)
    if (!userCategories || userCategories.length === 0) {
      console.log('[Import] No user categories found to import');
      console.log('[Import] To import user categories, you need to:');
      console.log('[Import] 1. Export categories from browser localStorage');
      console.log('[Import] 2. Save them to server/data/categories.json');
      console.log('[Import] 3. Run this script again');
      return;
    }
    
    console.log(`[Import] Found ${userCategories.length} user categories`);
    
    // Создаем мапу для связи старых ID с новыми
    const idMap = new Map();
    
    let imported = 0;
    let updated = 0;
    let errors = 0;
    
    await transaction(async (client) => {
      // Шаг 1: Импортируем категории без родителей
      const categoriesWithoutParents = userCategories.filter(cat => !cat.parentId);
      const categoriesWithParents = userCategories.filter(cat => cat.parentId);
      
      // Импортируем категории без родителей
      for (const category of categoriesWithoutParents) {
        try {
          const oldId = category.id;
          const name = category.name || '';
          const description = category.description || null;
          const productsCount = category.productsCount || 0;
          
          if (!name) {
            console.log(`[Import] Skipping category with empty name (old ID: ${oldId})`);
            continue;
          }
          
          // Проверяем существование по имени (если нет старого ID)
          let existing = null;
          if (oldId) {
            // Пытаемся найти по старому ID (если сохранили в description или другом поле)
            // В данном случае просто импортируем как новые
          }
          
          // Вставляем новую категорию
          const result = await client.query(`
            INSERT INTO user_categories (name, description, parent_id, products_count)
            VALUES ($1, $2, NULL, $3)
            RETURNING id
          `, [name, description, productsCount]);
          
          const newId = result.rows[0].id;
          idMap.set(oldId, newId);
          imported++;
          
          console.log(`[Import] Imported category: "${name}" (old ID: ${oldId} -> new ID: ${newId})`);
        } catch (error) {
          console.error(`[Import] Error importing category "${category.name}":`, error.message);
          errors++;
        }
      }
      
      // Шаг 2: Импортируем категории с родителями
      // Сортируем по уровню вложенности
      let remainingCategories = [...categoriesWithParents];
      let maxIterations = 10; // Защита от бесконечного цикла
      let iteration = 0;
      
      while (remainingCategories.length > 0 && iteration < maxIterations) {
        iteration++;
        const processed = [];
        
        for (const category of remainingCategories) {
          try {
            const oldId = category.id;
            const oldParentId = category.parentId;
            const name = category.name || '';
            const description = category.description || null;
            const productsCount = category.productsCount || 0;
            
            if (!name) {
              processed.push(category);
              continue;
            }
            
            // Проверяем, есть ли родитель в мапе
            const newParentId = idMap.get(oldParentId);
            if (!newParentId && oldParentId) {
              // Родитель еще не импортирован, пропускаем
              continue;
            }
            
            // Вставляем новую категорию
            const result = await client.query(`
              INSERT INTO user_categories (name, description, parent_id, products_count)
              VALUES ($1, $2, $3, $4)
              RETURNING id
            `, [name, description, newParentId, productsCount]);
            
            const newId = result.rows[0].id;
            idMap.set(oldId, newId);
            imported++;
            processed.push(category);
            
            console.log(`[Import] Imported category: "${name}" (old ID: ${oldId} -> new ID: ${newId}, parent: ${newParentId})`);
          } catch (error) {
            console.error(`[Import] Error importing category "${category.name}":`, error.message);
            errors++;
            processed.push(category);
          }
        }
        
        remainingCategories = remainingCategories.filter(cat => !processed.includes(cat));
      }
      
      if (remainingCategories.length > 0) {
        console.log(`[Import] Warning: ${remainingCategories.length} categories could not be imported (circular references or missing parents)`);
      }
    });
    
    console.log(`[Import] User categories import completed: ${imported} imported, ${updated} updated, ${errors} errors`);
    console.log(`[Import] ID mapping created for ${idMap.size} categories`);
    
    // Сохраняем мапу для использования при импорте товаров
    if (idMap.size > 0) {
      const idMapFile = path.join(__dirname, '../../data/user_category_id_map.json');
      const idMapObj = Object.fromEntries(idMap);
      fs.writeFileSync(idMapFile, JSON.stringify(idMapObj, null, 2));
      console.log(`[Import] ID mapping saved to ${idMapFile}`);
    }
  } catch (error) {
    console.error('[Import] User categories import failed:', error);
    throw error;
  }
}

// Запуск импорта
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('02b_import_user_categories.js'))) {
  importUserCategories()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importUserCategories;

