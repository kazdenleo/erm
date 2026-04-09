/**
 * Import Products
 * РРјРїРѕСЂС‚ С‚РѕРІР°СЂРѕРІ РёР· JSON РІ PostgreSQL
 */

import { query, transaction } from '../../src/config/database.js';
import { readData } from '../../src/utils/storage.js';

async function importProducts() {
  console.log('[Import] Starting products import...');
  
  try {
    const products = await readData('products');
    if (!Array.isArray(products) || products.length === 0) {
      console.log('[Import] No products found');
      return;
    }
    
    console.log(`[Import] Found ${products.length} products`);
    
    let imported = 0;
    let updated = 0;
    let errors = 0;
    
    // РРјРїРѕСЂС‚РёСЂСѓРµРј РїРѕ Р±Р°С‚С‡Р°Рј РїРѕ 100 С‚РѕРІР°СЂРѕРІ
    const batchSize = 100;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      
      await transaction(async (client) => {
        for (const product of batch) {
          try {
            // РџРѕР»СѓС‡Р°РµРј brand_id
            let brandId = null;
            if (product.brand) {
              const brandResult = await client.query(
                'SELECT id FROM brands WHERE name = $1',
                [product.brand.trim()]
              );
              if (brandResult.rows.length > 0) {
                brandId = brandResult.rows[0].id;
              }
            }
            
            // РџРѕР»СѓС‡Р°РµРј category_id (РµСЃР»Рё РµСЃС‚СЊ)
            let categoryId = null;
            if (product.categoryId) {
              const categoryResult = await client.query(
                'SELECT id FROM categories WHERE marketplace_category_id = $1 LIMIT 1',
                [String(product.categoryId)]
              );
              if (categoryResult.rows.length > 0) {
                categoryId = categoryResult.rows[0].id;
              }
            }
            
            // РџСЂРѕРІРµСЂСЏРµРј, СЃСѓС‰РµСЃС‚РІСѓРµС‚ Р»Рё С‚РѕРІР°СЂ
            const existing = await client.query(
              'SELECT id FROM products WHERE sku = $1',
              [product.sku]
            );
            
            const productData = {
              sku: product.sku,
              name: product.name || '',
              brand_id: brandId,
              category_id: categoryId,
              price: parseFloat(product.price) || 0,
              min_price: parseFloat(product.minPrice) || 0,
              buyout_rate: parseInt(product.buyout_rate) || 100,
              weight: product.weight ? parseInt(product.weight) : null,
              length: product.length ? parseInt(product.length) : null,
              width: product.width ? parseInt(product.width) : null,
              height: product.height ? parseInt(product.height) : null,
              volume: product.volume ? parseFloat(product.volume) : null,
              quantity: product.quantity ? parseInt(product.quantity) : 1,
              unit: product.unit || 'С€С‚',
              description: product.description || null,
              created_at: product.createdAt ? new Date(product.createdAt) : new Date(),
              updated_at: product.updatedAt ? new Date(product.updatedAt) : new Date()
            };
            
            if (existing.rows.length > 0) {
              // РћР±РЅРѕРІР»СЏРµРј СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ С‚РѕРІР°СЂ
              await client.query(`
                UPDATE products SET
                  name = $2,
                  brand_id = $3,
                  category_id = $4,
                  price = $5,
                  min_price = $6,
                  buyout_rate = $7,
                  weight = $8,
                  length = $9,
                  width = $10,
                  height = $11,
                  volume = $12,
                  quantity = $13,
                  unit = $14,
                  description = $15,
                  updated_at = $16
                WHERE sku = $1
              `, [
                productData.sku,
                productData.name,
                productData.brand_id,
                productData.category_id,
                productData.price,
                productData.min_price,
                productData.buyout_rate,
                productData.weight,
                productData.length,
                productData.width,
                productData.height,
                productData.volume,
                productData.quantity,
                productData.unit,
                productData.description,
                productData.updated_at
              ]);
              updated++;
            } else {
              // Р’СЃС‚Р°РІР»СЏРµРј РЅРѕРІС‹Р№ С‚РѕРІР°СЂ
              await client.query(`
                INSERT INTO products (
                  sku, name, brand_id, category_id, price, min_price, buyout_rate,
                  weight, length, width, height, volume, quantity, unit, description,
                  created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
              `, [
                productData.sku,
                productData.name,
                productData.brand_id,
                productData.category_id,
                productData.price,
                productData.min_price,
                productData.buyout_rate,
                productData.weight,
                productData.length,
                productData.width,
                productData.height,
                productData.volume,
                productData.quantity,
                productData.unit,
                productData.description,
                productData.created_at,
                productData.updated_at
              ]);
              imported++;
            }
            
            // РРјРїРѕСЂС‚РёСЂСѓРµРј С€С‚СЂРёС…РєРѕРґС‹
            if (product.barcodes && Array.isArray(product.barcodes)) {
              const productIdResult = await client.query(
                'SELECT id FROM products WHERE sku = $1',
                [product.sku]
              );
              
              if (productIdResult.rows.length > 0) {
                const productId = productIdResult.rows[0].id;
                
                for (const barcode of product.barcodes) {
                  if (barcode && barcode.trim()) {
                    try {
                      await client.query(`
                        INSERT INTO barcodes (product_id, barcode)
                        VALUES ($1, $2)
                        ON CONFLICT (barcode) DO NOTHING
                      `, [productId, barcode.trim()]);
                    } catch (error) {
                      // РРіРЅРѕСЂРёСЂСѓРµРј РѕС€РёР±РєРё РґСѓР±Р»РёРєР°С‚РѕРІ
                    }
                  }
                }
              }
            }
            
            // РРјРїРѕСЂС‚РёСЂСѓРµРј SKU РґР»СЏ РјР°СЂРєРµС‚РїР»РµР№СЃРѕРІ
            const productIdResult = await client.query(
              'SELECT id FROM products WHERE sku = $1',
              [product.sku]
            );
            
            if (productIdResult && productIdResult.rows.length > 0) {
              const productId = productIdResult.rows[0].id;
              
              const marketplaces = [
                { name: 'ozon', sku: product.sku_ozon },
                { name: 'wb', sku: product.sku_wb },
                { name: 'ym', sku: product.sku_ym }
              ];
              
              for (const mp of marketplaces) {
                if (mp.sku && mp.sku.trim()) {
                  try {
                    await client.query(`
                      INSERT INTO product_skus (product_id, marketplace, sku)
                      VALUES ($1, $2, $3)
                      ON CONFLICT (product_id, marketplace) DO UPDATE SET sku = $3
                    `, [productId, mp.name, mp.sku.trim()]);
                  } catch (error) {
                    console.error(`[Import] Error importing SKU for ${mp.name}:`, error.message);
                  }
                }
              }
              
              // РРјРїРѕСЂС‚РёСЂСѓРµРј СЃРІСЏР·Рё СЃ РјР°СЂРєРµС‚РїР»РµР№СЃР°РјРё
              if (product.mp_linked) {
                for (const [mp, isLinked] of Object.entries(product.mp_linked)) {
                  if (['ozon', 'wb', 'ym'].includes(mp)) {
                    try {
                      await client.query(`
                        INSERT INTO product_links (product_id, marketplace, is_linked)
                        VALUES ($1, $2, $3)
                        ON CONFLICT (product_id, marketplace) DO UPDATE SET is_linked = $3
                      `, [productId, mp, Boolean(isLinked)]);
                    } catch (error) {
                      console.error(`[Import] Error importing link for ${mp}:`, error.message);
                    }
                  }
                }
              }
            }
          } catch (error) {
            console.error(`[Import] Error importing product ${product.sku}:`, error.message);
            errors++;
          }
        }
      });
      
      console.log(`[Import] Processed ${Math.min(i + batchSize, products.length)}/${products.length} products`);
    }
    
    console.log(`[Import] Products import completed: ${imported} imported, ${updated} updated, ${errors} errors`);
  } catch (error) {
    console.error('[Import] Products import failed:', error);
    throw error;
  }
}

// Р—Р°РїСѓСЃРє РёРјРїРѕСЂС‚Р°
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].includes('03_import_products.js'))) {
  importProducts()
    .then(() => {
      console.log('[Import] Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Import] Fatal error:', error);
      process.exit(1);
    });
}

export default importProducts;

