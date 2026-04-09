/**
 * SupplierStocksService
 * Полноценный сервис для работы с остатками поставщиков (Mikado, Moskvorechie)
 * и их кэшем.
 */

import fetch from 'node-fetch';
import { readData, writeData } from '../utils/storage.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';
import productsService from './products.service.js';
import { getCache, setCache } from '../config/redis.js';
import logger from '../utils/logger.js';

class SupplierStocksService {
  /**
   * Получить остатки по одному товару от поставщика.
   * 1) пробует Redis кэш
   * 2) пробует PostgreSQL кэш (supplier_stocks)
   * 3) пробует файловый кэш (старое хранилище)
   * 4) при отсутствии кэша идёт в API Mikado / Moskvorechie
   * 5) опционально фильтрует по списку городов/складов
   */
  async getSupplierStock({ supplier, sku, brand, cities, forceRefresh = false }) {
    if (!supplier) {
      const err = new Error('Поставщик не указан');
      err.statusCode = 400;
      throw err;
    }
    if (!sku) {
      const err = new Error('SKU не указан');
      err.statusCode = 400;
      throw err;
    }

    // Получаем конфигурацию поставщика
    // Сначала пробуем получить из таблицы suppliers (новый способ)
    let supplierConfig = null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      try {
        const suppliersService = await import('./suppliers.service.js');
        // Нормализуем код поставщика для поиска
        const normalizedCode = supplier.toLowerCase().replace('москворечье', 'moskvorechie');
        const supplierData = await suppliersService.default.getByCode(normalizedCode);
        logger.info(`[Supplier Stocks] Supplier data from DB for ${supplier} (normalized: ${normalizedCode}): ${JSON.stringify(supplierData, null, 2)}`);
        if (supplierData && supplierData.apiConfig) {
          supplierConfig = supplierData.apiConfig;
          logger.info(`[Supplier Stocks] apiConfig for ${supplier}: ${JSON.stringify(supplierConfig, null, 2)}`);
        }
      } catch (e) {
        logger.error('[Supplier Stocks] Error getting supplier from suppliers table:', e.message);
      }
    }
    
    // Если не нашли в suppliers или нет учетных данных, пробуем старый способ через integrations
    // Нормализуем код поставщика для поиска в integrations
    const normalizedSupplierForIntegrations = supplier.toLowerCase().replace('москворечье', 'moskvorechie');
    if (!supplierConfig || (!supplierConfig.user_id && !supplierConfig.password && !supplierConfig.apiKey)) {
      try {
        const integrationsConfig = await integrationsService.getSupplierConfig(normalizedSupplierForIntegrations);
        logger.info(`[Supplier Stocks] Config from integrations for ${normalizedSupplierForIntegrations}: ${JSON.stringify(integrationsConfig, null, 2)}`);
        // Объединяем конфигурации: сначала из suppliers, потом из integrations
        supplierConfig = {
          ...(supplierConfig || {}),
          ...integrationsConfig
        };
        logger.info(`[Supplier Stocks] Merged config for ${supplier}: ${JSON.stringify(supplierConfig, null, 2)}`);
      } catch (e) {
        logger.error('[Supplier Stocks] Error getting supplier config from integrations:', e.message);
        if (!supplierConfig) {
          supplierConfig = {};
        }
      }
    }

    let warehouseCities = [];
    if (cities) {
      warehouseCities = cities.split(',').map(c => c.trim());
      logger.info(`[Supplier Stocks] Warehouse cities from query param: ${warehouseCities.join(', ')}`);
    } else if (supplierConfig?.warehouses && Array.isArray(supplierConfig.warehouses)) {
      warehouseCities = supplierConfig.warehouses.map(w => w.name);
      logger.info(`[Supplier Stocks] Config warehouses for ${supplier}: ${warehouseCities.join(', ')}`);
    } else {
      logger.info(`[Supplier Stocks] No warehouse filter configured for ${supplier}`);
    }

    let stockData = null;

