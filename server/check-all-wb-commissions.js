/**
 * Скрипт для проверки всех комиссий WB в базе данных
 * Показывает структуру raw_data и проблемные записи
 */

import { query } from './src/config/database.js';

async function checkAllCommissions() {
  try {
    console.log('========================================');
    console.log('  Checking All WB Commissions');
    console.log('========================================');
    console.log('');

    // Получаем все комиссии
    const result = await query(`
      SELECT 
        id,
        category_id,
        category_name,
        commission_percent,
        raw_data
      FROM wb_commissions
      ORDER BY category_id
      LIMIT 20
    `);

    console.log(`Found ${result.rows.length} commissions (showing first 20)`);
    console.log('');

    let hasKgvpMarketplace = 0;
    let hasKgvpSupplier = 0;
    let missingBoth = 0;
    const problems = [];

    for (const row of result.rows) {
      const rawData = row.raw_data 
        ? (typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data)
        : null;

      if (!rawData) {
        problems.push({
          category_id: row.category_id,
          category_name: row.category_name,
          issue: 'No raw_data'
        });
        continue;
      }

      const hasMarketplace = rawData.kgvpMarketplace !== undefined && rawData.kgvpMarketplace !== null;
      const hasSupplier = rawData.kgvpSupplier !== undefined && rawData.kgvpSupplier !== null;

      if (hasMarketplace) hasKgvpMarketplace++;
      if (hasSupplier) hasKgvpSupplier++;
      if (!hasMarketplace && !hasSupplier) {
        missingBoth++;
        problems.push({
          category_id: row.category_id,
          category_name: row.category_name,
          commission_percent: row.commission_percent,
          issue: 'Missing kgvpMarketplace and kgvpSupplier',
          allKeys: Object.keys(rawData).slice(0, 10).join(', ')
        });
      }

      // Показываем первые 5 записей подробно
      if (result.rows.indexOf(row) < 5) {
        console.log(`Category ID: ${row.category_id} (${row.category_name})`);
        console.log(`  Commission Percent (DB): ${row.commission_percent}%`);
        console.log(`  kgvpMarketplace (FBO): ${hasMarketplace ? rawData.kgvpMarketplace + '%' : 'NOT FOUND'}`);
        console.log(`  kgvpSupplier (FBS): ${hasSupplier ? rawData.kgvpSupplier + '%' : 'NOT FOUND'}`);
        console.log(`  All keys in raw_data: ${Object.keys(rawData).join(', ')}`);
        console.log('');
      }
    }

    console.log('========================================');
    console.log('  Summary');
    console.log('========================================');
    console.log(`Total checked: ${result.rows.length}`);
    console.log(`Has kgvpMarketplace: ${hasKgvpMarketplace}`);
    console.log(`Has kgvpSupplier: ${hasKgvpSupplier}`);
    console.log(`Missing both: ${missingBoth}`);
    console.log('');

    if (problems.length > 0) {
      console.log('========================================');
      console.log('  PROBLEMS FOUND');
      console.log('========================================');
      console.log(`Found ${problems.length} categories with missing kgvpMarketplace/kgvpSupplier:`);
      console.log('');
      problems.slice(0, 10).forEach((p, i) => {
        console.log(`${i + 1}. Category ID: ${p.category_id} (${p.category_name})`);
        console.log(`   Issue: ${p.issue}`);
        console.log(`   Commission Percent (fallback): ${p.commission_percent}%`);
        if (p.allKeys) {
          console.log(`   Available keys: ${p.allKeys}...`);
        }
        console.log('');
      });
      
      if (problems.length > 10) {
        console.log(`... and ${problems.length - 10} more`);
      }
    }

    console.log('========================================');
    console.log('');
    console.log('To check a specific category:');
    console.log('  node check-wb-commission.js <category_id>');
    console.log('');

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

checkAllCommissions().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

