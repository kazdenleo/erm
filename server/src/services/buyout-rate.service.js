/**
 * Buyout Rate Service
 * Сервис для получения и синхронизации процента выкупа товаров с маркетплейсов
 */

import integrationsService from './integrations.service.js';
import productsService from './products.service.js';
import { query } from '../config/database.js';

class BuyoutRateService {
  /**
   * Получить процент выкупа товара с Ozon
   * @param {string} offer_id - SKU товара на Ozon
   * @returns {Promise<number|null>} - Процент выкупа (0-100) или null, если не удалось получить
   */
  async getOzonBuyoutRate(offer_id) {
    try {
      const integrations = await integrationsService.getAll();
      const ozonIntegration = integrations.find(i => i.code === 'ozon');
      const client_id = ozonIntegration?.config?.client_id;
      const api_key = ozonIntegration?.config?.api_key;
      
      if (!client_id || !api_key) {
        console.warn(`[Buyout Rate Service] Ozon credentials not found`);
        return null;
      }

      // Пытаемся получить данные из API аналитики Ozon
      // API v1/analytics/data - для получения аналитики по товарам
      try {
        const response = await fetch('https://api-seller.ozon.ru/v1/analytics/data', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Client-Id': String(client_id),
            'Api-Key': String(api_key)
          },
          body: JSON.stringify({
            date_from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Последние 30 дней
            date_to: new Date().toISOString().split('T')[0],
            dimension: ['sku'],
            metrics: ['ordered_units', 'delivered_units', 'revenue', 'returns'], // Заказано, доставлено, выручка, возвраты
            filters: [
              {
                key: 'sku',
                operation: '=',
                value: offer_id
              }
            ]
          }),
          timeout: 10000
        });

        if (response.ok) {
          const data = await response.json();
          console.log(`[Buyout Rate Service] Ozon analytics response for ${offer_id}:`, JSON.stringify(data, null, 2));
          
          // Обработка ответа аналитики
          if (!data.result) {
            console.warn(`[Buyout Rate Service] ⚠ Ozon API response has no 'result' field for ${offer_id}`);
            console.warn(`[Buyout Rate Service] Full response:`, JSON.stringify(data, null, 2));
          } else if (!data.result.data) {
            console.warn(`[Buyout Rate Service] ⚠ Ozon API response has no 'result.data' field for ${offer_id}`);
            console.warn(`[Buyout Rate Service] Result object:`, JSON.stringify(data.result, null, 2));
          } else if (!Array.isArray(data.result.data) || data.result.data.length === 0) {
            console.warn(`[Buyout Rate Service] ⚠ Ozon API returned empty data array for ${offer_id}`);
            console.warn(`[Buyout Rate Service] Data array length:`, data.result.data?.length || 0);
            console.warn(`[Buyout Rate Service] This might mean the product has no sales data in the last 30 days`);
          }
          
          if (data.result && data.result.data && data.result.data.length > 0) {
            const item = data.result.data[0];
            const ordered = item.metrics?.ordered_units || 0;
            const delivered = item.metrics?.delivered_units || 0;
            const returns = item.metrics?.returns || 0;
            
            console.log(`[Buyout Rate Service] Ozon analytics for ${offer_id}:`, {
              ordered,
              delivered,
              returns,
              metrics: item.metrics
            });
            
            // Расчет процента выкупа: Продажи / (Продажи + Возвраты) * 100
            // Если есть данные о возвратах, используем формулу: delivered / (delivered + returns)
            // Иначе используем: delivered / ordered
            let buyoutRate = null;
            
            if (delivered > 0 && returns >= 0) {
              // Если есть данные о возвратах, используем формулу: Продажи / (Продажи + Возвраты)
              const total = delivered + returns;
              if (total > 0) {
                buyoutRate = Math.round((delivered / total) * 100);
                console.log(`[Buyout Rate Service] ✓ Ozon buyout rate for ${offer_id}: ${buyoutRate}% (${delivered} продано / ${total} всего, возвратов: ${returns})`);
              } else if (delivered > 0 && returns === 0) {
                // Если нет возвратов, процент выкупа = 100%
                buyoutRate = 100;
                console.log(`[Buyout Rate Service] ✓ Ozon buyout rate for ${offer_id}: ${buyoutRate}% (${delivered} продано, возвратов нет)`);
              }
            } else if (ordered > 0 && delivered > 0) {
              // Если нет данных о возвратах, используем delivered / ordered
              buyoutRate = Math.round((delivered / ordered) * 100);
              console.log(`[Buyout Rate Service] ✓ Ozon buyout rate for ${offer_id}: ${buyoutRate}% (${delivered}/${ordered}, возвраты не указаны)`);
            } else if (delivered > 0 && ordered === 0) {
              // Если есть доставленные, но нет заказанных (возможно, все доставлены)
              buyoutRate = 100;
              console.log(`[Buyout Rate Service] ✓ Ozon buyout rate for ${offer_id}: ${buyoutRate}% (${delivered} продано, заказов нет в данных)`);
            }
            
            if (buyoutRate !== null) {
              return buyoutRate;
            } else {
              console.warn(`[Buyout Rate Service] Cannot calculate buyout rate for ${offer_id}: insufficient data`);
            }
          }
        } else {
          const errorText = await response.text();
          console.error(`[Buyout Rate Service] ❌ Ozon analytics API error: ${response.status} ${response.statusText}`);
          console.error(`[Buyout Rate Service] Error response:`, errorText);
          console.error(`[Buyout Rate Service] This might be due to:`);
          console.error(`[Buyout Rate Service]   - Invalid API credentials`);
          console.error(`[Buyout Rate Service]   - Insufficient API permissions`);
          console.error(`[Buyout Rate Service]   - Product SKU not found in Ozon`);
        }
      } catch (apiError) {
        console.error(`[Buyout Rate Service] ❌ Exception while calling Ozon API:`, apiError.message);
        console.error(`[Buyout Rate Service] Error stack:`, apiError.stack);
        console.error(`[Buyout Rate Service] This might be due to:`);
        console.error(`[Buyout Rate Service]   - Network error`);
        console.error(`[Buyout Rate Service]   - API endpoint changed`);
        console.error(`[Buyout Rate Service]   - Request timeout`);
      }