    // Если forceRefresh = true, пропускаем все кэши и сразу идем в API
    if (!forceRefresh) {
      // 1. Пытаемся взять из Redis кэша (временно отключено для Москворечье для отладки)
      if (supplier !== 'moskvorechie') {
      const redisKey = `supplier_stock:${supplier}:${sku}`;
      stockData = await getCache(redisKey);
      if (stockData) {
        logger.info(`[Supplier Stocks] Got from Redis cache for ${supplier}:${sku}`);
        logger.info(`[Supplier Stocks] Redis cache warehouses type: ${typeof stockData.warehouses}, isArray: ${Array.isArray(stockData.warehouses)}`);
        if (stockData.warehouses && Array.isArray(stockData.warehouses)) {
          logger.info(`[Supplier Stocks] Redis cached warehouses: ${stockData.warehouses.map(w => w.city || w.name || JSON.stringify(w)).join(', ')}`);
        } else if (stockData.warehouses) {
          logger.info(`[Supplier Stocks] Redis cached warehouses (not array): ${JSON.stringify(stockData.warehouses)}`);
        } else {
          logger.info(`[Supplier Stocks] No warehouses in Redis cache for ${supplier}:${sku}`);
        }
      }
    } else {
      logger.info(`[Supplier Stocks] Cache disabled for ${supplier} - fetching fresh data from API`);
    }

    // 2. Если нет в Redis, пробуем PostgreSQL (временно отключено для Москворечье для отладки)
    if (!stockData && repositoryFactory.isUsingPostgreSQL() && supplier !== 'moskvorechie') {
      try {
        const supplierStocksService = await import('./supplier_stocks.service.js');
        const stockRecord = await supplierStocksService.default.getBySupplierAndProduct(supplier, sku);
        if (stockRecord && stockRecord.cached_at) {
          // Проверяем, не устарел ли кэш (24 часа)
          const cacheAge = Date.now() - new Date(stockRecord.cached_at).getTime();
          const maxAge = 24 * 60 * 60 * 1000; // 24 часа
          
          if (cacheAge < maxAge) {
            const warehouses = stockRecord.warehouses ? (typeof stockRecord.warehouses === 'string' ? JSON.parse(stockRecord.warehouses) : stockRecord.warehouses) : null;
            stockData = {
              stock: stockRecord.stock || 0,
              stockName: stockRecord.stock_name || `Склад ${supplier}`,
              deliveryDays: stockRecord.delivery_days || 0,
              price: stockRecord.price || null,
              source: stockRecord.source || 'cache',
              warehouses: warehouses
            };
            
            console.log(`[Supplier Stocks] Got from PostgreSQL cache for ${supplier}:${sku}`);
            console.log(`[Supplier Stocks] Cached warehouses type: ${typeof warehouses}, isArray: ${Array.isArray(warehouses)}`);
            if (warehouses && Array.isArray(warehouses)) {
              console.log(`[Supplier Stocks] Cached warehouses: ${warehouses.map(w => w.city || w.name || JSON.stringify(w)).join(', ')}`);
            } else if (warehouses) {
              console.log(`[Supplier Stocks] Cached warehouses (not array): ${JSON.stringify(warehouses)}`);
            } else {
              console.log(`[Supplier Stocks] No warehouses in cache for ${supplier}:${sku}`);
            }
            
            // Сохраняем в Redis на 1 час (временно отключено для Москворечье)
            if (supplier !== 'moskvorechie') {
              const redisKey = `supplier_stock:${supplier}:${sku}`;
              await setCache(redisKey, stockData, 3600);
            }
          }
        }
      } catch (error) {
        logger.error('[Supplier Stocks] Error getting from PostgreSQL:', error.message);
      }
    }

    // 3. Если нет в PostgreSQL, пробуем файловый кэш (старое хранилище) (временно отключено для Москворечье)
    if (!stockData && supplier !== 'moskvorechie') {
      try {
        const stockCache = await readData('supplierStockCache');
        const supplierCache = stockCache?.[supplier] || {};
        if (supplierCache[sku]) {
          stockData = supplierCache[sku];
        }
      } catch (error) {
        logger.error('[Supplier Stocks] Error reading file cache:', error.message);
      }
    }
    }

