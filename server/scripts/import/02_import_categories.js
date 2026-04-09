/**
 * Import Categories
 * Импорт категорий из кэша WB в таблицу categories
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function importCategories() {
  console.log('[Import] Starting categories import...');
  
  try {
    // Читаем категории из кэша WB
    const wbCategories = await readData('wbCategoriesCache');
    if (!Array.isArray(wbCategories) || wbCategories.length === 0) {
      console.log('[Import] No WB categories found in cache');
      return;
    }
    
    console.log(`[Import] Found ${wbCategories.length} WB categories in cache`);
    
    // Создаем мапу для быстрого поиска категорий по ID
    const categoryMap = new Map();
    const parentMap = new Map();
    
    // Сначала собираем все уникальные категории и их родителей
    for (const cat of wbCategories) {
      const subjectID = String(cat.subjectID || cat.id);
      const subjectName = cat.subjectName || cat.name || '';
      
      if (subjectID && subjectName) {
        categoryMap.set(subjectID, {
          id: subjectID,
          name: subjectName,
          parentID: cat.parentID ? String(cat.parentID) : null,
          parentName: cat.parentName || null
        });
      }
      
      // Сохраняем информацию о родителях
      if (cat.parentID) {
        const parentID = String(cat.parentID);
        if (!parentMap.has(parentID)) {
          parentMap.set(parentID, {
            id: parentID,
            name: cat.parentName || 'Неизвестная категория'
          });
        }
      }
    }
    
    // Добавляем родительские категории, если их нет
    for (const [parentID, parent] of parentMap.entries()) {
      if (!categoryMap.has(parentID)) {
        categoryMap.set(parentID, {
          id: parentID,
          name: parent.name,
          parentID: null,
          parentName: null
        });
      }
    }
    
    console.log(`[Import] Processing ${categoryMap.size} unique categories`);
    
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    
    await transaction(async (client) => {
      // Шаг 1: Импортируем все категории без родительских связей
      console.log('[Import] Step 1: Importing all categories without parent links...');
      for (const category of categoryMap.values()) {
        try {
          // Проверяем существование
          const existing = await client.query(
            'SELECT id FROM categories WHERE marketplace = $1 AND marketplace_category_id = $2',
            ['wb', category.id]
          );
          
          if (existing.rows.length > 0) {
            // Обновляем только имя и путь
            await client.query(`
              UPDATE categories SET
                name = $3,
                path = $4,
                updated_at = CURRENT_TIMESTAMP
              WHERE marketplace = $1 AND marketplace_category_id = $2
            `, ['wb', category.id, category.name, category.name]);
            updated++;
          } else {
            // Вставляем новую категорию без родителя (пока)
            await client.query(`
              INSERT INTO categories (marketplace, marketplace_category_id, name, path, parent_id)
              VALUES ($1, $2, $3, $4, NULL)
            `, ['wb', category.id, category.name, category.name]);
            imported++;
          }
        } catch (error) {
          console.error(`[Import] Error importing category "${category.name}":`, error.message);
          errors++;
        }
      }
      
      // Шаг 2: Обновляем родительские связи
      console.log('[Import] Step 2: Updating parent links...');
      let linksUpdated = 0;
      for (const category of categoryMap.values()) {
        if (!category.parentID) continue;
        
        try {
          // Находим ID родительской категории в базе
          const parentResult = await client.query(
            'SELECT id FROM categories WHERE marketplace = $1 AND marketplace_category_id = $2',
            ['wb', category.parentID]
          );
          
          if (parentResult.rows.length > 0) {
            const parentDbId = parentResult.rows[0].id;
            
            // Формируем путь категории
            let categoryPath = category.name;
            if (category.parentName) {
              categoryPath = `${category.parentName} > ${category.name}`;
            }
            
            // Обновляем родительскую связь и путь
            await client.query(`
              UPDATE categories SET
                parent_id = $3,
                path = $4,
                updated_at = CURRENT_TIMESTAMP
              WHERE marketplace = $1 AND marketplace_category_id = $2
            `, ['wb', category.id, parentDbId, categoryPath]);
            linksUpdated++;
          } else {
            // Родитель не найден, оставляем без родителя
            skipped++;
          }
        } catch (error) {
          console.error(`[Import] Error updating parent link for "${category.name}":`, error.message);
          errors++;
        }
      }
      
      console.log(`[Import] Updated ${linksUpdated} parent links`);
    });
    
    console.log(`[Import] Categories import completed: ${imported} imported, ${updated} updated, ${skipped} skipped, ${errors} errors`);
  } catch (error) {
    console.error('[Import] Categories import failed:', error);
    throw error;
  }
}

// Запуск импорта
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('02_import_categories.js'))) {
  importCategories()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importCategories;

