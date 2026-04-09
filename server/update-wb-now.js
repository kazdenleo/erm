import wbMarketplaceService from './src/services/wbMarketplace.service.js';
import logger from './src/utils/logger.js';

async function updateWB() {
  try {
    console.log('Запуск обновления категорий и комиссий WB...');
    logger.info('[Manual Update] Starting WB categories and commissions update');
    
    const result = await wbMarketplaceService.updateCategoriesAndCommissions();
    
    console.log('\n✓ Обновление успешно завершено!');
    console.log('Результат:', JSON.stringify(result, null, 2));
    logger.info('[Manual Update] Update completed successfully', result);
    
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Ошибка при обновлении:', error.message);
    logger.error('[Manual Update] Update failed:', error);
    process.exit(1);
  }
}

updateWB();