    // 4. Если нет в кэше или forceRefresh = true – получаем из API
    if (!stockData) {
      // Нормализуем код поставщика (преобразуем кириллицу в латиницу для сравнения)
      const normalizedSupplier = supplier.toLowerCase().replace('москворечье', 'moskvorechie');
      
      if (normalizedSupplier === 'mikado') {
        stockData = await getMikadoStock(sku, brand, supplierConfig);
      } else if (normalizedSupplier === 'moskvorechie') {
        stockData = await getMoskvorechieStock(sku, supplierConfig);
      } else {
        const err = new Error(`Неподдерживаемый поставщик: ${supplier}`);
        err.statusCode = 400;
        throw err;
      }

      // Если данных нет, возвращаем null вместо ошибки
      // Это нормальная ситуация - у поставщика может не быть товара на складе
      if (!stockData) {
        return null;
      }

      // Сохраняем в кэш после получения из API
      // Redis кэш на 1 час (временно отключено для Москворечье)
      if (supplier !== 'moskvorechie') {
        const redisKey = `supplier_stock:${supplier}:${sku}`;
        await setCache(redisKey, stockData, 3600);
      }
      
      // PostgreSQL кэш (если используется)
      if (repositoryFactory.isUsingPostgreSQL()) {
        try {
          const supplierStocksService = await import('./supplier_stocks.service.js');
          const product = await productsService.getBySku(sku);
          if (product) {
            // Нормализуем код поставщика перед сохранением (кириллица -> латиница)
            const normalizedSupplier = supplier.toLowerCase().replace('москворечье', 'moskvorechie');
            console.log(`[Supplier Stocks] Saving to PostgreSQL: supplier=${supplier} (normalized: ${normalizedSupplier}), sku=${sku}, stock=${stockData.stock}, price=${stockData.price}`);
            await supplierStocksService.default.upsert(normalizedSupplier, sku, {
              stock: stockData.stock || 0,
              price: stockData.price || null,
              deliveryDays: stockData.deliveryDays || stockData.delivery_days || 0,
              stockName: stockData.stockName || stockData.stock_name || null,
              source: 'api',
              warehouses: stockData.warehouses || null,
              cached_at: new Date()
            });
            console.log(`[Supplier Stocks] ✓ Successfully saved to PostgreSQL: supplier=${normalizedSupplier}, sku=${sku}`);
          } else {
            console.warn(`[Supplier Stocks] Product not found for SKU: ${sku}, cannot save stock data`);
          }
        } catch (error) {
          console.error(`[Supplier Stocks] Error saving to PostgreSQL for ${supplier}:${sku}:`, error.message);
          console.error('[Supplier Stocks] Error stack:', error.stack);
        }
      }
      
      // Файловый кэш (для обратной совместимости)
      try {
        const stockCache = await readData('supplierStockCache') || {};
        if (!stockCache[supplier]) stockCache[supplier] = {};
        stockCache[supplier][sku] = stockData;
        await writeData('supplierStockCache', stockCache);
      } catch (error) {
        console.error('[Supplier Stocks] Error saving to file cache:', error.message);
      }
    }

