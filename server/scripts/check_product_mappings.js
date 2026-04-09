/**
 * Скрипт для проверки маппингов категорий для конкретного товара
 * Использование: node scripts/check_product_mappings.js [product_id]
 */

import { query } from '../src/config/database.js';

async function checkProductMappings(productId) {
  const numericId = parseInt(productId, 10);
  
  if (isNaN(numericId) || numericId <= 0) {
    console.error(`❌ Invalid product ID: ${productId}`);
    process.exit(1);
  }
  
  console.log(`\n🔍 Checking mappings for product_id: ${numericId}\n`);
  
  try {
    // 1. Проверяем, существует ли товар
    console.log('1️⃣ Checking if product exists...');
    const productCheck = await query(
      'SELECT id, sku, name, user_category_id FROM products WHERE id = $1',
      [numericId]
    );
    
    if (productCheck.rows.length === 0) {
      console.log(`❌ Product ${numericId} does not exist in products table`);
      process.exit(1);
    }
    
    const product = productCheck.rows[0];
    console.log(`✅ Product found:`, {
      id: product.id,
      sku: product.sku,
      name: product.name,
      user_category_id: product.user_category_id
    });
    
    // 2. Проверяем маппинги напрямую
    console.log('\n2️⃣ Checking category_mappings table...');
    const directMappings = await query(
      'SELECT * FROM category_mappings WHERE product_id = $1',
      [numericId]
    );
    
    console.log(`Found ${directMappings.rows.length} direct mappings:`);
    if (directMappings.rows.length > 0) {
      directMappings.rows.forEach((mapping, idx) => {
        console.log(`  ${idx + 1}. ID: ${mapping.id}, marketplace: ${mapping.marketplace}, category_id: ${mapping.category_id} (type: ${typeof mapping.category_id})`);
      });
    } else {
      console.log('  ⚠️  No direct mappings found');
    }
    
    // 3. Проверяем маппинги с разными типами приведения
    console.log('\n3️⃣ Checking with different type casts...');
    
    // BIGINT cast
    try {
      const bigintCheck = await query(
        'SELECT * FROM category_mappings WHERE CAST(product_id AS BIGINT) = $1',
        [numericId]
      );
      console.log(`  BIGINT cast: ${bigintCheck.rows.length} mappings`);
    } catch (err) {
      console.log(`  BIGINT cast failed: ${err.message}`);
    }
    
    // TEXT cast
    try {
      const textCheck = await query(
        'SELECT * FROM category_mappings WHERE CAST(product_id AS TEXT) = CAST($1 AS TEXT)',
        [numericId]
      );
      console.log(`  TEXT cast: ${textCheck.rows.length} mappings`);
    } catch (err) {
      console.log(`  TEXT cast failed: ${err.message}`);
    }
    
    // 4. Проверяем все маппинги в таблице (первые 10)
    console.log('\n4️⃣ Sample of all mappings in table (first 10):');
    const allMappings = await query(
      'SELECT product_id, marketplace, category_id FROM category_mappings ORDER BY product_id LIMIT 10'
    );
    allMappings.rows.forEach((mapping, idx) => {
      console.log(`  ${idx + 1}. product_id: ${mapping.product_id} (type: ${typeof mapping.product_id}), marketplace: ${mapping.marketplace}, category_id: ${mapping.category_id}`);
    });
    
    // 5. Если есть user_category_id, проверяем маппинги через категорию
    if (product.user_category_id) {
      console.log(`\n5️⃣ Checking mappings via user_category_id: ${product.user_category_id}...`);
      const categoryMappings = await query(`
        SELECT DISTINCT ON (cm.marketplace)
          cm.*,
          p.sku as product_sku
        FROM category_mappings cm
        LEFT JOIN products p ON cm.product_id = p.id
        WHERE p.user_category_id = $1
        ORDER BY cm.marketplace, cm.id DESC
      `, [product.user_category_id]);
      
      console.log(`Found ${categoryMappings.rows.length} mappings via category:`);
      categoryMappings.rows.forEach((mapping, idx) => {
        console.log(`  ${idx + 1}. Product: ${mapping.product_sku} (id: ${mapping.product_id}), marketplace: ${mapping.marketplace}, category_id: ${mapping.category_id}`);
      });
    }
    
    console.log('\n✅ Check complete!\n');
    
  } catch (error) {
    console.error('\n❌ Error:', {
      message: error.message,
      code: error.code,
      detail: error.detail
    });
    process.exit(1);
  }
  
  process.exit(0);
}

// Получаем product_id из аргументов командной строки
const productId = process.argv[2] || '5';

checkProductMappings(productId);
