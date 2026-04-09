#!/usr/bin/env node

/**
 * Скрипт для ежедневного обновления категорий и комиссий Wildberries
 * Запускается по расписанию (например, через cron или Task Scheduler)
 * Теперь работает с БД вместо JSON файлов
 */

import wbMarketplaceService from './server/src/services/wbMarketplace.service.js';
import logger from './server/src/utils/logger.js';

// Основная функция обновления
async function updateWBCache() {
  try {
    logger.info('[WB Cache Update] Starting cache update...');
    
    // Используем сервис для обновления категорий и комиссий
    const result = await wbMarketplaceService.updateCategoriesAndCommissions();
    
    logger.info('[WB Cache Update] Cache update completed successfully', result);
    process.exit(0);
    
  } catch (error) {
    logger.error('[WB Cache Update] Cache update failed:', error);
    process.exit(1);
  }
}

// Запуск обновления (если скрипт запущен напрямую)
// Проверяем, что скрипт запущен напрямую, а не импортирован
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     import.meta.url.includes('update-wb-cache.js');
if (isMainModule) {
  updateWBCache();
}

export { updateWBCache };