    // 3. Фильтрация по складам, если заданы города
    if (warehouseCities.length > 0 && Array.isArray(stockData.warehouses)) {
      logger.info(`[Supplier Stocks] Filtering warehouses for ${supplier}:${sku}`);
      logger.info(`[Supplier Stocks] Required warehouses: ${warehouseCities.join(', ')}`);
      logger.info(`[Supplier Stocks] Available warehouses: ${stockData.warehouses.map(w => `${w.city || w.name} (stock=${w.stock}, days=${w.deliveryDays})`).join(', ')}`);
      
      // Пробуем точное совпадение и нечеткое (регистронезависимое, с пробелами)
      const filtered = stockData.warehouses.filter(w => {
        const warehouseName = (w.city || w.name || '').trim();
        logger.debug(`[Supplier Stocks] Checking warehouse: "${warehouseName}"`);
        let matches = false;
        
        // 1. Точное совпадение
        matches = warehouseCities.some(req => {
          const match = req.trim() === warehouseName;
          if (match) logger.info(`[Supplier Stocks] ✓ Exact match: "${req.trim()}" === "${warehouseName}"`);
          return match;
        });
        
        // 2. Нечеткое совпадение (регистронезависимое)
        if (!matches) {
          matches = warehouseCities.some(req => {
            const match = req.trim().toLowerCase() === warehouseName.toLowerCase();
            if (match) logger.info(`[Supplier Stocks] ✓ Case-insensitive match: "${req.trim()}" === "${warehouseName}"`);
            return match;
          });
        }
        
        // 3. Проверяем, содержит ли название склада требуемое название (или наоборот)
        if (!matches) {
          matches = warehouseCities.some(req => {
            const reqLower = req.trim().toLowerCase();
            const nameLower = warehouseName.toLowerCase();
            // Убираем лишние пробелы и приводим к единому формату
            const reqNormalized = reqLower.replace(/\s+/g, ' ').trim();
            const nameNormalized = nameLower.replace(/\s+/g, ' ').trim();
            const match = nameNormalized.includes(reqNormalized) || reqNormalized.includes(nameNormalized);
            if (match) logger.info(`[Supplier Stocks] ✓ Substring match: "${reqNormalized}" in "${nameNormalized}"`);
            return match;
          });
        }
        
        // 4. Проверяем частичные совпадения (например, "ЮГ" должно совпадать с "ЮГ Москва", "Юг", "Южный" и т.д.)
        if (!matches) {
          matches = warehouseCities.some(req => {
            const reqLower = req.trim().toLowerCase();
            const nameLower = warehouseName.toLowerCase();
            // Если требуемое название короткое (2-3 символа), проверяем как подстроку
            if (reqLower.length <= 3) {
              if (nameLower.includes(reqLower) || reqLower.includes(nameLower)) {
                logger.info(`[Supplier Stocks] ✓ Short match: "${reqLower}" in "${nameLower}"`);
                return true;
              }
            }
            // Разбиваем на слова и проверяем совпадение хотя бы одного слова
            const reqWords = reqLower.split(/\s+/).filter(w => w.length >= 2); // Включаем слова от 2 символов
            const nameWords = nameLower.split(/\s+/).filter(w => w.length >= 2);
            const wordMatch = reqWords.some(rw => nameWords.some(nw => nw.includes(rw) || rw.includes(nw)));
            if (wordMatch) {
              logger.info(`[Supplier Stocks] ✓ Word match: "${reqLower}" with "${nameLower}"`);
            }
            return wordMatch;
          });
        }
        
        if (matches) {
          logger.info(`[Supplier Stocks] ✓ Warehouse "${warehouseName}" matches filter`);
        }
        return matches;
      });

      // Если после фильтрации нет данных, возвращаем null (строгая фильтрация)
      if (filtered.length === 0) {
        logger.warn(`[Supplier Stocks] ✗ No warehouses match filter for ${supplier}:${sku}`);
        logger.warn(`[Supplier Stocks] Required warehouses: ${warehouseCities.join(', ')}`);
        logger.warn(`[Supplier Stocks] Available warehouses from API: ${stockData.warehouses.map(w => w.city || w.name).join(', ')}`);
        logger.warn(`[Supplier Stocks] ⚠️ WARNING: No matches found. Returning null (strict filtering).`);
        logger.info(`[Supplier Stocks] 💡 Tip: Update supplier config with correct warehouse names from the list above.`);
        return null;
      }

      logger.info(`[Supplier Stocks] ✓ ${filtered.length} warehouse(s) match filter`);

      const stock = filtered.reduce((sum, w) => sum + (w.stock || 0), 0);
      const deliveryDays = Math.min(
        ...filtered.map(w =>
          w.deliveryDays !== undefined && w.deliveryDays !== null
            ? w.deliveryDays
            : 999
        )
      );

      stockData = {
        ...stockData,
        warehouses: filtered,
        stock,
        deliveryDays
      };
    }

    // 4. Применяем настройки по срокам доставки (sameDayDelivery)
    const sameDayDelivery = supplierConfig?.sameDayDelivery;
    if (sameDayDelivery) {
      if (stockData.deliveryDays > 0) {
        console.log(`[Supplier Stocks] Excluding ${supplier}:${sku} - deliveryDays=${stockData.deliveryDays} (sameDayDelivery=true requires 0 days)`);
        return {
          supplier,
          sku,
          stock: 0,
          stockName: stockData.stockName,
          deliveryDays: stockData.deliveryDays,
          price: stockData.price,
          excluded: true,
          reason: `Срок доставки ${stockData.deliveryDays} дней (требуется 0 дней)`,
          timestamp: new Date().toISOString()
        };
      }
    } else if (stockData.deliveryDays > 1) {
      console.log(`[Supplier Stocks] Excluding ${supplier}:${sku} - deliveryDays=${stockData.deliveryDays} (exceeds 1 day)`);
      return {
        supplier,
        sku,
        stock: 0,
        stockName: stockData.stockName,
        deliveryDays: stockData.deliveryDays,
        price: stockData.price,
        excluded: true,
        reason: `Срок доставки ${stockData.deliveryDays} дней превышает 1 день`,
        timestamp: new Date().toISOString()
      };
    }

    const result = {
      supplier,
      sku,
      stock: stockData.stock,
      stockName: stockData.stockName,
      deliveryDays: stockData.deliveryDays,
      price: stockData.price,
      timestamp: new Date().toISOString()
    };

    if (Array.isArray(stockData.warehouses)) {
      result.warehouses = stockData.warehouses;
    }