      // Альтернативный способ: через API отчетов
      // API v2/analytics/stock_on_warehouses - может содержать информацию о выкупах
      // Пока возвращаем null, если не удалось получить данные
      return null;
    } catch (error) {
      console.error(`[Buyout Rate Service] Error getting Ozon buyout rate:`, error);
      return null;
    }
  }

  /**
   * Получить процент выкупа товара с Wildberries
   * @param {string} sku - SKU товара на Wildberries
   * @returns {Promise<number|null>} - Процент выкупа (0-100) или null, если не удалось получить
   */
  async getWBBuyoutRate(sku) {
    try {
      const integrations = await integrationsService.getAll();
      const wbIntegration = integrations.find(i => i.code === 'wildberries');
      const api_key = wbIntegration?.config?.api_key;
      
      if (!api_key) {
        console.warn(`[Buyout Rate Service] Wildberries credentials not found`);
        return null;
      }

      // API Wildberries для получения аналитики
      // /api/v1/supplier/reportDetailByPeriod - детальный отчет по продажам
      try {
        const dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const dateTo = new Date().toISOString().split('T')[0];
        
        const response = await fetch(`https://statistics-api.wildberries.ru/api/v1/supplier/reportDetailByPeriod?dateFrom=${dateFrom}&dateTo=${dateTo}`, {
          method: 'GET',
          headers: {
            'Authorization': String(api_key)
          },
          timeout: 10000
        });

        if (response.ok) {
          const data = await response.json();
          console.log(`[Buyout Rate Service] WB analytics response for ${sku}:`, data.length, 'records');
          
          // Ищем товар по SKU
          const productData = data.find(item => item.supplierArticle === sku || item.nmId === sku);
          
          if (productData) {
            // В отчете WB есть поля:
            // - quantity - количество заказано
            // - quantityFull - количество выкуплено
            const ordered = productData.quantity || 0;
            const delivered = productData.quantityFull || 0;
            
            if (ordered > 0) {
              const buyoutRate = Math.round((delivered / ordered) * 100);
              console.log(`[Buyout Rate Service] WB buyout rate for ${sku}: ${buyoutRate}% (${delivered}/${ordered})`);
              return buyoutRate;
            }
          }
        } else {
          const errorText = await response.text();
          console.warn(`[Buyout Rate Service] WB analytics API error: ${response.status}`, errorText);
        }
      } catch (apiError) {
        console.warn(`[Buyout Rate Service] Failed to get WB analytics:`, apiError.message);
      }

      return null;
    } catch (error) {
      console.error(`[Buyout Rate Service] Error getting WB buyout rate:`, error);
      return null;
    }
  }

  /**
   * Получить процент выкупа товара с Yandex Market
   * @param {string} offer_id - SKU товара на Yandex Market
   * @returns {Promise<number|null>} - Процент выкупа (0-100) или null, если не удалось получить
   */
  async getYMBuyoutRate(offer_id) {
    try {
      const integrations = await integrationsService.getAll();
      const ymIntegration = integrations.find(i => i.code === 'yandex_market');
      const api_key = ymIntegration?.config?.api_key;
      const campaign_id = ymIntegration?.config?.campaign_id;
      
      if (!api_key || !campaign_id) {
        console.warn(`[Buyout Rate Service] Yandex Market credentials not found`);
        return null;
      }

      // API Yandex Market для получения статистики
      // GET /campaigns/{campaignId}/stats/orders - статистика по заказам
      try {
        const dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const dateTo = new Date().toISOString();
        
        const response = await fetch(`https://api.partner.market.yandex.ru/campaigns/${campaign_id}/stats/orders?fromDate=${dateFrom}&toDate=${dateTo}`, {
          method: 'GET',
          headers: {
            'Authorization': `OAuth ${String(api_key)}`
          },
          timeout: 10000
        });

        if (response.ok) {
          const data = await response.json();
          console.log(`[Buyout Rate Service] YM analytics response for ${offer_id}:`, JSON.stringify(data, null, 2));
          
          // Обработка ответа Yandex Market
          // Нужно найти товар по offer_id и посчитать процент выкупа
          if (data.result && Array.isArray(data.result)) {
            const productOrders = data.result.filter(order => 
              order.items && order.items.some(item => item.offerId === offer_id)
            );
            
            if (productOrders.length > 0) {
              let totalOrdered = 0;
              let totalDelivered = 0;
              
              productOrders.forEach(order => {
                const item = order.items.find(i => i.offerId === offer_id);
                if (item) {
                  totalOrdered += item.count || 0;
                  // В YM статус заказа может быть 'DELIVERY', 'CANCELLED', 'PROCESSING' и т.д.
                  if (order.status === 'DELIVERY' || order.status === 'DELIVERED') {
                    totalDelivered += item.count || 0;
                  }
                }
              });
              
              if (totalOrdered > 0) {
                const buyoutRate = Math.round((totalDelivered / totalOrdered) * 100);
                console.log(`[Buyout Rate Service] YM buyout rate for ${offer_id}: ${buyoutRate}% (${totalDelivered}/${totalOrdered})`);
                return buyoutRate;
              }
            }
          }
        } else {
          const errorText = await response.text();
          console.warn(`[Buyout Rate Service] YM analytics API error: ${response.status}`, errorText);
        }
      } catch (apiError) {
        console.warn(`[Buyout Rate Service] Failed to get YM analytics:`, apiError.message);
      }

      return null;
    } catch (error) {
      console.error(`[Buyout Rate Service] Error getting YM buyout rate:`, error);
      return null;
    }
  }

  /**
   * Синхронизировать процент выкупа для товара со всех маркетплейсов
   * @param {number} productId - ID товара в базе данных
   * @returns {Promise<Object>} - Результат синхронизации
   */
  async syncBuyoutRateForProduct(productId, req = null) {
    try {
      console.log(`[Buyout Rate Service] Starting sync for product ${productId} (type: ${typeof productId})`);
      
      // Получаем товар с SKU маркетплейсов
      let product;
      try {
        // Пробуем найти товар по ID
        product = await productsService.getById(productId);
        console.log(`[Buyout Rate Service] Product found by ID ${productId}: ${product.name} (DB ID: ${product.id})`);
      } catch (error) {
        console.error(`[Buyout Rate Service] Error getting product by ID ${productId}:`, error.message);
        
        // Если товар не найден по ID, попробуем найти по числовой части ID
        // (на случай, если ID был передан как строка с точкой, а в БД он целое число)
        if (typeof productId === 'string' && productId.includes('.')) {
          const numericId = parseInt(productId.split('.')[0], 10);
          if (!isNaN(numericId) && numericId > 0) {
            console.log(`[Buyout Rate Service] Trying to find product by numeric ID: ${numericId}`);
            try {
              product = await productsService.getById(numericId);
              console.log(`[Buyout Rate Service] Product found by numeric ID ${numericId}: ${product.name} (DB ID: ${product.id})`);
            } catch (numericError) {
              console.error(`[Buyout Rate Service] Product not found by numeric ID ${numericId}:`, numericError.message);
            }
          }
        }
        
        // Если товар все еще не найден, попробуем найти по SKU из запроса
        // (если передан SKU в параметрах запроса)
        if (!product && req?.query?.sku) {
          console.log(`[Buyout Rate Service] Trying to find product by SKU: ${req.query.sku}`);
          try {
            product = await productsService.getBySku(req.query.sku);
            if (product) {
              console.log(`[Buyout Rate Service] ✅ Product found by SKU ${req.query.sku}: ${product.name} (DB ID: ${product.id}, original requested ID: ${productId})`);
            } else {
              console.warn(`[Buyout Rate Service] Product not found by SKU ${req.query.sku}`);
            }
          } catch (skuError) {
            console.error(`[Buyout Rate Service] Error finding product by SKU ${req.query.sku}:`, skuError.message);
          }
        }
        
        if (!product) {
          // Попробуем найти все товары и показать их ID для отладки
          console.log(`[Buyout Rate Service] Listing all products in database for debugging...`);
          try {
            const allProducts = await productsService.getAll({ limit: 10 });
            console.log(`[Buyout Rate Service] First 10 products in DB:`, allProducts.map(p => ({ id: p.id, name: p.name, sku: p.sku })));
          } catch (listError) {
            console.error(`[Buyout Rate Service] Error listing products:`, listError.message);
          }
          
          return {
            success: false,
            error: `Товар с ID ${productId} не найден в базе данных. Проверьте, что товар существует. Возможно, ID товара изменился после миграции в PostgreSQL.`
          };
        }
      }
      
      if (!product) {
        console.error(`[Buyout Rate Service] Product ${productId} not found`);
        return {
          success: false,
          error: `Товар с ID ${productId} не найден`
        };
      }
      
      console.log(`[Buyout Rate Service] Product found: ${product.name} (ID: ${product.id}), SKUs: ozon=${product.sku_ozon || 'N/A'}, wb=${product.sku_wb || 'N/A'}, ym=${product.sku_ym || 'N/A'}`);

      // Получаем SKU для каждого маркетплейса
      let buyoutRates = {};
      let updateData = {};
      let updated = false;

      // Ozon
      if (product.sku_ozon) {
        console.log(`[Buyout Rate Service] Syncing Ozon buyout rate for product ${productId}, SKU: ${product.sku_ozon}`);
        console.log(`[Buyout Rate Service] Current buyout_rate_ozon in DB: ${product.buyout_rate_ozon}`);
        const ozonRate = await this.getOzonBuyoutRate(product.sku_ozon);
        console.log(`[Buyout Rate Service] Got Ozon rate from API: ${ozonRate} (type: ${typeof ozonRate})`);
        console.log(`[Buyout Rate Service] Current in DB: ${product.buyout_rate_ozon} (type: ${typeof product.buyout_rate_ozon})`);
        
        if (ozonRate !== null && ozonRate !== undefined) {
          buyoutRates.ozon = ozonRate;
          console.log(`[Buyout Rate Service] ✓ Ozon rate received: ${ozonRate}%, stored in buyoutRates.ozon`);
          
          // Всегда обновляем, если значение изменилось или если в БД null/undefined
          const currentRate = product.buyout_rate_ozon;
          if (currentRate === null || currentRate === undefined || ozonRate !== currentRate) {
            updateData.buyout_rate_ozon = ozonRate;
            updated = true;
            console.log(`[Buyout Rate Service] ✓ Will update buyout_rate_ozon: ${currentRate ?? 'NULL'} → ${ozonRate}%`);
          } else {
            console.log(`[Buyout Rate Service] Ozon buyout rate unchanged: ${ozonRate}% (already in DB)`);
          }
        } else {
          console.warn(`[Buyout Rate Service] ⚠ Could not get Ozon buyout rate for ${product.sku_ozon}. API returned null or undefined.`);
          console.warn(`[Buyout Rate Service] ⚠ This means the API call failed or returned no data. Check API credentials and response.`);
        }
      } else {
        console.log(`[Buyout Rate Service] No Ozon SKU for product ${productId}`);
      }

      // Wildberries
      if (product.sku_wb) {
        const wbRate = await this.getWBBuyoutRate(product.sku_wb);
        if (wbRate !== null) {
          buyoutRates.wildberries = wbRate;
          if (wbRate !== product.buyout_rate_wb) {
            updateData.buyout_rate_wb = wbRate;
            updated = true;
          }
        }
      }

      // Yandex Market
      if (product.sku_ym) {
        const ymRate = await this.getYMBuyoutRate(product.sku_ym);
        if (ymRate !== null) {
          buyoutRates.yandex_market = ymRate;
          if (ymRate !== product.buyout_rate_ym) {
            updateData.buyout_rate_ym = ymRate;
            updated = true;
          }
        }
      }

      // Рассчитываем средний процент выкупа для общего поля buyout_rate
      const rates = Object.values(buyoutRates);
      let averageBuyoutRate = product.buyout_rate || 100;
      if (rates.length > 0) {
        averageBuyoutRate = Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
        if (averageBuyoutRate !== product.buyout_rate) {
          updateData.buyout_rate = averageBuyoutRate;
          updated = true;
        }
      }

      // Обновляем товар, если получили данные
      if (updated) {
        try {
          console.log(`[Buyout Rate Service] Updating product ${productId} with data:`, updateData);
          await productsService.update(productId, updateData);
          console.log(`[Buyout Rate Service] Successfully updated buyout rates for product ${productId}:`, {
            ozon: buyoutRates.ozon || product.buyout_rate_ozon,
            wb: buyoutRates.wildberries || product.buyout_rate_wb,
            ym: buyoutRates.yandex_market || product.buyout_rate_ym,
            average: averageBuyoutRate
          });
        } catch (updateError) {
          console.error(`[Buyout Rate Service] Error updating product ${productId}:`, updateError.message);
          return {
            success: false,
            error: `Ошибка обновления товара: ${updateError.message}`,
            buyoutRates
          };
        }
      } else {
        console.log(`[Buyout Rate Service] No updates needed for product ${productId}. Current rates:`, {
          ozon: product.buyout_rate_ozon,
          wb: product.buyout_rate_wb,
          ym: product.buyout_rate_ym,
          average: product.buyout_rate
        });
      }

      return {
        success: true,
        productId,
        updated,
        oldBuyoutRates: {
          ozon: product.buyout_rate_ozon,
          wb: product.buyout_rate_wb,
          ym: product.buyout_rate_ym,
          average: product.buyout_rate
        },
        newBuyoutRates: {
          ozon: buyoutRates.ozon !== undefined ? buyoutRates.ozon : product.buyout_rate_ozon,
          wb: buyoutRates.wildberries !== undefined ? buyoutRates.wildberries : product.buyout_rate_wb,
          ym: buyoutRates.yandex_market !== undefined ? buyoutRates.yandex_market : product.buyout_rate_ym,
          average: averageBuyoutRate
        },
        buyoutRates,
        updated
      };
    } catch (error) {
      console.error(`[Buyout Rate Service] Error syncing buyout rate:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Синхронизировать процент выкупа для всех товаров
   * @param {Object} options - Опции синхронизации
   * @returns {Promise<Object>} - Результат синхронизации
   */
  async syncBuyoutRateForAll(options = {}) {
    const { limit = 100, offset = 0 } = options;
    
    try {
      // Получаем все товары с SKU маркетплейсов
      const products = await productsService.getAll({ limit, offset });
      
      const results = {
        total: products.length,
        processed: 0,
        updated: 0,
        errors: 0,
        details: []
      };

      for (const product of products) {
        // Пропускаем товары без SKU маркетплейсов
        if (!product.sku_ozon && !product.sku_wb && !product.sku_ym) {
          continue;
        }

        try {
          const result = await this.syncBuyoutRateForProduct(product.id);
          results.processed++;
          
          if (result.success && result.updated) {
            results.updated++;
          } else if (!result.success) {
            results.errors++;
          }
          
          results.details.push({
            productId: product.id,
            sku: product.sku,
            ...result
          });

          // Небольшая задержка между запросами, чтобы не перегружать API
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          results.errors++;
          results.details.push({
            productId: product.id,
            sku: product.sku,
            success: false,
            error: error.message
          });
        }
      }

      return results;
    } catch (error) {
      console.error(`[Buyout Rate Service] Error syncing buyout rate for all:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export default new BuyoutRateService();

