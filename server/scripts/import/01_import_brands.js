/**
 * Import Brands
 * РРјРїРѕСЂС‚ Р±СЂРµРЅРґРѕРІ РёР· JSON РІ PostgreSQL
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function importBrands() {
  console.log('[Import] Starting brands import...');
  
  try {
    // Р§РёС‚Р°РµРј С‚РѕРІР°СЂС‹ РёР· JSON
    const products = await readData('products');
    if (!Array.isArray(products)) {
      console.log('[Import] No products found');
      return;
    }
    
    // РР·РІР»РµРєР°РµРј СѓРЅРёРєР°Р»СЊРЅС‹Рµ Р±СЂРµРЅРґС‹
    const brandsSet = new Set();
    products.forEach(product => {
      if (product.brand && product.brand.trim()) {
        brandsSet.add(product.brand.trim());
      }
    });
    
    const brands = Array.from(brandsSet);
    console.log(`[Import] Found ${brands.length} unique brands`);
    
    // РРјРїРѕСЂС‚РёСЂСѓРµРј РІ С‚СЂР°РЅР·Р°РєС†РёРё
    let imported = 0;
    let skipped = 0;
    
    await transaction(async (client) => {
      for (const brandName of brands) {
        try {
          // РџСЂРѕРІРµСЂСЏРµРј, СЃСѓС‰РµСЃС‚РІСѓРµС‚ Р»Рё Р±СЂРµРЅРґ
          const existing = await client.query(
            'SELECT id FROM brands WHERE name = $1',
            [brandName]
          );
          
          if (existing.rows.length > 0) {
            skipped++;
            continue;
          }
          
          // Р’СЃС‚Р°РІР»СЏРµРј Р±СЂРµРЅРґ
          await client.query(
            'INSERT INTO brands (name) VALUES ($1)',
            [brandName]
          );
          imported++;
        } catch (error) {
          console.error(`[Import] Error importing brand "${brandName}":`, error.message);
        }
      }
    });
    
    console.log(`[Import] Brands import completed: ${imported} imported, ${skipped} skipped`);
  } catch (error) {
    console.error('[Import] Brands import failed:', error);
    throw error;
  }
}

// Р—Р°РїСѓСЃРє РёРјРїРѕСЂС‚Р°
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('01_import_brands.js'))) {
  importBrands()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importBrands;