    return result;
  }

  /**
   * Массовая синхронизация остатков (аналог /api/sync-supplier-stocks).
   * Обновляет supplierStockCache и возвращает статистику.
   */
  async syncSupplierStocks(products) {
    if (!products || !Array.isArray(products)) {
      const err = new Error('Список товаров не предоставлен');
      err.statusCode = 400;
      throw err;
    }

    const results = {
      mikado: { success: 0, failed: 0, details: [] },
      moskvorechie: { success: 0, failed: 0, details: [] }
    };

    const stockCache = {
      mikado: {},
      moskvorechie: {}
    };

    // Mikado
    for (const product of products) {
      if (!product.sku) continue;
      try {
        const mikadoStock = await getMikadoStock(product.sku, product.brand);
        if (mikadoStock) {
          results.mikado.success++;
          results.mikado.details.push({
            sku: product.sku,
            stock: mikadoStock.stock,
            deliveryDays: mikadoStock.deliveryDays,
            price: mikadoStock.price
          });
          stockCache.mikado[product.sku] = mikadoStock;
        } else {
          results.mikado.failed++;
        }
      } catch (error) {
        results.mikado.failed++;
        console.error('[Mikado Stock] Error for SKU', product.sku, error);
      }
    }

    // Moskvorechie
    for (const product of products) {
      if (!product.sku) continue;
      try {
        const moskvorechieStock = await getMoskvorechieStock(product.sku);
        if (moskvorechieStock) {
          results.moskvorechie.success++;
          results.moskvorechie.details.push({
            sku: product.sku,
            stock: moskvorechieStock.stock,
            deliveryDays: moskvorechieStock.deliveryDays,
            price: moskvorechieStock.price
          });
          stockCache.moskvorechie[product.sku] = moskvorechieStock;
        } else {
          results.moskvorechie.failed++;
        }
      } catch (error) {
        results.moskvorechie.failed++;
        console.error('[Moskvorechie Stock] Error for SKU', product.sku, error);
      }
    }

    // Сохраняем в кэш
    // PostgreSQL кэш
    if (repositoryFactory.isUsingPostgreSQL()) {
      try {
        const supplierStocksService = await import('./supplier_stocks.service.js');
        for (const product of products) {
          if (!product.sku) continue;
          
          const productRecord = await productsService.getBySku(product.sku);
          if (!productRecord) continue;
          
          // Mikado
          if (stockCache.mikado[product.sku]) {
            await supplierStocksService.default.upsert('mikado', product.sku, {
              stock: stockCache.mikado[product.sku].stock || 0,
              price: stockCache.mikado[product.sku].price || null,
              deliveryDays: stockCache.mikado[product.sku].deliveryDays || 0,
              stockName: stockCache.mikado[product.sku].stockName || null,
              source: 'api',
              warehouses: stockCache.mikado[product.sku].warehouses || null,
              cached_at: new Date()
            });
          }
          
          // Moskvorechie
          if (stockCache.moskvorechie[product.sku]) {
            await supplierStocksService.default.upsert('moskvorechie', product.sku, {
              stock: stockCache.moskvorechie[product.sku].stock || 0,
              price: stockCache.moskvorechie[product.sku].price || null,
              deliveryDays: stockCache.moskvorechie[product.sku].deliveryDays || 0,
              stockName: stockCache.moskvorechie[product.sku].stockName || null,
              source: 'api',
              warehouses: stockCache.moskvorechie[product.sku].warehouses || null,
              cached_at: new Date()
            });
          }
        }
      } catch (error) {
        console.error('[Supplier Stocks] Error saving to PostgreSQL:', error.message);
      }
    }
    
    // Файловый кэш (для обратной совместимости)
    await writeData('supplierStockCache', stockCache);

    return {
      message: 'Синхронизация остатков завершена',
      results,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Получить список складов поставщика с доставкой 0–1 день
   * (аналог /api/supplier-warehouses).
   */
  async getSupplierWarehouses(supplier) {
    if (!supplier) {
      const err = new Error('Поставщик не указан');
      err.statusCode = 400;
      throw err;
    }

    if (supplier === 'mikado') {
      const warehouses = await getMikadoWarehouses();
      return { warehouses };
    }
    if (supplier === 'moskvorechie') {
      const warehouses = await getMoskvorechieWarehouses();
      return { warehouses };
    }

    const err = new Error('Неподдерживаемый поставщик');
    err.statusCode = 400;
    throw err;
  }
}

// ===== Helpers (упрощённый перенос из монолита) =====

async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error?.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  }
}

