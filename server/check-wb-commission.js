/**
 * Скрипт для проверки комиссий WB в базе данных
 * Показывает структуру raw_data и извлекаемые значения
 */

import { query } from './src/config/database.js';
import wbMarketplaceService from './src/services/wbMarketplace.service.js';

async function checkCommission(categoryId) {
  try {
    console.log('========================================');
    console.log('  Checking WB Commission');
    console.log('========================================');
    console.log(`Category ID: ${categoryId}`);
    console.log('');

    // Получаем комиссию из БД
    const commission = await wbMarketplaceService.getCommissionByCategoryId(parseInt(categoryId));
    
    if (!commission) {
      console.log('✗ Commission not found in database');
      return;
    }

    console.log('Database record:');
    console.log('  ID:', commission.id);
    console.log('  Category ID:', commission.category_id);
    console.log('  Category Name:', commission.category_name);
    console.log('  Commission Percent:', commission.commission_percent);
    console.log('  Has raw_data:', !!commission.raw_data);
    console.log('');

    // Парсим raw_data
    if (commission.raw_data) {
      const rawData = typeof commission.raw_data === 'string' 
        ? JSON.parse(commission.raw_data) 
        : commission.raw_data;
      
      console.log('Raw data structure:');
      console.log('  All keys:', Object.keys(rawData).join(', '));
      console.log('');

      // Проверяем основные поля
      console.log('Commission values in raw_data:');
      console.log('  kgvpMarketplace (FBO):', rawData.kgvpMarketplace !== undefined ? rawData.kgvpMarketplace : 'NOT FOUND');
      console.log('  kgvpSupplier (FBS):', rawData.kgvpSupplier !== undefined ? rawData.kgvpSupplier : 'NOT FOUND');
      console.log('  commission:', rawData.commission !== undefined ? rawData.commission : 'NOT FOUND');
      console.log('  commissionPercent:', rawData.commissionPercent !== undefined ? rawData.commissionPercent : 'NOT FOUND');
      console.log('');

      // Показываем полную структуру
      console.log('Full raw_data:');
      console.log(JSON.stringify(rawData, null, 2));
      console.log('');

      // Симулируем логику из prices.service.js
      let fboPercent = 0;
      let fbsPercent = 0;

      if (rawData.kgvpMarketplace !== undefined && rawData.kgvpMarketplace !== null) {
        fboPercent = parseFloat(rawData.kgvpMarketplace || 0);
      }
      if (rawData.kgvpSupplier !== undefined && rawData.kgvpSupplier !== null) {
        fbsPercent = parseFloat(rawData.kgvpSupplier || 0);
      }

      console.log('Extracted values (as in prices.service.js):');
      console.log('  FBO Percent:', fboPercent || 'NOT FOUND (will use commission_percent: ' + commission.commission_percent + '%)');
      console.log('  FBS Percent:', fbsPercent || 'NOT FOUND (will use commission_percent: ' + commission.commission_percent + '%)');
      console.log('');

      if (fboPercent === 0 && fbsPercent === 0) {
        console.log('⚠ WARNING: kgvpMarketplace and kgvpSupplier not found in raw_data!');
        console.log('  Will fallback to commission_percent:', commission.commission_percent + '%');
        console.log('  This is likely the problem!');
      }
    } else {
      console.log('⚠ No raw_data in database record');
    }

    console.log('========================================');
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

// Получаем categoryId из аргументов командной строки
const categoryId = process.argv[2];

if (!categoryId) {
  console.log('Usage: node check-wb-commission.js <category_id>');
  console.log('');
  console.log('Example: node check-wb-commission.js 12345');
  console.log('');
  console.log('To find category_id for a product:');
  console.log('  SELECT id, marketplace_category_id, name FROM categories WHERE marketplace = \'wb\' LIMIT 10;');
  process.exit(1);
}

checkCommission(categoryId).then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

