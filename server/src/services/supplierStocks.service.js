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
import { getCache, setCache, deleteCache } from '../config/redis.js';
import logger from '../utils/logger.js';
import { portalCredentialsFromConfig } from './supplierOrderAdapters/moskvorechie.adapter.js';

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

    const apiSupplierCode = canonicalSupplierApiCode(supplier);

    // Получаем конфигурацию поставщика
    // Сначала пробуем получить из таблицы suppliers (новый способ)
    let supplierConfig = null;
    if (repositoryFactory.isUsingPostgreSQL()) {
      try {
        const suppliersService = await import('./suppliers.service.js');
        const supplierData = await suppliersService.default.getByCode(supplier);
        logger.info(`[Supplier Stocks] Supplier data from DB for ${supplier} (api: ${apiSupplierCode}): ${JSON.stringify(supplierData, null, 2)}`);
        if (supplierData && supplierData.apiConfig) {
          supplierConfig = supplierData.apiConfig;
          logger.info(`[Supplier Stocks] apiConfig for ${supplier}: ${JSON.stringify(supplierConfig, null, 2)}`);
        }
      } catch (e) {
        logger.error('[Supplier Stocks] Error getting supplier from suppliers table:', e.message);
      }
    }
    
    // Если не нашли в suppliers или нет учётных данных — integrations (+ файл data/*.json)
    if (!supplierConfig || (!supplierConfig.user_id && !supplierConfig.password && !supplierConfig.apiKey)) {
      try {
        const integrationsConfig = await integrationsService.getSupplierConfig(apiSupplierCode);
        logger.info(`[Supplier Stocks] Config from integrations for ${apiSupplierCode}: ${JSON.stringify(integrationsConfig, null, 2)}`);
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
      // 1. Redis
      const redisKey = `supplier_stock:${apiSupplierCode}:${sku}`;
      stockData = await getCache(redisKey);
      if (stockData) {
        logger.info(`[Supplier Stocks] Got from Redis cache for ${apiSupplierCode}:${sku}`);
      }

    // 2. PostgreSQL supplier_stocks
    if (!stockData && repositoryFactory.isUsingPostgreSQL()) {
      try {
        const supplierStocksService = await import('./supplier_stocks.service.js');
        const stockRecord = await supplierStocksService.default.getBySupplierAndProduct(apiSupplierCode, sku);
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
            
            const redisKey = `supplier_stock:${apiSupplierCode}:${sku}`;
            await setCache(redisKey, stockData, 3600);
          }
        }
      } catch (error) {
        logger.error('[Supplier Stocks] Error getting from PostgreSQL:', error.message);
      }
    }

    // 3. Файловый кэш (legacy; при PostgreSQL — только supplier_stocks, файл часто битый при параллельных записях)
    if (!stockData && !repositoryFactory.isUsingPostgreSQL()) {
      try {
        const stockCache = await readData('supplierStockCache');
        const supplierCache = stockCache?.[apiSupplierCode] || stockCache?.[supplier] || {};
        if (supplierCache[sku]) {
          stockData = supplierCache[sku];
        }
      } catch (error) {
        logger.error('[Supplier Stocks] Error reading file cache:', error.message);
      }
    }

    // Старый кэш Mikado хранил только первый склад — перезапрашиваем API
    if (apiSupplierCode === 'mikado' && stockData && !Array.isArray(stockData.warehouses)) {
      logger.info(`[Supplier Stocks] Stale Mikado cache (no warehouses) for ${sku}, refreshing from API`);
      stockData = null;
    }
    }

    // 4. Если нет в кэше или forceRefresh = true – получаем из API
    if (!stockData) {
      if (apiSupplierCode === 'mikado') {
        stockData = await getMikadoStock(sku, brand, supplierConfig);
      } else if (apiSupplierCode === 'moskvorechie') {
        stockData = await getMoskvorechieStock(sku, supplierConfig);
      } else {
        const err = new Error(`Неподдерживаемый поставщик: ${supplier}`);
        err.statusCode = 400;
        throw err;
      }

      // Если данных нет — обнуляем кэш (иначе остаётся устаревший stock>0 до 24 ч)
      if (!stockData) {
        await this._markSupplierStockEmpty(apiSupplierCode, supplier, sku);
        return null;
      }

      const redisKey = `supplier_stock:${apiSupplierCode}:${sku}`;
      await setCache(redisKey, stockData, 3600);
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
        await this._markSupplierStockEmpty(apiSupplierCode, supplier, sku);
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
        await this._persistSupplierStockToCaches(apiSupplierCode, supplier, sku, {
          stock: 0,
          stockName: stockData.stockName,
          deliveryDays: stockData.deliveryDays,
          price: stockData.price,
          source: 'api',
          warehouses: stockData.warehouses || null
        });
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
      await this._persistSupplierStockToCaches(apiSupplierCode, supplier, sku, {
        stock: 0,
        stockName: stockData.stockName,
        deliveryDays: stockData.deliveryDays,
        price: stockData.price,
        source: 'api',
        warehouses: stockData.warehouses || null
      });
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

    await this._persistSupplierStockToCaches(apiSupplierCode, supplier, sku, stockData);

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

  /** Обнулить кэш поставщика, когда API не вернул остаток (товара нет у поставщика). */
  async _markSupplierStockEmpty(apiSupplierCode, supplier, sku) {
    const empty = {
      stock: 0,
      stockName: `Склад ${supplier}`,
      deliveryDays: 0,
      price: null,
      source: 'api',
      warehouses: null
    };
    try {
      const redisKey = `supplier_stock:${apiSupplierCode}:${sku}`;
      await deleteCache(redisKey);
    } catch (e) {
      logger.error('[Supplier Stocks] Redis clear error:', e.message);
    }
    if (repositoryFactory.isUsingPostgreSQL()) {
      try {
        const supplierStocksPg = await import('./supplier_stocks.service.js');
        const product = await productsService.getBySku(sku);
        if (product) {
          await supplierStocksPg.default.upsert(apiSupplierCode, sku, {
            ...empty,
            cached_at: new Date()
          });
        }
      } catch (error) {
        logger.error(`[Supplier Stocks] PostgreSQL zero-stock save for ${supplier}:${sku}:`, error.message);
      }
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      try {
        const stockCache = (await readData('supplierStockCache')) || {};
        if (stockCache[apiSupplierCode]?.[sku]) {
          delete stockCache[apiSupplierCode][sku];
          await writeData('supplierStockCache', stockCache);
        }
      } catch (error) {
        logger.error('[Supplier Stocks] File cache clear error:', error.message);
      }
    }
  }

  /** Сохранить остаток в PostgreSQL и файловый кэш (после фильтрации по складам). */
  async _persistSupplierStockToCaches(apiSupplierCode, supplier, sku, stockData) {
    if (!stockData) return;
    try {
      const redisKey = `supplier_stock:${apiSupplierCode}:${sku}`;
      await setCache(redisKey, stockData, 3600);
    } catch (e) {
      logger.error('[Supplier Stocks] Redis save error:', e.message);
    }
    if (repositoryFactory.isUsingPostgreSQL()) {
      try {
        const supplierStocksPg = await import('./supplier_stocks.service.js');
        const product = await productsService.getBySku(sku);
        if (product) {
          await supplierStocksPg.default.upsert(apiSupplierCode, sku, {
            stock: stockData.stock || 0,
            price: stockData.price || null,
            deliveryDays: stockData.deliveryDays || stockData.delivery_days || 0,
            stockName: stockData.stockName || stockData.stock_name || null,
            source: stockData.source || 'api',
            warehouses: stockData.warehouses || null,
            cached_at: new Date()
          });
        }
      } catch (error) {
        logger.error(`[Supplier Stocks] PostgreSQL save error for ${supplier}:${sku}:`, error.message);
      }
    }
    // При PostgreSQL остатки в supplier_stocks; файл без блокировки портился при параллельных запросах.
    if (!repositoryFactory.isUsingPostgreSQL()) {
      try {
        const stockCache = (await readData('supplierStockCache')) || {};
        if (!stockCache[apiSupplierCode]) stockCache[apiSupplierCode] = {};
        stockCache[apiSupplierCode][sku] = stockData;
        await writeData('supplierStockCache', stockCache);
      } catch (error) {
        logger.error('[Supplier Stocks] File cache save error:', error.message);
      }
    }
  }

  /**
   * Разбивка остатков по поставщикам для списка товаров (из БД supplier_stocks).
   * @param {number[]|string[]} productIds
   */
  async getBreakdownByProductIds(productIds, options = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return [];
    }
    const repo = repositoryFactory.getSupplierStocksRepository();
    if (!repo || typeof repo.findBreakdownByProductIds !== 'function') {
      return [];
    }
    return await repo.findBreakdownByProductIds(productIds, options);
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

    for (const product of products) {
      if (!product.sku) continue;
      for (const code of ['mikado', 'moskvorechie']) {
        try {
          const data = await this.getSupplierStock({
            supplier: code,
            sku: product.sku,
            brand: product.brand,
            forceRefresh: true
          });
          if (data && !data.excluded && (data.stock || 0) > 0) {
            results[code].success++;
            results[code].details.push({
              sku: product.sku,
              stock: data.stock,
              deliveryDays: data.deliveryDays,
              price: data.price
            });
            stockCache[code][product.sku] = data;
          } else {
            results[code].failed++;
          }
        } catch (error) {
          results[code].failed++;
          console.error(`[Supplier Stocks] Sync error ${code} for SKU`, product.sku, error);
        }
      }
    }

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

/** Разбор XML Mikado: остатки по складам (CodeBrandLine), не только первый StockQTY. */
function parseMikadoStockXml(xmlText) {
  const lineMatches = xmlText.matchAll(/<CodeBrandLine>([\s\S]*?)<\/CodeBrandLine>/gi);
  const warehouses = [];

  for (const match of lineMatches) {
    const itemXml = match[1];
    const nameMatch = itemXml.match(/<StokName>(.*?)<\/StokName>/i);
    const stockMatch =
      itemXml.match(/<StockQTY>(\d+)<\/StockQTY>/i) ||
      itemXml.match(/<Stock>(\d+)<\/Stock>/i) ||
      itemXml.match(/<Quantity>(\d+)<\/Quantity>/i) ||
      itemXml.match(/<StockQuantity>(\d+)<\/StockQuantity>/i) ||
      itemXml.match(/<Qty>(\d+)<\/Qty>/i);
    if (!stockMatch) continue;

    const city = (nameMatch?.[1] || 'Неизвестно').trim();
    const stock = parseInt(stockMatch[1], 10) || 0;
    const deliveryMatch =
      itemXml.match(/<DeliveryDelay>(\d+)<\/DeliveryDelay>/i) ||
      itemXml.match(/<DeliveryDays>(\d+)<\/DeliveryDays>/i) ||
      itemXml.match(/<Delivery>(\d+)<\/Delivery>/i);
    const priceMatch =
      itemXml.match(/<PriceRUR>([\d.]+)<\/PriceRUR>/i) ||
      itemXml.match(/<Price>([\d.]+)<\/Price>/i) ||
      itemXml.match(/<PriceRub>([\d.]+)<\/PriceRub>/i) ||
      itemXml.match(/<Cost>([\d.]+)<\/Cost>/i);

    warehouses.push({
      city,
      name: city,
      stock,
      deliveryDays: deliveryMatch ? parseInt(deliveryMatch[1], 10) : 3,
      price: priceMatch ? parseFloat(priceMatch[1]) : 0
    });
  }

  if (warehouses.length > 0) {
    let totalStock = 0;
    let minDeliveryDays = 999;
    let firstPrice = 0;
    for (const w of warehouses) {
      totalStock += w.stock;
      if (w.deliveryDays < minDeliveryDays) minDeliveryDays = w.deliveryDays;
      if (w.price > 0 && firstPrice === 0) firstPrice = w.price;
    }
    return {
      stock: totalStock,
      stockName: 'Склад Mikado',
      deliveryDays: minDeliveryDays === 999 ? 3 : minDeliveryDays,
      price: firstPrice,
      source: 'api',
      warehouses
    };
  }

  const stockMatch =
    xmlText.match(/<StockQTY>(\d+)<\/StockQTY>/i) ||
    xmlText.match(/<Stock>(\d+)<\/Stock>/i) ||
    xmlText.match(/<Quantity>(\d+)<\/Quantity>/i);
  if (!stockMatch) return null;

  const priceMatch =
    xmlText.match(/<PriceRUR>([\d.]+)<\/PriceRUR>/i) ||
    xmlText.match(/<Price>([\d.]+)<\/Price>/i);
  const deliveryMatch =
    xmlText.match(/<DeliveryDelay>(\d+)<\/DeliveryDelay>/i) ||
    xmlText.match(/<DeliveryDays>(\d+)<\/DeliveryDays>/i);

  return {
    stock: parseInt(stockMatch[1], 10) || 0,
    stockName: 'Склад Mikado',
    deliveryDays: deliveryMatch ? parseInt(deliveryMatch[1], 10) : 3,
    price: priceMatch ? parseFloat(priceMatch[1]) : 0,
    source: 'api'
  };
}

async function getMikadoStock(sku, brand = '', config = null) {
  try {
    const mikadoConfig = config || await integrationsService.getSupplierConfig('mikado');
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
    const parsed = parseMikadoStockXml(xmlText);
    if (!parsed) {
      console.log('[Mikado Stock] No stock data in XML for', sku);
      return null;
    }
    if (parsed.warehouses?.length) {
      logger.info(
        `[Mikado Stock] ${sku}: ${parsed.warehouses.length} warehouse(s), total=${parsed.stock}: ${parsed.warehouses.map((w) => `${w.city}=${w.stock}`).join(', ')}`
      );
    }
    return parsed;
  } catch (error) {
    console.error('[Mikado Stock] Error:', error);
    return null;
  }
}

async function getMoskvorechieStock(sku, config = null) {
  try {
    console.log(`[Moskvorechie Stock] Fetching stock for SKU: ${sku}`);
    const moskvorechieConfig = config || await integrationsService.getSupplierConfig('moskvorechie');
    const portalCreds = portalCredentialsFromConfig(moskvorechieConfig);
    console.log(`[Moskvorechie Stock] Config check:`, {
      hasConfig: !!moskvorechieConfig,
      hasUserId: !!portalCreds.userId,
      hasPortalApiKey: !!portalCreds.apiKey,
      configKeys: moskvorechieConfig ? Object.keys(moskvorechieConfig) : []
    });
    if (!moskvorechieConfig || !portalCreds.userId || !portalCreds.apiKey) {
      console.log('[Moskvorechie Stock] No portal.api credentials configured (User ID + Portal API Key)');
      return null;
    }
    console.log(`[Moskvorechie Stock] Credentials found, user_id: ${portalCreds.userId}`);

    const url = `http://portal.moskvorechie.ru/portal.api?l=${encodeURIComponent(
      portalCreds.userId
    )}&p=${encodeURIComponent(
      portalCreds.apiKey
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
    const portalCreds = portalCredentialsFromConfig(moskvorechieConfig || {});
    if (!moskvorechieConfig || !portalCreds.userId || !portalCreds.apiKey) {
      console.log('[Moskvorechie Warehouses] No portal.api credentials configured');
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

    const url = `http://portal.moskvorechie.ru/portal.api?l=${encodeURIComponent(
      portalCreds.userId
    )}&p=${encodeURIComponent(
      portalCreds.apiKey
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