async function getMikadoStock(sku, brand = '', config = null) {
  try {
    const mikadoConfig = config || await integrationsService.getSupplierConfig('mikado');
    console.log(`[Mikado Stock] Config check:`, {
      hasConfig: !!mikadoConfig,
      hasUserId: !!mikadoConfig?.user_id,
      hasPassword: !!mikadoConfig?.password,
      configKeys: mikadoConfig ? Object.keys(mikadoConfig) : []
    });
    if (!mikadoConfig || !mikadoConfig.user_id || !mikadoConfig.password) {
      console.log('[Mikado Stock] No credentials configured');
      return null;
    }

    const url = `http://mikado-parts.ru/ws1/service.asmx/CodeBrandStockInfo?Code=${encodeURIComponent(
      sku
    )}&Brand=${encodeURIComponent(
      brand || ''
    )}&ClientID=${encodeURIComponent(
      mikadoConfig.user_id
    )}&Password=${encodeURIComponent(mikadoConfig.password)}`;

    console.log('[Mikado Stock] Request:', url);

    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/xml, text/xml, */*' }
      },
      15000
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xmlText = await response.text();

    let stockMatch =
      xmlText.match(/<StockQTY>(\d+)<\/StockQTY>/i) ||
      xmlText.match(/<Stock>(\d+)<\/Stock>/i) ||
      xmlText.match(/<Quantity>(\d+)<\/Quantity>/i) ||
      xmlText.match(/<StockQuantity>(\d+)<\/StockQuantity>/i) ||
      xmlText.match(/<Qty>(\d+)<\/Qty>/i) ||
      xmlText.match(/quantity="(\d+)"/i);

    let priceMatch =
      xmlText.match(/<PriceRUR>([\d.]+)<\/PriceRUR>/i) ||
      xmlText.match(/<Price>([\d.]+)<\/Price>/i) ||
      xmlText.match(/<PriceRub>([\d.]+)<\/PriceRub>/i) ||
      xmlText.match(/<Cost>([\d.]+)<\/Cost>/i);

    let deliveryMatch =
      xmlText.match(/<DeliveryDelay>(\d+)<\/DeliveryDelay>/i) ||
      xmlText.match(/<DeliveryDays>(\d+)<\/DeliveryDays>/i) ||
      xmlText.match(/<Delivery>(\d+)<\/Delivery>/i) ||
      xmlText.match(/<Days>(\d+)<\/Days>/i);

    if (!stockMatch) {
      console.log('[Mikado Stock] No stock data in XML for', sku);
      return null;
    }

    const stock = parseInt(stockMatch[1], 10) || 0;
    const price = priceMatch ? parseFloat(priceMatch[1]) : 0;
    const deliveryDays = deliveryMatch ? parseInt(deliveryMatch[1], 10) : 3;

    return {
      stock,
      stockName: 'Склад Mikado',
      deliveryDays,
      price,
      source: 'api'
    };
  } catch (error) {
    console.error('[Mikado Stock] Error:', error);
    return null;
  }
}

async function getMoskvorechieStock(sku, config = null) {
  try {
    console.log(`[Moskvorechie Stock] Fetching stock for SKU: ${sku}`);
    const moskvorechieConfig = config || await integrationsService.getSupplierConfig('moskvorechie');
    console.log(`[Moskvorechie Stock] Config check:`, {
      hasConfig: !!moskvorechieConfig,
      hasUserId: !!moskvorechieConfig?.user_id,
      hasApiKey: !!moskvorechieConfig?.apiKey,
      hasPassword: !!moskvorechieConfig?.password,
      configKeys: moskvorechieConfig ? Object.keys(moskvorechieConfig) : []
    });
    if (!moskvorechieConfig || !moskvorechieConfig.user_id || (!moskvorechieConfig.apiKey && !moskvorechieConfig.password)) {
      console.log('[Moskvorechie Stock] No credentials configured');
      return null;
    }
    console.log(`[Moskvorechie Stock] Credentials found, user_id: ${moskvorechieConfig.user_id}`);

    const apiKey = moskvorechieConfig.apiKey || moskvorechieConfig.password;
    const url = `http://portal.moskvorechie.ru/portal.api?l=${encodeURIComponent(
      moskvorechieConfig.user_id
    )}&p=${encodeURIComponent(
      apiKey
    )}&act=price_by_nr_firm&v=1&nr=${encodeURIComponent(
      sku
    )}&f=&cs=utf8&avail&extstor`;

    console.log('[Moskvorechie Stock] Request:', url);

    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json, application/xml, text/xml, */*' }
      },
      15000
    );

    if (!response.ok) {
      console.error(`[Moskvorechie Stock] API error: HTTP ${response.status}: ${response.statusText}`);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const responseText = await response.text();
    console.log(`[Moskvorechie Stock] API response length: ${responseText.length} chars`);
    if (responseText.length < 500) {
      console.log(`[Moskvorechie Stock] API response preview: ${responseText.substring(0, 500)}`);
    }

    // Пытаемся как JSON
    try {
      const data = JSON.parse(responseText);

      if (data?.result && Array.isArray(data.result)) {
        logger.info(`[Moskvorechie Stock] API returned ${data.result.length} results for SKU ${sku}`);
        if (data.result.length === 0) {
          logger.info('[Moskvorechie Stock] Empty result for', sku);
          return null;
        }
        // Логируем все склады из API
        const allWarehouseNames = data.result.map(item => item.sname || 'N/A');
        logger.info(`[Moskvorechie Stock] All warehouse names from API: ${allWarehouseNames.join(', ')}`);
        logger.info(`[Moskvorechie Stock] Full API response: ${JSON.stringify(data.result.map(item => ({ sname: item.sname, stock: item.stock, ddays: item.ddays })), null, 2)}`);

        const warehouses = [];
        let totalStock = 0;
        let minDeliveryDays = 999;
        let firstPrice = 0;

        for (const item of data.result) {
          const itemStock = parseInt(item.stock, 10) || 0;
          const itemDeliveryDays =
            item.ddays !== undefined && item.ddays !== null
              ? parseInt(item.ddays, 10)
              : 5;
          const itemPrice = parseFloat(item.price) || 0;
          const city = item.sname || 'Неизвестно';

          logger.info(`[Moskvorechie Stock] Processing warehouse: "${city}", stock=${itemStock}, days=${itemDeliveryDays}`);

          warehouses.push({
            city,
            stock: itemStock,
            deliveryDays: itemDeliveryDays,
            price: itemPrice
          });

          totalStock += itemStock;
          if (itemDeliveryDays < minDeliveryDays) {
            minDeliveryDays = itemDeliveryDays;
          }
          if (itemPrice > 0 && firstPrice === 0) {
            firstPrice = itemPrice;
          }
        }

        const stock = totalStock;
        const price = firstPrice;
        const deliveryDays = minDeliveryDays === 999 ? 5 : minDeliveryDays;

        logger.info(`[Moskvorechie Stock] For SKU ${sku}: stock=${stock}, price=${price}, deliveryDays=${deliveryDays}, warehouses=${warehouses.length}`);
        logger.info(`[Moskvorechie Stock] Warehouse names: ${warehouses.map(w => w.city).join(', ')}`);
        logger.info(`[Moskvorechie Stock] All warehouses details: ${JSON.stringify(warehouses.map(w => ({ name: w.city, stock: w.stock })), null, 2)}`);

        if (stock > 0 || price > 0) {
          const result = {
            stock,
            stockName: 'Склад Moskvorechie',
            deliveryDays,
            price,
            source: 'api'
          };
          if (warehouses.length > 0) {
            result.warehouses = warehouses;
          }
          return result;
        }
        console.log(`[Moskvorechie Stock] No stock or price for SKU ${sku}, returning null`);
        return null;
      }
    } catch (jsonError) {
      console.log(`[Moskvorechie Stock] Not JSON format, trying XML. Error: ${jsonError.message}`);
      // не JSON — попробуем XML
    }

    // XML / текстовый формат
    let stockMatch =
      responseText.match(/<avail>(\d+)<\/avail>/i) ||
      responseText.match(/<quantity>(\d+)<\/quantity>/i) ||
      responseText.match(/<qty>(\d+)<\/qty>/i) ||
      responseText.match(/quantity="(\d+)"/i);

    const priceMatch =
      responseText.match(/<price>([\d.]+)<\/price>/i) ||
      responseText.match(/<priceRub>([\d.]+)<\/priceRub>/i);

    const deliveryMatch =
      responseText.match(/<delivery_days>(\d+)<\/delivery_days>/i) ||
      responseText.match(/<delivery>(\d+)<\/delivery>/i);

    if (!stockMatch) {
      console.log('[Moskvorechie Stock] No stock data for', sku);
      return null;
    }

    const stock = parseInt(stockMatch[1], 10) || 0;
    const price = priceMatch ? parseFloat(priceMatch[1]) : 0;
    const deliveryDays = deliveryMatch ? parseInt(deliveryMatch[1], 10) : 5;

    return {
      stock,
      stockName: 'Склад Moskvorechie',
      deliveryDays,
      price,
      source: 'api'
    };
  } catch (error) {
    console.error('[Moskvorechie Stock] Error:', error);
    return null;
  }
}

async function getMikadoWarehouses() {
  try {
    const mikadoConfig = await integrationsService.getSupplierConfig('mikado');
    if (!mikadoConfig || !mikadoConfig.user_id || !mikadoConfig.password) {
      console.log('[Mikado Warehouses] No credentials configured');
      return [];
    }

    // берём любой товар для запроса списка складов
    let products = [];
    try {
      products = await readData('products');
      if (!Array.isArray(products)) products = [];
    } catch {
      products = [];
    }

    let testSku = 'AN1048';
    let testBrand = 'Nordfil';

    if (products.length > 0) {
      const firstProduct = products[0];
      testSku = firstProduct.sku || testSku;
      testBrand = firstProduct.brand || testBrand;
    }

    const url = `http://mikado-parts.ru/ws1/service.asmx/CodeBrandStockInfo?Code=${testSku}&Brand=${testBrand}&ClientID=${mikadoConfig.user_id}&Password=${mikadoConfig.password}`;

    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/xml, text/xml, */*' }
      },
      15000
    );

    if (!response.ok) {
      console.log('[Mikado Warehouses] API not available');
      return [];
    }

    const xmlText = await response.text();

    const warehouseMatches = xmlText.matchAll(
      /<CodeBrandLine>([\s\S]*?)<\/CodeBrandLine>/gi
    );
    const warehouses = [];
    const seen = new Set();

    for (const match of warehouseMatches) {
      const itemXml = match[1];
      const nameMatch = itemXml.match(/<StokName>(.*?)<\/StokName>/i);
      const delayMatch = itemXml.match(/<DeliveryDelay>(\d+)<\/DeliveryDelay>/i);

      if (nameMatch && delayMatch) {
        const name = nameMatch[1].trim();
        const delay = parseInt(delayMatch[1], 10);
        if ((delay === 0 || delay === 1) && !seen.has(name)) {
          warehouses.push({ name, deliveryDays: delay });
          seen.add(name);
        }
      }
    }

    return warehouses;
  } catch (error) {
    console.error('[Mikado Warehouses] Error:', error);
    return [];
  }
}

async function getMoskvorechieWarehouses() {
  try {
    const moskvorechieConfig = await integrationsService.getSupplierConfig('moskvorechie');
    if (!moskvorechieConfig || !moskvorechieConfig.user_id || (!moskvorechieConfig.apiKey && !moskvorechieConfig.password)) {
      console.log('[Moskvorechie Warehouses] No credentials configured');
      return [];
    }

    let products = [];
    try {
      products = await readData('products');
      if (!Array.isArray(products)) products = [];
    } catch {
      products = [];
    }

    let testSku = 'E400049';
    if (products.length > 0) {
      const firstProduct = products.find(
        p => p.sku && p.view && p.view.model && p.view.model.article
      );
      if (firstProduct) {
        testSku = firstProduct.view.model.article;
      }
    }

    const apiKey = moskvorechieConfig.apiKey || moskvorechieConfig.password;
    const url = `http://portal.moskvorechie.ru/portal.api?l=${encodeURIComponent(
      moskvorechieConfig.user_id
    )}&p=${encodeURIComponent(
      apiKey
    )}&act=price_by_nr_firm&v=1&nr=${encodeURIComponent(
      testSku
    )}&f=&cs=utf8&avail&extstor`;

    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json, application/xml, text/xml, */*' }
      },
      15000
    );

    if (!response.ok) {
      console.log('[Moskvorechie Warehouses] API not available');
      return [];
    }

    const responseText = await response.text();

    try {
      const data = JSON.parse(responseText);
      if (data?.result && Array.isArray(data.result)) {
        const warehouses = [];
        const seen = new Set();
        for (const item of data.result) {
          const name = item.sname;
          const delay = parseInt(item.ddays, 10) || 5;
          if ((delay === 0 || delay === 1) && name && !seen.has(name)) {
            warehouses.push({ name, deliveryDays: delay });
            seen.add(name);
          }
        }
        return warehouses;
      }
    } catch {
      // не JSON — пропускаем
    }

    return [];
  } catch (error) {
    console.error('[Moskvorechie Warehouses] Error:', error);
    return [];
  }
}

const supplierStocksService = new SupplierStocksService();

export default supplierStocksService;

