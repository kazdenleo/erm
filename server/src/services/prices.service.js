/**
 * Prices Service
 * Сервис для расчета цен на маркетплейсах
 * 
 * ВАЖНО: Этот сервис использует старую логику из server.js
 * В будущем нужно перенести всю логику сюда
 */

import integrationsService from './integrations.service.js';
import wbMarketplaceService from './wbMarketplace.service.js';
import { query } from '../config/database.js';
import { readData, writeData } from '../utils/storage.js';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import fs from 'fs';
import path from 'path';
import repositoryFactory from '../config/repository-factory.js';
import { calculateMinPrice } from './min-price-calculator.service.js';
import { applyOzonV5ItemToCalculator } from './ozon-v5-item-calculator.js';

// Временная функция для получения кэшированных данных WB
function getWBCachedData() {
  try {
    const dataDir = config.paths.dataDir;
    const categoriesFile = path.join(dataDir, 'wbCategoriesCache.json');
    const commissionsFile = path.join(dataDir, 'wbCommissionsCache.json');
    
    const categories = fs.existsSync(categoriesFile) 
      ? JSON.parse(fs.readFileSync(categoriesFile, 'utf8'))
      : [];
    
    const commissions = fs.existsSync(commissionsFile)
      ? JSON.parse(fs.readFileSync(commissionsFile, 'utf8'))
      : [];
    
    return { categories, commissions };
  } catch (error) {
    console.error('[Prices Service] Error loading WB cache:', error);
    return { categories: [], commissions: [] };
  }
}

// Временная функция для получения кэшированных складов WB
function getWBWarehousesCache() {
  try {
    const dataDir = config.paths.dataDir;
    const warehousesFile = path.join(dataDir, 'wbWarehousesCache.json');
    
    return fs.existsSync(warehousesFile)
      ? JSON.parse(fs.readFileSync(warehousesFile, 'utf8'))
      : [];
  } catch (error) {
    console.error('[Prices Service] Error loading WB warehouses cache:', error);
    return [];
  }
}

class PricesService {
  /**
   * Загрузить акции Ozon из API и товары по каждой акции, сохранить в кэш (cron раз в сутки в 01:00)
   */
  async updateAndCacheOzonActions() {
    try {
      const apiResult = await this._fetchOzonActionsFromApi();
      if (!apiResult.ok) {
        logger.warn('[Prices Service] Ozon actions update failed:', apiResult.error);
        return;
      }
      const actions = apiResult.result || [];
      const cache = {
        result: actions,
        lastUpdate: new Date().toISOString()
      };
      await writeData('ozonActionsCache', cache);
      logger.info(`[Prices Service] Ozon actions cached: ${actions.length} items`);

      const productsByAction = {};
      for (const action of actions) {
        const actionId = action.id;
        if (actionId == null) continue;
        try {
          const productsResult = await this._fetchAllOzonActionProducts(actionId);
          if (productsResult.ok && Array.isArray(productsResult.products)) {
            productsByAction[String(actionId)] = {
              products: productsResult.products,
              total: productsResult.total ?? productsResult.products.length,
              lastUpdate: new Date().toISOString()
            };
            logger.info(`[Prices Service] Ozon action ${actionId} products cached: ${productsResult.products.length} (total: ${productsResult.total ?? productsResult.products.length})`);
          }
        } catch (err) {
          logger.warn(`[Prices Service] Failed to fetch products for action ${actionId}:`, err.message);
        }
      }
      const productsCache = {
        lastUpdate: new Date().toISOString(),
        actions: productsByAction
      };
      await writeData('ozonActionProductsCache', productsCache);
    } catch (error) {
      logger.error('[Prices Service] Error updating Ozon actions cache:', error);
    }
  }

  /**
   * Товары, доступные к добавлению в акцию (candidates) — запрос к API по требованию
   * @param {number|string} actionId
   * @returns {Promise<{ ok: boolean, products?: Array, total?: number, error?: string }>}
   */
  async getOzonActionCandidates(actionId) {
    try {
      const all = [];
      let lastId = '';
      const limit = 100;
      for (;;) {
        const page = await this._fetchOzonActionCandidatesFromApi(actionId, limit, lastId);
        if (!page.ok) {
          logger.warn('[Prices Service] getOzonActionCandidates API error:', page.error);
          return { ok: true, products: [], total: 0, error: page.error };
        }
        if (page.products && page.products.length > 0) all.push(...page.products);
        if (!page.last_id || page.products.length === 0) break;
        lastId = page.last_id;
      }
      if (all.length === 0) {
        return { ok: true, products: [], total: 0 };
      }
      const ourOzonProductIds = await this._getOurOzonProductIdsFromDb();
      const { set: ourOfferIdsSet, list: ourOfferList } = await this._getOurOzonOfferIds();
      if (ourOzonProductIds.size === 0 && ourOfferIdsSet.size === 0) {
        return { ok: true, products: [], total: 0 };
      }
      const ozonIds = [...ourOzonProductIds];
      const ourByOzonId = ourOzonProductIds.size > 0 ? await this._getOurProductsByOzonProductIds(ozonIds) : {};
      const productIds = all.map(p => p.id).filter(id => id != null);
      const idToOffer = await this._fetchOzonProductIdToOfferId(productIds);
      const ourProductsByOffer = ourOfferIdsSet.size > 0 ? await this._getOurProductsByOzonOfferIds(ourOfferList) : {};
      const filtered = [];
      for (const p of all) {
        const matchByProductId = ourOzonProductIds.has(Number(p.id));
        const offerFromApi = (p.offer_id != null && String(p.offer_id).trim() !== '') ? String(p.offer_id).trim() : null;
        const offerId = offerFromApi || idToOffer[String(p.id)];
        const offerIdNorm = offerId ? String(offerId).trim().toLowerCase() : '';
        const matchByOfferId = offerIdNorm && ourOfferIdsSet.has(offerIdNorm);
        if (!matchByProductId && !matchByOfferId) continue;
        const ourById = ourByOzonId[Number(p.id)];
        const ourByOffer = ourProductsByOffer[offerId] || (offerIdNorm ? ourProductsByOffer[offerIdNorm] : null) || {};
        const our = ourById || ourByOffer;
        filtered.push({
          ...p,
          offer_id: our?.offer_id ?? offerId ?? null,
          our_product_id: our?.id ?? null,
          our_product_name: our?.name ?? null,
          our_sku: our?.sku ?? null
        });
      }
      logger.info(`[Prices Service] getOzonActionCandidates: ourProductIds=${ourOzonProductIds.size}, ourOfferIds=${ourOfferList.length}, candidates=${all.length}, filtered(our)=${filtered.length}`);
      const enriched = await this._enrichActionProductsWithMinPrice(filtered, 'ozon');
      return { ok: true, products: enriched, total: enriched.length };
    } catch (error) {
      logger.warn('[Prices Service] getOzonActionCandidates error:', error.message);
      return { ok: true, products: [], total: 0, error: error.message };
    }
  }

  async _fetchOzonActionCandidatesFromApi(actionId, limit = 100, lastId = '') {
    const integrations = await integrationsService.getAll();
    const ozonIntegration = integrations.find(i => i.code === 'ozon');
    const client_id = ozonIntegration?.config?.client_id;
    const api_key = ozonIntegration?.config?.api_key;
    if (!client_id || !api_key) {
      return { ok: false, error: 'Необходимы Client ID и API Key для Ozon' };
    }
    const response = await fetch('https://api-seller.ozon.ru/v1/actions/candidates', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Client-Id': String(client_id),
        'Api-Key': String(api_key)
      },
      body: JSON.stringify({
        action_id: Number(actionId),
        limit: Math.min(Number(limit) || 100, 100),
        offset: 0,
        last_id: lastId || ''
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `Ошибка API Ozon: ${errorText.substring(0, 150)}` };
    }
    const data = await response.json();
    const result = data.result || {};
    const products = Array.isArray(result.products) ? result.products : [];
    return {
      ok: true,
      products,
      total: result.total != null ? result.total : products.length,
      last_id: result.last_id || ''
    };
  }

  /**
   * Получить множество offer_id (артикулов Ozon), которые есть в нашей системе.
   * Возвращает { set: Set (normalized lowercase для сравнения), list: string[] (для запроса к БД) }
   */
  async _getOurOzonOfferIds() {
    try {
      const result = await query(
        `SELECT sku FROM product_skus WHERE marketplace = 'ozon' AND sku IS NOT NULL AND TRIM(sku) <> ''`
      );
      const list = [];
      const set = new Set();
      (result.rows || []).forEach(row => {
        const s = String(row.sku).trim();
        if (s) {
          list.push(s);
          set.add(s.toLowerCase());
        }
      });
      return { set, list };
    } catch (e) {
      logger.warn('[Prices Service] _getOurOzonOfferIds error:', e.message);
      return { set: new Set(), list: [] };
    }
  }

  /**
   * Получить маппинг Ozon product_id -> offer_id через API (батчами по 100)
   */
  async _fetchOzonProductIdToOfferId(productIds) {
    if (!productIds || productIds.length === 0) return {};
    const integrations = await integrationsService.getAll();
    const ozon = integrations.find(i => i.code === 'ozon');
    const client_id = ozon?.config?.client_id;
    const api_key = ozon?.config?.api_key;
    if (!client_id || !api_key) return {};
    const map = {};
    const batchSize = 100;
    for (let i = 0; i < productIds.length; i += batchSize) {
      const batch = productIds.slice(i, i + batchSize);
      try {
        const response = await fetch('https://api-seller.ozon.ru/v3/product/info/list', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Client-Id': String(client_id),
            'Api-Key': String(api_key)
          },
          body: JSON.stringify({ product_id: batch })
        });
        if (!response.ok) continue;
        const data = await response.json();
        const items = data.result?.items || data.items || [];
        items.forEach(item => {
          if (item.id != null && item.offer_id != null) {
            const offerId = String(item.offer_id).trim();
            map[String(item.id)] = offerId;
          }
        });
      } catch (e) {
        logger.warn('[Prices Service] _fetchOzonProductIdToOfferId batch error:', e.message);
      }
    }
    return map;
  }

  /**
   * По артикулу продавца (offer_id) получить Ozon product_id через API (для сохранения при связке товара)
   * @param {string} offerId
   * @returns {Promise<number|null>}
   */
  async getOzonProductIdByOfferId(offerId) {
    if (!offerId || String(offerId).trim() === '') return null;
    const integrations = await integrationsService.getAll();
    const ozon = integrations.find(i => i.code === 'ozon');
    const client_id = ozon?.config?.client_id;
    const api_key = ozon?.config?.api_key;
    if (!client_id || !api_key) return null;
    try {
      const response = await fetch('https://api-seller.ozon.ru/v3/product/info/list', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Client-Id': String(client_id),
          'Api-Key': String(api_key)
        },
        body: JSON.stringify({ offer_id: [String(offerId).trim()] })
      });
      if (!response.ok) return null;
      const data = await response.json();
      const items = data.result?.items || data.items || [];
      const first = items[0];
      return first?.id != null ? Number(first.id) : null;
    } catch (e) {
      logger.warn('[Prices Service] getOzonProductIdByOfferId error:', e.message);
      return null;
    }
  }

  /**
   * Получить множество Ozon product_id, которые есть в нашей системе (по полю marketplace_product_id)
   */
  async _getOurOzonProductIdsFromDb() {
    try {
      const result = await query(
        `SELECT marketplace_product_id FROM product_skus
         WHERE marketplace = 'ozon' AND marketplace_product_id IS NOT NULL`
      );
      const set = new Set();
      (result.rows || []).forEach(row => set.add(Number(row.marketplace_product_id)));
      return set;
    } catch (e) {
      logger.warn('[Prices Service] _getOurOzonProductIdsFromDb error:', e.message);
      return new Set();
    }
  }

  /**
   * Получить наши товары по Ozon product_id (из поля marketplace_product_id)
   */
  async _getOurProductsByOzonProductIds(ozonProductIds) {
    if (!ozonProductIds || ozonProductIds.length === 0) return {};
    try {
      const result = await query(
        `SELECT p.id, p.name, p.sku, ps.sku AS ozon_offer_id, ps.marketplace_product_id AS ozon_product_id
         FROM products p
         JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ozon'
         WHERE ps.marketplace_product_id = ANY($1)`,
        [ozonProductIds.map(Number).filter(n => !isNaN(n))]
      );
      const byOzonId = {};
      (result.rows || []).forEach(row => {
        byOzonId[Number(row.ozon_product_id)] = { id: row.id, name: row.name, sku: row.sku, offer_id: row.ozon_offer_id };
      });
      return byOzonId;
    } catch (e) {
      logger.warn('[Prices Service] _getOurProductsByOzonProductIds error:', e.message);
      return {};
    }
  }

  /**
   * Получить минимальные цены по маркетплейсу для списка product_id (наши id)
   * @param {number[]} productIds
   * @param {string} marketplace 'ozon' | 'wb' | 'ym'
   * @returns {Promise<Record<number, number>>} productId -> min_price
   */
  async _getMinPricesByMarketplace(productIds, marketplace) {
    if (!productIds || productIds.length === 0) return {};
    const ids = [...new Set(productIds.map(id => Number(id)).filter(n => !isNaN(n) && n > 0))];
    if (ids.length === 0) return {};
    try {
      const result = await query(
        'SELECT product_id, min_price FROM product_marketplace_prices WHERE product_id = ANY($1) AND marketplace = $2',
        [ids, String(marketplace)]
      );
      const map = {};
      (result.rows || []).forEach(row => {
        const idNum = Number(row.product_id);
        const idStr = String(row.product_id);
        const price = row.min_price != null ? parseFloat(row.min_price) : null;
        if (price != null && !isNaN(price)) {
          map[idNum] = price;
          map[idStr] = price;
        }
      });
      return map;
    } catch (e) {
      logger.warn('[Prices Service] _getMinPricesByMarketplace error:', e.message);
      return {};
    }
  }

  /**
   * Добавить к списку товаров акции поле min_price_ozon (наша сохранённая мин. цена для Ozon)
   */
  async _enrichActionProductsWithMinPrice(filtered, marketplace = 'ozon') {
    const ourIds = filtered.map(p => p.our_product_id).filter(id => id != null && id !== '');
    if (ourIds.length === 0) return filtered;
    const minPrices = await this._getMinPricesByMarketplace(ourIds, marketplace);
    const hasAnyPrice = ourIds.some(id => (minPrices[Number(id)] ?? minPrices[String(id)]) != null);
    if (!hasAnyPrice && ourIds.length > 0) {
      logger.info(`[Prices Service] _enrichActionProductsWithMinPrice: requested ${ourIds.length} product ids, no min prices in product_marketplace_prices for marketplace=${marketplace}`);
    }
    return filtered.map(p => {
      const pid = p.our_product_id;
      const price = pid != null ? (minPrices[Number(pid)] ?? minPrices[String(pid)] ?? null) : null;
      return { ...p, min_price_ozon: price };
    });
  }

  /**
   * Получить наши товары по offer_id (product_id, name, sku) для списка offer_ids
   */
  async _getOurProductsByOzonOfferIds(offerIds) {
    if (!offerIds || offerIds.length === 0) return {};
    try {
      const result = await query(
        `SELECT p.id, p.name, p.sku, ps.sku AS ozon_offer_id
         FROM products p
         JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ozon'
         WHERE ps.sku = ANY($1)`,
        [offerIds]
      );
      const byOffer = {};
      (result.rows || []).forEach(row => {
        const key = String(row.ozon_offer_id).trim();
        const val = { id: row.id, name: row.name, sku: row.sku };
        byOffer[key] = val;
        byOffer[key.toLowerCase()] = val;
      });
      return byOffer;
    } catch (e) {
      logger.warn('[Prices Service] _getOurProductsByOzonOfferIds error:', e.message);
      return {};
    }
  }

  /**
   * Получить товары акции Ozon из кэша — только те, что есть в нашей системе; с полями our_product_id, our_product_name, offer_id
   * @param {number|string} actionId
   * @returns {Promise<{ ok: boolean, products?: Array, total?: number, error?: string }>}
   */
  async getOzonActionProducts(actionId) {
    try {
      const cache = await readData('ozonActionProductsCache');
      const actions = cache?.actions || {};
      const key = String(actionId);
      let rawProducts = actions[key]?.products || [];
      // Если в кэше нет товаров по акции — подгружаем из API (кэш мог быть пуст или ещё не обновлён)
      if (rawProducts.length === 0) {
        const fetched = await this._fetchAllOzonActionProducts(actionId);
        if (fetched.ok && fetched.products && fetched.products.length > 0) {
          rawProducts = fetched.products;
          try {
            const updated = { ...(cache || {}), actions: { ...(cache?.actions || {}), [key]: { products: rawProducts, total: fetched.total ?? rawProducts.length, lastUpdate: new Date().toISOString() } } };
            await writeData('ozonActionProductsCache', updated);
          } catch (e) {
            logger.warn('[Prices Service] Could not update action products cache:', e.message);
          }
        } else {
          return { ok: true, products: [], total: 0 };
        }
      }
      const ourOzonProductIds = await this._getOurOzonProductIdsFromDb();
      const { set: ourOfferIdsSet, list: ourOfferList } = await this._getOurOzonOfferIds();
      if (ourOzonProductIds.size === 0 && ourOfferIdsSet.size === 0) {
        logger.info('[Prices Service] getOzonActionProducts: no Ozon product_skus, returning empty');
        return { ok: true, products: [], total: 0 };
      }
      const ozonIds = [...ourOzonProductIds];
      const ourByOzonId = ourOzonProductIds.size > 0 ? await this._getOurProductsByOzonProductIds(ozonIds) : {};
      const productIds = rawProducts.map(p => p.id).filter(id => id != null);
      const idToOffer = await this._fetchOzonProductIdToOfferId(productIds);
      const ourProductsByOffer = ourOfferIdsSet.size > 0 ? await this._getOurProductsByOzonOfferIds(ourOfferList) : {};
      const filtered = [];
      for (const p of rawProducts) {
        const matchByProductId = ourOzonProductIds.has(Number(p.id));
        const offerFromApi = (p.offer_id != null && String(p.offer_id).trim() !== '') ? String(p.offer_id).trim() : null;
        const offerId = offerFromApi || idToOffer[String(p.id)];
        const offerIdNorm = offerId ? String(offerId).trim().toLowerCase() : '';
        const matchByOfferId = offerIdNorm && ourOfferIdsSet.has(offerIdNorm);
        if (!matchByProductId && !matchByOfferId) continue;
        const ourById = ourByOzonId[Number(p.id)];
        const ourByOffer = ourProductsByOffer[offerId] || (offerIdNorm ? ourProductsByOffer[offerIdNorm] : null) || {};
        const our = ourById || ourByOffer;
        filtered.push({
          ...p,
          offer_id: our?.offer_id ?? offerId ?? null,
          our_product_id: our?.id ?? null,
          our_product_name: our?.name ?? null,
          our_sku: our?.sku ?? null
        });
      }
      logger.info(`[Prices Service] getOzonActionProducts: ourProductIds=${ourOzonProductIds.size}, ourOfferIds=${ourOfferList.length}, raw=${rawProducts.length}, filtered=${filtered.length}`);
      const enriched = await this._enrichActionProductsWithMinPrice(filtered, 'ozon');
      return { ok: true, products: enriched, total: enriched.length };
    } catch (error) {
      logger.warn('[Prices Service] getOzonActionProducts error:', error.message);
      return { ok: true, products: [], total: 0 };
    }
  }

  /**
   * Получить список акций Ozon (из кэша; при первом обращении — запрос к API)
   * @returns {Promise<{ ok: boolean, result?: Array, error?: string }>}
   */
  async getOzonActions() {
    try {
      const cache = await readData('ozonActionsCache');
      if (cache && Array.isArray(cache.result)) {
        return { ok: true, result: cache.result };
      }
      const integrations = await integrationsService.getAll();
      const ozonIntegration = integrations.find(i => i.code === 'ozon');
      const client_id = ozonIntegration?.config?.client_id;
      const api_key = ozonIntegration?.config?.api_key;
      if (!client_id || !api_key) {
        return {
          ok: false,
          error: 'Настройте интеграцию Ozon: укажите Client ID и API Key в разделе «Интеграции»'
        };
      }
      const apiResult = await this._fetchOzonActionsFromApi();
      if (apiResult.ok && Array.isArray(apiResult.result)) {
        const cache = { result: apiResult.result, lastUpdate: new Date().toISOString() };
        await writeData('ozonActionsCache', cache).catch(() => {});
      }
      return apiResult;
    } catch (error) {
      console.error('[Prices Service] Error getting Ozon actions:', error);
      return { ok: false, error: error.message || 'Ошибка при получении акций Ozon' };
    }
  }

  /**
   * Список акций Wildberries (календарь акций) + детали по каждой
   * GET dp-calendar-api.wildberries.ru/api/v1/calendar/promotions → затем details по promotionIDs
   */
  async getWBActions() {
    try {
      const cache = await readData('wbPromotionsCache');
      if (cache && Array.isArray(cache.promotions) && cache.promotions.length > 0) {
        return { ok: true, data: cache.promotions, lastUpdate: cache.lastUpdate };
      }
      const integrations = await integrationsService.getAll();
      const wb = integrations.find(i => i.code === 'wildberries' || i.code === 'wb');
      const api_key = wb?.config?.api_key;
      if (!api_key) {
        return { ok: false, error: 'Настройте интеграцию Wildberries: укажите API Key в разделе «Интеграции»' };
      }
      const listResult = await this._fetchWBPromotionsFromApi(api_key);
      if (!listResult.ok || !Array.isArray(listResult.promotions)) {
        return { ok: false, error: listResult.error || 'Не удалось загрузить список акций WB' };
      }
      const promotions = listResult.promotions;
      if (promotions.length === 0) {
        await writeData('wbPromotionsCache', { promotions: [], lastUpdate: new Date().toISOString() }).catch(() => {});
        return { ok: true, data: [], lastUpdate: new Date().toISOString() };
      }
      const detailsResult = await this._fetchWBPromotionsDetailsFromApi(api_key, promotions.map(p => p.id));
      const detailsById = {};
      if (detailsResult.ok && Array.isArray(detailsResult.promotions)) {
        detailsResult.promotions.forEach(p => { detailsById[p.id] = p; });
      }
      const merged = promotions.map(p => ({ ...p, ...(detailsById[p.id] || {}) }));
      const cacheData = { promotions: merged, lastUpdate: new Date().toISOString() };
      await writeData('wbPromotionsCache', cacheData).catch(() => {});
      return { ok: true, data: merged, lastUpdate: cacheData.lastUpdate };
    } catch (error) {
      logger.warn('[Prices Service] getWBActions error:', error.message);
      return { ok: false, error: error.message || 'Ошибка при получении акций Wildberries' };
    }
  }

  async _fetchWBPromotionsFromApi(apiKey) {
    try {
      // WB API требует обязательные параметры: startDateTime, endDateTime (YYYY-MM-DDTHH:MM:SSZ), allPromo (boolean)
      const now = new Date();
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear() + 1, 11, 31, 23, 59, 59);
      const startDateTime = start.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const endDateTime = end.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const params = new URLSearchParams({
        startDateTime,
        endDateTime,
        allPromo: 'true',
        limit: '1000',
        offset: '0'
      });
      const url = `https://dp-calendar-api.wildberries.ru/api/v1/calendar/promotions?${params.toString()}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': String(apiKey)
        }
      });
      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `WB API: ${response.status} ${text.substring(0, 200)}` };
      }
      const data = await response.json();
      const promotions = data?.data?.promotions ?? [];
      return { ok: true, promotions: Array.isArray(promotions) ? promotions : [] };
    } catch (e) {
      logger.warn('[Prices Service] _fetchWBPromotionsFromApi error:', e.message);
      return { ok: false, error: e.message };
    }
  }

  async _fetchWBPromotionsDetailsFromApi(apiKey, promotionIds) {
    if (!promotionIds || promotionIds.length === 0) return { ok: true, promotions: [] };
    const ids = [...new Set(promotionIds.map(Number).filter(n => !isNaN(n)))];
    const all = [];
    const batchSize = 100;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const query = batch.map(id => `promotionIDs=${encodeURIComponent(id)}`).join('&');
      try {
        const response = await fetch(`https://dp-calendar-api.wildberries.ru/api/v1/calendar/promotions/details?${query}`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': String(apiKey)
          }
        });
        if (!response.ok) {
          logger.warn('[Prices Service] WB promotions details batch error:', response.status);
          continue;
        }
        const data = await response.json();
        const list = data?.data?.promotions ?? [];
        if (Array.isArray(list)) all.push(...list);
      } catch (e) {
        logger.warn('[Prices Service] _fetchWBPromotionsDetailsFromApi batch error:', e.message);
      }
    }
    return { ok: true, promotions: all };
  }

  /**
   * Детальная информация по одной акции WB (GET .../promotions/details?promotionIDs=id)
   * @param {number|string} promotionId
   * @returns {Promise<{ ok: boolean, promotion?: object, error?: string }>}
   */
  async getWBPromotionDetails(promotionId) {
    try {
      const integrations = await integrationsService.getAll();
      const wb = integrations.find(i => i.code === 'wildberries' || i.code === 'wb');
      const api_key = wb?.config?.api_key;
      if (!api_key) {
        return { ok: false, error: 'Настройте интеграцию Wildberries: укажите API Key' };
      }
      const id = Number(promotionId);
      if (isNaN(id) || id < 1) {
        return { ok: false, error: 'Некорректный ID акции' };
      }
      const result = await this._fetchWBPromotionsDetailsFromApi(api_key, [id]);
      if (!result.ok) {
        return { ok: false, error: result.error || 'Ошибка запроса к API WB' };
      }
      const promotion = Array.isArray(result.promotions) && result.promotions.length > 0 ? result.promotions[0] : null;
      return { ok: true, promotion: promotion || null };
    } catch (e) {
      logger.warn('[Prices Service] getWBPromotionDetails error:', e.message);
      return { ok: false, error: e.message };
    }
  }

  /**
   * Список товаров по акции WB: участвующие (inAction=true) или доступные (inAction=false)
   * GET .../promotions/nomenclatures?promotionID=&inAction=&limit=&offset=
   * @param {number|string} promotionId
   * @param {boolean} inAction true — в акции, false — не в акции (доступные к добавлению)
   * @param {number} limit 1..1000
   * @param {number} offset >= 0
   * @returns {Promise<{ ok: boolean, nomenclatures?: Array, total?: number, error?: string }>}
   */
  async getWBPromotionNomenclatures(promotionId, inAction = false, limit = 1000, offset = 0) {
    try {
      const integrations = await integrationsService.getAll();
      const wb = integrations.find(i => i.code === 'wildberries' || i.code === 'wb');
      const api_key = wb?.config?.api_key;
      if (!api_key) {
        return { ok: false, error: 'Настройте интеграцию Wildberries: укажите API Key' };
      }
      const id = Number(promotionId);
      if (isNaN(id) || id < 1) {
        return { ok: false, error: 'Некорректный ID акции' };
      }
      const result = await this._fetchWBPromotionNomenclaturesFromApi(api_key, id, Boolean(inAction), Math.min(1000, Math.max(1, Number(limit) || 1000)), Math.max(0, Number(offset) || 0));
      return result;
    } catch (e) {
      logger.warn('[Prices Service] getWBPromotionNomenclatures error:', e.message);
      return { ok: false, error: e.message, nomenclatures: [] };
    }
  }

  async _fetchWBPromotionNomenclaturesFromApi(apiKey, promotionID, inAction, limit = 1000, offset = 0) {
    try {
      // WB ждёт promotionID (integer), inAction (boolean). 422 = "Not applicable for auto promotions" или неверные параметры.
      const params = new URLSearchParams();
      params.set('promotionID', String(Number(promotionID)));
      params.set('inAction', inAction ? 'true' : 'false');
      if (limit != null && limit > 0) params.set('limit', String(Math.min(1000, Math.max(1, Number(limit)))));
      if (offset != null && offset >= 0) params.set('offset', String(Math.max(0, Number(offset))));
      const url = `https://dp-calendar-api.wildberries.ru/api/v1/calendar/promotions/nomenclatures?${params.toString()}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': String(apiKey)
        }
      });
      if (response.status === 422) {
        // 422 = "Error processing request parameters" — для авто-акций метод номенклатур недоступен (Not applicable for auto promotions)
        logger.info('[Prices Service] WB nomenclatures 422 — возможно авто-акция или неверные параметры');
        return { ok: true, nomenclatures: [], total: 0, notApplicable: true };
      }
      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `WB API: ${response.status} ${text.substring(0, 200)}`, nomenclatures: [] };
      }
      const data = await response.json();
      const list = data?.data?.nomenclatures ?? [];
      return { ok: true, nomenclatures: Array.isArray(list) ? list : [], total: (Array.isArray(list) ? list.length : 0) };
    } catch (e) {
      logger.warn('[Prices Service] _fetchWBPromotionNomenclaturesFromApi error:', e.message);
      return { ok: false, error: e.message, nomenclatures: [] };
    }
  }

  async _fetchOzonActionsFromApi() {
    const integrations = await integrationsService.getAll();
    const ozonIntegration = integrations.find(i => i.code === 'ozon');
    const client_id = ozonIntegration?.config?.client_id;
    const api_key = ozonIntegration?.config?.api_key;
    if (!client_id || !api_key) {
      return { ok: false, error: 'Необходимы Client ID и API Key для Ozon' };
    }
    const response = await fetch('https://api-seller.ozon.ru/v1/actions', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Client-Id': String(client_id),
        'Api-Key': String(api_key)
      }
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `Ошибка API Ozon: ${errorText.substring(0, 150)}` };
    }
    const data = await response.json();
    const result = data.result || [];
    return { ok: true, result: Array.isArray(result) ? result : [] };
  }

  /**
   * Один запрос товаров акции: POST /v1/actions/products
   * @param {number} actionId
   * @param {number} [limit=100]
   * @param {string} [lastId='']
   */
  async _fetchOzonActionProductsFromApi(actionId, limit = 100, lastId = '') {
    const integrations = await integrationsService.getAll();
    const ozonIntegration = integrations.find(i => i.code === 'ozon');
    const client_id = ozonIntegration?.config?.client_id;
    const api_key = ozonIntegration?.config?.api_key;
    if (!client_id || !api_key) {
      return { ok: false, error: 'Необходимы Client ID и API Key для Ozon' };
    }
    const response = await fetch('https://api-seller.ozon.ru/v1/actions/products', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Client-Id': String(client_id),
        'Api-Key': String(api_key)
      },
      body: JSON.stringify({
        action_id: Number(actionId),
        limit: Math.min(Number(limit) || 100, 100),
        offset: 0,
        last_id: lastId || ''
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `Ошибка API Ozon: ${errorText.substring(0, 150)}` };
    }
    const data = await response.json();
    const result = data.result || {};
    const products = Array.isArray(result.products) ? result.products : [];
    return {
      ok: true,
      products,
      total: result.total != null ? result.total : products.length,
      last_id: result.last_id || ''
    };
  }

  /**
   * Загрузить все страницы товаров по акции (по last_id)
   */
  async _fetchAllOzonActionProducts(actionId) {
    const all = [];
    let lastId = '';
    let total = 0;
    const limit = 100;
    for (;;) {
      const page = await this._fetchOzonActionProductsFromApi(actionId, limit, lastId);
      if (!page.ok) return page;
      if (page.products && page.products.length > 0) {
        all.push(...page.products);
      }
      if (page.total != null) total = page.total;
      if (!page.last_id || page.products.length === 0) break;
      lastId = page.last_id;
    }
    return { ok: true, products: all, total: total || all.length };
  }

  _mpDbMarketplace(code) {
    if (code === 'wildberries') return 'wb';
    return code;
  }

  async _getProductIdByMarketplaceSku(marketplace, sku) {
    if (!sku) return null;
    const mp = this._mpDbMarketplace(marketplace);
    const r = await query(
      `SELECT product_id FROM product_skus WHERE marketplace = $1 AND sku = $2 LIMIT 1`,
      [mp, String(sku).trim()]
    );
    return r.rows[0]?.product_id ?? null;
  }

  async _getMpCalculatorCacheRow(productId, marketplace) {
    try {
      const r = await query(
        `SELECT calculator, updated_at, source FROM product_mp_calculator_cache WHERE product_id = $1 AND marketplace = $2`,
        [productId, marketplace]
      );
      return r.rows[0] || null;
    } catch (e) {
      if (String(e.message || '').includes('does not exist')) return null;
      throw e;
    }
  }

  async _upsertMpCalculatorCache(productId, marketplace, calculator, source = 'api') {
    const sanitized = this._sanitizeCalculatorForStorage(calculator, marketplace) || calculator;
    try {
      await query(
        `INSERT INTO product_mp_calculator_cache (product_id, marketplace, calculator, source, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (product_id, marketplace) DO UPDATE SET calculator = EXCLUDED.calculator, source = EXCLUDED.source, updated_at = CURRENT_TIMESTAMP`,
        [productId, marketplace, JSON.stringify(sanitized), source]
      );
    } catch (e) {
      // В некоторых инсталляциях таблица кэша может отсутствовать (миграции не применены).
      // Live-расчёты должны работать и без кэша — просто пропускаем запись.
      if (String(e.message || '').includes('product_mp_calculator_cache') && String(e.message || '').includes('does not exist')) {
        return;
      }
      throw e;
    }
  }

  async _tryUpsertMpCalculatorCacheFromOffer(marketplace, offer_id, calculator, source) {
    if (!calculator) return;
    const pid = await this._getProductIdByMarketplaceSku(marketplace, offer_id);
    if (pid) await this._upsertMpCalculatorCache(pid, marketplace, calculator, source);
  }

  /**
   * Синхронизация кэша калькулятора с API (батчи Ozon до 100 offer_id на запрос; WB/YM — по товарам).
   * @param {{ marketplaces?: string[], limit?: number, delayMs?: number }} [opts]
   */
  async syncCalculatorCacheFromApi(opts = {}) {
    const marketplaces = Array.isArray(opts.marketplaces) && opts.marketplaces.length
      ? opts.marketplaces
      : ['ozon', 'wb', 'ym'];
    const delayMs = opts.delayMs != null ? Number(opts.delayMs) : 150;
    const limit = opts.limit != null ? Number(opts.limit) : null;
    const out = {};

    if (marketplaces.includes('ozon')) {
      out.ozon = await this._syncOzonCalculatorCacheBatch({ limit, delayMs });
    }
    if (marketplaces.includes('wb')) {
      out.wb = await this._syncWBCalculatorCacheSequential({ limit, delayMs });
    }
    if (marketplaces.includes('ym')) {
      out.ym = await this._syncYMCalculatorCacheSequential({ limit, delayMs });
    }
    return out;
  }

  async _syncOzonCalculatorCacheBatch({ limit, delayMs }) {
    const errors = [];
    let updated = 0;
    let requests = 0;
    const integrations = await integrationsService.getAll();
    const ozonIntegration = integrations.find(i => i.code === 'ozon');
    const client_id = ozonIntegration?.config?.client_id;
    const api_key = ozonIntegration?.config?.api_key;
    if (!client_id || !api_key) {
      return { ok: false, updated: 0, requests: 0, errors: ['Не настроены Client ID / API Key Ozon'] };
    }

    const chunk = 100;
    let offset = 0;
    for (;;) {
      if (limit != null && updated >= limit) break;
      const need = limit != null ? Math.min(chunk, limit - updated) : chunk;
      if (need <= 0) break;

      const rowsRes = await query(
        `SELECT TRIM(ps.sku) AS offer_id
         FROM product_skus ps
         WHERE ps.marketplace = 'ozon' AND ps.sku IS NOT NULL AND TRIM(ps.sku) <> ''
         GROUP BY TRIM(ps.sku)
         ORDER BY MIN(ps.product_id)
         LIMIT $1 OFFSET $2`,
        [need, offset]
      );
      const offerIds = rowsRes.rows.map(r => r.offer_id).filter(Boolean);
      if (!offerIds.length) break;
      offset += offerIds.length;

      try {
        const response = await fetch('https://api-seller.ozon.ru/v5/product/info/prices', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Client-Id': String(client_id),
            'Api-Key': String(api_key)
          },
          body: JSON.stringify({
            cursor: '',
            filter: { offer_id: offerIds, visibility: 'ALL' },
            limit: 100
          }),
          timeout: 60000
        });
        requests++;
        if (!response.ok) {
          const errText = await response.text();
          errors.push({ batch: offerIds.slice(0, 3), error: errText.substring(0, 200) });
        } else {
          const data = await response.json();
          const items = data.items || (data.result && data.result.items) || [];
          for (const item of items) {
            const oid = item.offer_id != null ? String(item.offer_id).trim() : null;
            if (!oid) continue;
            const built = await applyOzonV5ItemToCalculator(item, oid, client_id, api_key);
            if (built.found && built.calculator) {
              const pidsRes = await query(
                `SELECT product_id FROM product_skus WHERE marketplace = 'ozon' AND TRIM(sku) = $1`,
                [oid]
              );
              for (const pr of pidsRes.rows) {
                await this._upsertMpCalculatorCache(pr.product_id, 'ozon', built.calculator, 'batch_v5');
                updated++;
                if (limit != null && updated >= limit) break;
              }
            }
          }
        }
      } catch (e) {
        errors.push({ batch: offerIds.slice(0, 3), error: e.message || String(e) });
      }

      if (limit != null && updated >= limit) break;
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }

    return { ok: errors.length === 0 || updated > 0, updated, requests, errors };
  }

  async _syncWBCalculatorCacheSequential({ limit, delayMs }) {
    const productsRepo = repositoryFactory.getProductsRepository();
    const categoryMappingsRepo = repositoryFactory.getCategoryMappingsRepository();
    let updated = 0;
    const errors = [];
    let offset = 0;
    const batchSize = 100;

    let wbWarehouseName = null;
    try {
      const warehouses = await readData('warehouses') || [];
      const main = Array.isArray(warehouses) ? warehouses.find(w => w.type === 'warehouse' && w.wbWarehouseName) : null;
      wbWarehouseName = main?.wbWarehouseName || null;
      if (!wbWarehouseName) {
        const whRow = await query(
          `SELECT wb_warehouse_name FROM warehouses WHERE main_warehouse_id IS NULL AND type = 'warehouse' LIMIT 1`
        );
        const fromDb = whRow.rows[0]?.wb_warehouse_name;
        if (fromDb && String(fromDb).trim()) wbWarehouseName = String(fromDb).trim();
      }
    } catch (e) {}

    while (limit == null || updated < limit) {
      const rowsRes = await query(
        `SELECT DISTINCT ps.product_id
         FROM product_skus ps
         WHERE ps.marketplace = 'wb' AND ps.sku IS NOT NULL AND TRIM(ps.sku) <> ''
         ORDER BY ps.product_id
         LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );
      if (!rowsRes.rows.length) break;
      offset += rowsRes.rows.length;

      for (const row of rowsRes.rows) {
        if (limit != null && updated >= limit) break;
        const productId = row.product_id;
        const product = await productsRepo.findById(productId);
        if (!product) continue;
        const skuRow = await query(
          `SELECT TRIM(sku) AS sku FROM product_skus WHERE product_id = $1 AND marketplace = 'wb' LIMIT 1`,
          [productId]
        );
        const skuWb = skuRow.rows[0]?.sku || product.sku_wb || product.sku;
        if (!skuWb) continue;
        const mappings = await categoryMappingsRepo.findAll({ productId });
        const wbMapping = mappings.find(m => m.marketplace === 'wb' || m.marketplace === 'wildberries');
        const wbCategoryId = wbMapping?.category_id ?? null;
        if (!wbCategoryId && !product.user_category_id) {
          errors.push({ productId, error: 'Нет категории WB' });
          continue;
        }
        try {
          const res = await this.getWBPrices(skuWb, wbCategoryId, wbWarehouseName, product.user_category_id || null, {
            source: 'live'
          });
          if (res.found) updated++;
          else errors.push({ productId, error: res.error || res.message || 'WB' });
        } catch (e) {
          errors.push({ productId, error: e.message || String(e) });
        }
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      }
      if (limit != null && updated >= limit) break;
    }

    return { ok: errors.length === 0 || updated > 0, updated, errors: errors.slice(0, 500) };
  }

  async _syncYMCalculatorCacheSequential({ limit, delayMs }) {
    const productsRepo = repositoryFactory.getProductsRepository();
    const categoryMappingsRepo = repositoryFactory.getCategoryMappingsRepository();
    let updated = 0;
    const errors = [];
    let offset = 0;
    const batchSize = 100;

    while (limit == null || updated < limit) {
      const rowsRes = await query(
        `SELECT DISTINCT ps.product_id
         FROM product_skus ps
         WHERE ps.marketplace = 'ym' AND ps.sku IS NOT NULL AND TRIM(ps.sku) <> ''
         ORDER BY ps.product_id
         LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );
      if (!rowsRes.rows.length) break;
      offset += rowsRes.rows.length;

      for (const row of rowsRes.rows) {
        if (limit != null && updated >= limit) break;
        const productId = row.product_id;
        const product = await productsRepo.findById(productId);
        if (!product) continue;
        const skuRow = await query(
          `SELECT TRIM(sku) AS sku FROM product_skus WHERE product_id = $1 AND marketplace = 'ym' LIMIT 1`,
          [productId]
        );
        const skuYm = skuRow.rows[0]?.sku || product.sku_ym || product.sku;
        if (!skuYm) continue;
        const mappings = await categoryMappingsRepo.findAll({ productId });
        const ymMapping = mappings.find(m => m.marketplace === 'ym' || m.marketplace === 'yandex');
        const ymCategoryId = ymMapping?.category_id ?? null;
        const ymUserCategoryId = !ymCategoryId && product.user_category_id ? product.user_category_id : null;
        if (!ymCategoryId && !ymUserCategoryId) {
          errors.push({ productId, error: 'Нет категории YM' });
          continue;
        }
        try {
          const res = await this.getYMPrices(skuYm, ymCategoryId, ymUserCategoryId, { source: 'live' });
          if (res.found) updated++;
          else errors.push({ productId, error: res.error || res.message || 'YM' });
        } catch (e) {
          errors.push({ productId, error: e.message || String(e) });
        }
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      }
      if (limit != null && updated >= limit) break;
    }

    return { ok: errors.length === 0 || updated > 0, updated, errors: errors.slice(0, 500) };
  }

  /**
   * @param {string} offer_id
   * @param {{ source?: 'live'|'cache'|'auto' }} [options] — source=cache: только БД; auto|live: API Ozon (по умолчанию live)
   */
  async getOzonPrices(offer_id, options = {}) {
    try {
      const source = options.source || 'live';

      if (source === 'cache') {
        const pid = await this._getProductIdByMarketplaceSku('ozon', offer_id);
        if (!pid) {
          return { found: false, error: 'Товар с таким Ozon offer_id не найден в каталоге' };
        }
        const cached = await this._getMpCalculatorCacheRow(pid, 'ozon');
        if (cached?.calculator) {
          return { found: true, calculator: cached.calculator, fromCache: true };
        }
        return {
          found: false,
          error: 'Нет сохранённого калькулятора Ozon для товара. Запустите POST /api/product/prices/sync-calculator-cache (marketplaces: ["ozon"]).'
        };
      }

      // Получаем конфигурацию Ozon через integrationsService
      const integrations = await integrationsService.getAll();
      const ozonIntegration = integrations.find(i => i.code === 'ozon');
      const client_id = ozonIntegration?.config?.client_id;
      const api_key = ozonIntegration?.config?.api_key;
      
      if (!client_id || !api_key) {
        return {
          found: false,
          error: 'Необходимы Client ID и API Key для подключения к Ozon'
        };
      }
      
      console.log(`[Prices Service] Getting Ozon prices for offer_id: ${offer_id}`);
      
      // Используем endpoint v5 для получения детальной информации о ценах
      const response = await fetch('https://api-seller.ozon.ru/v5/product/info/prices', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Client-Id': String(client_id),
          'Api-Key': String(api_key)
        },
        body: JSON.stringify({
          cursor: "",
          filter: {
            offer_id: [offer_id],
            visibility: "ALL"
          },
          limit: 100
        }),
        timeout: 10000
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Prices Service] Ozon API error: ${response.status}`, errorText);
        return {
          found: false,
          error: `API Error: ${errorText.substring(0, 100)}`
        };
      }
      
      const data = await response.json();
      const items = data.items || (data.result && data.result.items);
      
      if (!items || items.length === 0) {
        return {
          found: false,
          message: 'Информация о ценах не найдена'
        };
      }
      
      const item = items[0];
      const built = await applyOzonV5ItemToCalculator(item, offer_id, client_id, api_key);
      if (built.found && built.calculator) {
        await this._tryUpsertMpCalculatorCacheFromOffer('ozon', offer_id, built.calculator, 'live_v5');
      }
      return built;
    } catch (error) {
      console.error('[Prices Service] Error getting Ozon prices:', error);
      return {
        found: false,
        error: error.message
      };
    }
  }

  async getWBPrices(offer_id, category_id, wbWarehouseName = null, userCategoryId = null, options = {}) {
    try {
      const source = options.source || 'live';
      if (source === 'cache') {
        const pid = await this._getProductIdByMarketplaceSku('wb', offer_id);
        if (!pid) {
          return { found: false, error: 'Товар с таким артикулом WB не найден в каталоге' };
        }
        const cached = await this._getMpCalculatorCacheRow(pid, 'wb');
        if (cached?.calculator) {
          return { found: true, calculator: cached.calculator, fromCache: true };
        }
        return {
          found: false,
          error: 'Нет сохранённого калькулятора WB. Запустите POST /api/product/prices/sync-calculator-cache (marketplaces: ["wb"]).'
        };
      }

      // Получаем конфигурацию WB через integrationsService
      const integrations = await integrationsService.getAll();
      const wbIntegration = integrations.find(i => i.code === 'wildberries');
      const api_key = wbIntegration?.config?.api_key;
      
      if (!api_key) {
        return {
          found: false,
          error: 'Необходим API Key для подключения к Wildberries'
        };
      }
      
      // Для WB используем category_id напрямую как subjectID из комиссий
      // category_id в category_mappings для WB хранит subjectID из wb_commissions
      let wbCategoryId = category_id;
      
      // Fallback: если category_id не передан, берём WB-категорию из user_category.marketplace_mappings
      let fallbackCategoryId = userCategoryId;
      if ((!wbCategoryId || wbCategoryId === 'undefined' || wbCategoryId === 'null') && !fallbackCategoryId) {
        try {
          const productResult = await query(
            `SELECT p.user_category_id
             FROM products p
             LEFT JOIN product_skus ps_wb ON ps_wb.product_id = p.id AND ps_wb.marketplace = 'wb'
             WHERE (ps_wb.sku = $1 OR p.sku = $1)
             LIMIT 1`,
            [offer_id]
          );
          fallbackCategoryId = productResult.rows?.[0]?.user_category_id;
        } catch (err) {
          logger.warn('[Prices Service] Error finding product by offer_id:', err.message);
        }
      }
      if ((!wbCategoryId || wbCategoryId === 'undefined' || wbCategoryId === 'null') && fallbackCategoryId) {
        try {
          const catResult = await query(
              `SELECT marketplace_mappings FROM user_categories WHERE id = $1`,
              [fallbackCategoryId]
            );
            const mm = catResult.rows?.[0]?.marketplace_mappings;
          if (mm && typeof mm === 'object' && (mm.wb || mm.wildberries)) {
            wbCategoryId = String(mm.wb || mm.wildberries || '');
            if (wbCategoryId) {
              logger.info(`[Prices Service] Using WB category from user_category.marketplace_mappings: ${wbCategoryId} for ${offer_id}`);
            }
          }
        } catch (err) {
          logger.warn('[Prices Service] Error getting WB category from user_category:', err.message);
        }
      }
      
      if (!wbCategoryId || wbCategoryId === 'undefined' || wbCategoryId === 'null') {
        console.warn(`[Prices Service] ⚠ WARNING: category_id is not provided for product ${offer_id}!`);
        console.warn(`[Prices Service] Please ensure category mapping is set up for this product in Categories section.`);
      }
      
      // Получаем комиссию из БД по subjectID (category_id для WB = subjectID из комиссий)
      let categoryCommission = null;
      
      console.log(`[Prices Service] Getting WB commission for category_id: ${category_id}, using as subjectID: ${wbCategoryId}`);
      
      if (wbCategoryId) {
        try {
          // Пытаемся получить комиссию по subjectID (category_id) из БД
          categoryCommission = await wbMarketplaceService.getCommissionByCategoryId(parseInt(wbCategoryId));
          
          if (categoryCommission) {
            console.log(`[Prices Service] Found commission in DB for category ${wbCategoryId}:`, {
              commission_percent: categoryCommission.commission_percent,
              has_raw_data: !!categoryCommission.raw_data
            });
          } else {
            console.log(`[Prices Service] Commission not found in DB for category ${wbCategoryId}, trying parent category...`);
          }
          
          // Если не найдена, пробуем найти комиссию для родительской категории из wb_commissions
          if (!categoryCommission && category_id) {
            try {
              // Получаем parentID из wb_commissions по subjectID (category_id)
              const commissionResult = await query(
                `SELECT raw_data FROM wb_commissions WHERE category_id = $1`,
                [parseInt(category_id)]
              );
              
              if (commissionResult.rows.length > 0 && commissionResult.rows[0].raw_data) {
                let rawData = {};
                try {
                  rawData = typeof commissionResult.rows[0].raw_data === 'string' 
                    ? JSON.parse(commissionResult.rows[0].raw_data) 
                    : commissionResult.rows[0].raw_data;
                } catch (e) {
                  console.warn('[Prices Service] Failed to parse raw_data for parent lookup');
                }
                
                if (rawData.parentID) {
                  console.log(`[Prices Service] Trying parent category commission for parentID: ${rawData.parentID}`);
                  categoryCommission = await wbMarketplaceService.getCommissionByCategoryId(parseInt(rawData.parentID));
                  
                  if (categoryCommission) {
                    console.log(`[Prices Service] Found commission in DB for parent category ${rawData.parentID}`);
                  }
                }
              }
            } catch (err) {
              console.warn('[Prices Service] Error getting parent category commission:', err);
            }
          }
        } catch (err) {
          console.warn('[Prices Service] Error getting commission from DB:', err);
        }
      }
      
      // Если комиссия не найдена в БД, используем fallback на кэш (для обратной совместимости)
      // ВАЖНО: Кэш используется только если category_id не передан или комиссия не найдена в БД
      if (!categoryCommission) {
        if (wbCategoryId) {
          console.warn(`[Prices Service] Commission not found in DB for category ${wbCategoryId}, trying cache fallback...`);
        } else {
          console.warn(`[Prices Service] category_id not provided, trying to find commission from cache (may be incorrect)...`);
        }
        
        const { commissions: cachedCommissions } = getWBCachedData();
        
        if (wbCategoryId && cachedCommissions.length > 0) {
          categoryCommission = cachedCommissions.find(cat => 
            cat.subjectID == wbCategoryId || cat.parentID == wbCategoryId
          );
          if (categoryCommission) {
            console.warn(`[Prices Service] ⚠ Using cached commission for category ${wbCategoryId} - this may be incorrect!`);
          }
        }
        
        // НЕ используем первую комиссию из кэша как fallback - это будет неправильно!
        // Лучше вернуть ошибку, чем использовать неправильную комиссию
        if (!categoryCommission) {
          if (wbCategoryId) {
            return {
              found: false,
              error: `Комиссия не найдена для категории ${wbCategoryId}. Пожалуйста, обновите категории и комиссии WB в настройках интеграции.`
            };
          } else {
            return {
              found: false,
              error: `Категория не указана для товара ${offer_id}. Пожалуйста, настройте маппинг категории для этого товара в разделе "Категории".`
            };
          }
        }
      }
      
      // Используем кэшированные данные складов (пока не перенесены в БД)
      const wbWarehouses = getWBWarehousesCache();
      
      // Получаем тарифы из кэша через integrationsService
      let boxTariffsData = null;
      try {
        boxTariffsData = await integrationsService.getWildberriesTariffs();
      } catch (error) {
        console.error('[Prices Service] Error getting WB tariffs from cache:', error);
      }
      
      // Ищем склад для расчета логистики через маппинг основного склада
      // Автоматически используем склад WB, сопоставленный с основным складом в warehouse_mappings
      let finalWbWarehouseName = null;
      
      console.log(`[Prices Service] ========== WB WAREHOUSE MAPPING SEARCH ==========`);
      console.log(`[Prices Service] Provided wbWarehouseName: "${wbWarehouseName || 'none'}"`);
      
      try {
        // Находим основной склад (main_warehouse_id IS NULL)
        const mainWarehouseResult = await query(
          `SELECT id FROM warehouses WHERE main_warehouse_id IS NULL AND type = 'warehouse' LIMIT 1`
        );
        
        console.log(`[Prices Service] Main warehouse query result: ${mainWarehouseResult.rows.length} rows`);
        
        const warehouseMappingsRepo = repositoryFactory.getRepository('warehouse_mappings');
        if (mainWarehouseResult.rows.length > 0) {
          const mainWarehouseId = mainWarehouseResult.rows[0].id;
          console.log(`[Prices Service] ✓ Found main warehouse ID: ${mainWarehouseId}`);
          
          // Находим маппинг для основного склада и WB маркетплейса
          console.log(`[Prices Service] Searching for warehouse mapping: warehouse_id=${mainWarehouseId}, marketplace='wb'`);
          
          const mapping = await warehouseMappingsRepo.findByWarehouseAndMarketplace(mainWarehouseId, 'wb');
          
          if (mapping && mapping.marketplace_warehouse_id) {
            finalWbWarehouseName = mapping.marketplace_warehouse_id;
            console.log(`[Prices Service] ✓✓✓ Found warehouse mapping for main warehouse: "${finalWbWarehouseName}"`);
            console.log(`[Prices Service] Using mapped WB warehouse for FBS logistics calculation (overriding provided: "${wbWarehouseName || 'none'}")`);
          } else {
            console.log(`[Prices Service] ✗ No warehouse mapping found for main warehouse ID ${mainWarehouseId}`);
            console.log(`[Prices Service] Mapping result:`, mapping);
            // Пробуем взять имя склада WB из поля основного склада (warehouses.wb_warehouse_name)
            const whRow = await query(
              'SELECT wb_warehouse_name FROM warehouses WHERE id = $1',
              [mainWarehouseId]
            );
            const fromWarehouse = whRow.rows[0]?.wb_warehouse_name;
            if (fromWarehouse && String(fromWarehouse).trim()) {
              finalWbWarehouseName = String(fromWarehouse).trim();
              console.log(`[Prices Service] ✓ Using wb_warehouse_name from main warehouse: "${finalWbWarehouseName}"`);
            }
            // Если привязка есть у другого склада — берём любой маппинг WB
            if (!finalWbWarehouseName) {
              const allWb = await warehouseMappingsRepo.findByMarketplace('wb');
              const first = allWb && allWb[0];
              if (first && first.marketplace_warehouse_id) {
                finalWbWarehouseName = String(first.marketplace_warehouse_id).trim();
                console.log(`[Prices Service] ✓ Using WB mapping from warehouse_id=${first.warehouse_id}: "${finalWbWarehouseName}"`);
              }
            }
          }
        } else {
          console.log('[Prices Service] ✗ No main warehouse found (main_warehouse_id IS NULL AND type = warehouse)');
        }
        // Если всё ещё нет — ищем любой маппинг WB (привязка может быть у любого склада)
        if (!finalWbWarehouseName) {
          const allWb = await warehouseMappingsRepo.findByMarketplace('wb');
          const first = allWb && allWb[0];
          if (first && first.marketplace_warehouse_id) {
            finalWbWarehouseName = String(first.marketplace_warehouse_id).trim();
            console.log(`[Prices Service] ✓ Using first available WB mapping (warehouse_id=${first.warehouse_id}): "${finalWbWarehouseName}"`);
          }
        }
      } catch (error) {
        console.error('[Prices Service] ✗✗✗ Error finding warehouse mapping:', error);
        console.error('[Prices Service] Error stack:', error.stack);
      }
      
      console.log(`[Prices Service] Final wbWarehouseName after mapping search: "${finalWbWarehouseName || 'null'}"`);
      console.log(`[Prices Service] =================================================`);
      
      // Если не нашли через маппинг и не из warehouses, используем переданный wbWarehouseName (для обратной совместимости)
      if (!finalWbWarehouseName) {
        finalWbWarehouseName = wbWarehouseName;
        if (finalWbWarehouseName) {
          console.log(`[Prices Service] Using provided wbWarehouseName: "${finalWbWarehouseName}"`);
        }
      }
      
      // Поддержка разных форматов ответа API WB: response.data.warehouseList или data.warehouseList или warehouseList
      const warehouseList = boxTariffsData?.response?.data?.warehouseList
        ?? boxTariffsData?.data?.warehouseList
        ?? boxTariffsData?.warehouseList;
      const isWarehouseListValid = Array.isArray(warehouseList) && warehouseList.length > 0;

      if (!isWarehouseListValid) {
        logger.warn('[Prices Service] WB tariffs check failed', {
          hasResponse: !!boxTariffsData?.response,
          hasResponseData: !!boxTariffsData?.response?.data,
          hasData: !!boxTariffsData?.data,
          topLevelKeys: boxTariffsData ? Object.keys(boxTariffsData) : [],
          responseDataKeys: boxTariffsData?.response?.data ? Object.keys(boxTariffsData.response.data) : []
        });
        return {
          found: false,
          error: 'Тарифы Wildberries не загружены. Пожалуйста, обновите тарифы в настройках интеграции.'
        };
      }

      // Если склад все еще не найден, возвращаем ошибку с инструкцией по настройке маппинга
      if (!finalWbWarehouseName) {
        return {
          found: false,
          error: 'Для расчета логистики Wildberries необходимо настроить сопоставление склада WB с основным складом. Пожалуйста, настройте маппинг склада WB для основного склада в разделе "Склады" → выберите основной склад → настройте сопоставление с маркетплейсом Wildberries.'
        };
      }

      // Находим тарифы для конкретного склада
      let selectedBoxTariffs = null;

      // Убираем префикс "Маркетплейс: " если он есть
      const normalizedName = finalWbWarehouseName.replace(/^Маркетплейс:\s*/i, '').trim();

      // Ищем склад по имени (точное совпадение или регистронезависимое). Поле может быть warehouseName или geoName
      selectedBoxTariffs = warehouseList.find(w => {
        const wName = (w.warehouseName ?? w.geoName ?? '').toString().trim();
        return wName === finalWbWarehouseName ||
               wName === normalizedName ||
               wName.toLowerCase() === finalWbWarehouseName.toLowerCase() ||
               wName.toLowerCase() === normalizedName.toLowerCase();
      });

      if (!selectedBoxTariffs) {
        const availableWarehouses = warehouseList.map(w => w.warehouseName ?? w.geoName).filter(Boolean).join(', ');
        return {
          found: false,
          error: `Склад "${finalWbWarehouseName}" не найден в тарифах Wildberries. Доступные склады: ${availableWarehouses}`
        };
      }
      
      console.log(`[Prices Service] Found tariffs for warehouse: "${selectedBoxTariffs.warehouseName}" (requested: "${finalWbWarehouseName}", original: "${wbWarehouseName || 'not provided'}")`);
      
      // Для возвратов используем первый склад (возвраты обычно не зависят от склада)
      const baseReturnTariffs = warehouseList[0] || null;
      
      const fbsLogisticsFirstLiter = selectedBoxTariffs?.boxDeliveryBase || 0;
      const fboLogisticsFirstLiter = selectedBoxTariffs?.boxDeliveryMarketplaceBase || 0;
      const returnDeliveryBase = baseReturnTariffs?.deliveryDumpSupOfficeBase || 0;
      const returnDeliveryExpr = baseReturnTariffs?.deliveryDumpSupReturnExpr || 0;
      
      // Получаем объем и себестоимость товара из базы данных
      let productVolume = null;
      let productCost = null;
      try {
        console.log(`[Prices Service] Looking for product with offer_id: "${offer_id}"`);
        // SKU маркетплейсов хранятся в таблице product_skus, а не в products
        const productResult = await query(
          `SELECT p.id, p.sku, p.volume, p.cost, p.price,
                  ps_wb.sku as sku_wb
           FROM products p
           LEFT JOIN product_skus ps_wb ON ps_wb.product_id = p.id AND ps_wb.marketplace = 'wb'
           WHERE (ps_wb.sku = $1 OR p.sku = $1)
           LIMIT 1`,
          [offer_id]
        );
        
        if (productResult.rows && productResult.rows.length > 0) {
          const row = productResult.rows[0];
          console.log(`[Prices Service] Found product: id=${row.id}, sku="${row.sku}", sku_wb="${row.sku_wb || 'N/A'}", cost=${row.cost}, price=${row.price}`);
          
          if (row.volume) {
            productVolume = parseFloat(row.volume);
            console.log(`[Prices Service] Got product volume from database: ${productVolume} liters for ${offer_id}`);
          }
          
          // Получаем себестоимость (cost) - может быть число или null
          if (row.cost != null && row.cost !== '' && !isNaN(Number(row.cost)) && Number(row.cost) > 0) {
            productCost = Number(row.cost);
            console.log(`[Prices Service] ✓ Got product cost from database: ${productCost}₽ for ${offer_id}`);
          } else {
            // Если cost не указан или равен 0, пробуем использовать price как fallback
            if (row.price != null && row.price !== '' && !isNaN(Number(row.price)) && Number(row.price) > 0) {
              productCost = Number(row.price);
              console.log(`[Prices Service] ⚠ Product cost not set, using price as fallback: ${productCost}₽ for ${offer_id}`);
            } else {
              console.log(`[Prices Service] ⚠ Product cost not found or invalid for ${offer_id} (cost=${row.cost}, price=${row.price}), will use 0`);
            }
          }
        } else {
          console.warn(`[Prices Service] ⚠ Product not found in database for offer_id: "${offer_id}"`);
        }
      } catch (dbError) {
        console.error(`[Prices Service] ✗ Failed to get product data from database:`, dbError.message);
        console.error(`[Prices Service] Error stack:`, dbError.stack);
      }
      
      // Рассчитываем логистику ФБС: boxDeliveryMarketplaceBase + boxDeliveryMarketplaceLiter * (volume - 1)
      let logisticsCost = 0;
      let logisticsBase = 0;
      let logisticsLiter = 0;
      
      if (selectedBoxTariffs && productVolume && productVolume > 0) {
        // Преобразуем строковые значения с запятыми в числа (например, "40" или "11,2" -> 40 или 11.2)
        const baseStr = String(selectedBoxTariffs.boxDeliveryMarketplaceBase || '0').replace(',', '.');
        const literStr = String(selectedBoxTariffs.boxDeliveryMarketplaceLiter || '0').replace(',', '.');
        logisticsBase = parseFloat(baseStr) || 0;
        logisticsLiter = parseFloat(literStr) || 0;
        
        let additionalLiters = 0;
        if (productVolume <= 1) {
          logisticsCost = logisticsBase;
        } else {
          // Округляем (volume - 1) вверх
          additionalLiters = Math.ceil(productVolume - 1);
          logisticsCost = logisticsBase + logisticsLiter * additionalLiters;
        }
        
        console.log(`[Prices Service] Calculated WB FBS logistics: ${logisticsCost}₽ (base: ${logisticsBase}₽, liter: ${logisticsLiter}₽, volume: ${productVolume}L, additionalLiters: ${additionalLiters})`);
      } else {
        // Если объема нет или тарифы не найдены, используем базовое значение
        if (selectedBoxTariffs) {
          // Если тарифы есть, но объема нет, используем базовые значения из тарифов
          const baseStr = String(selectedBoxTariffs.boxDeliveryMarketplaceBase || '0').replace(',', '.');
          const literStr = String(selectedBoxTariffs.boxDeliveryMarketplaceLiter || '0').replace(',', '.');
          logisticsBase = parseFloat(baseStr) || 0;
          logisticsLiter = parseFloat(literStr) || 0;
          logisticsCost = logisticsBase;
        } else {
          // Если тарифы не найдены, используем fallback
          const baseStr = String(fboLogisticsFirstLiter || '0').replace(',', '.');
          logisticsCost = parseFloat(baseStr) || 0;
          logisticsBase = logisticsCost;
          logisticsLiter = 0;
        }
        console.warn(`[Prices Service] Cannot calculate logistics from volume, using base value: ${logisticsCost}₽`);
      }
      
      // Определяем проценты комиссии в зависимости от источника данных
      let fboPercent = 0;
      let fbsPercent = 0;
      
      // Сначала проверяем raw_data (самый полный источник)
      if (categoryCommission.raw_data) {
        try {
          const rawData = typeof categoryCommission.raw_data === 'string' 
            ? JSON.parse(categoryCommission.raw_data) 
            : categoryCommission.raw_data;
          
          // Логируем полную структуру raw_data для отладки
          console.log(`[Prices Service] Raw data structure for category ${wbCategoryId}:`, {
            allKeys: Object.keys(rawData),
            kgvpMarketplace: rawData.kgvpMarketplace,
            kgvpSupplier: rawData.kgvpSupplier,
            commission: rawData.commission,
            commissionPercent: rawData.commissionPercent,
            subjectID: rawData.subjectID,
            name: rawData.name,
            fullRawData: JSON.stringify(rawData, null, 2)
          });
          
          // Правильное назначение полей из API WB:
          // kgvpMarketplace - Маркетплейс (FBS) - когда продавец сам отправляет
          // paidStorageKgvp - Склад WB (FBW/FBO) - когда товар на складе WB
          // kgvpSupplier - Витрина (DBS)/Курьер WB (DBW) - другие схемы
          
          // ВАЖНО: Для FBS используем ТОЛЬКО kgvpMarketplace из raw_data
          // НЕ используем commission_percent или другие поля!
          if (rawData.kgvpMarketplace !== undefined && rawData.kgvpMarketplace !== null) {
            fbsPercent = parseFloat(rawData.kgvpMarketplace || 0);
            if (fbsPercent > 0) {
              console.log(`[Prices Service] ✓ Found kgvpMarketplace (FBS) in raw_data: ${fbsPercent}%`);
            } else {
              console.warn(`[Prices Service] ⚠ kgvpMarketplace found but is 0 or invalid: ${rawData.kgvpMarketplace}`);
            }
          } else {
            console.warn(`[Prices Service] ⚠ kgvpMarketplace NOT FOUND in raw_data for category ${wbCategoryId}`);
            console.warn(`[Prices Service] Available fields in raw_data:`, Object.keys(rawData));
            // НЕ используем commission_percent или другие поля как fallback!
          }
          if (rawData.paidStorageKgvp !== undefined && rawData.paidStorageKgvp !== null) {
            fboPercent = parseFloat(rawData.paidStorageKgvp || 0);
            console.log(`[Prices Service] Found paidStorageKgvp (FBO/FBW) in raw_data: ${fboPercent}%`);
          }
          
          // Fallback: если не нашли paidStorageKgvp для FBO, пробуем kgvpSupplier
          if (fboPercent === 0 && rawData.kgvpSupplier !== undefined && rawData.kgvpSupplier !== null) {
            fboPercent = parseFloat(rawData.kgvpSupplier || 0);
            console.log(`[Prices Service] Using kgvpSupplier as fallback for FBO: ${fboPercent}%`);
          }
          
          // ВАЖНО: Для WB используем только FBS комиссию (kgvpMarketplace)
          // НЕ используем FBO комиссию как fallback для FBS!
          // Если FBS комиссия не найдена, оставляем 0 и логируем предупреждение
          if (fbsPercent === 0) {
            console.warn(`[Prices Service] ⚠ WARNING: FBS commission (kgvpMarketplace) not found in raw_data for category ${wbCategoryId}!`);
            console.warn(`[Prices Service] Available fields:`, Object.keys(rawData));
          }
          
          // Для FBO можно использовать FBS как fallback (но не наоборот!)
          if (fbsPercent > 0 && fboPercent === 0) {
            fboPercent = fbsPercent;
            console.log(`[Prices Service] Using FBS commission for FBO as fallback (${fboPercent}%)`);
          }
          
          // Альтернативные поля из API (если не нашли основные поля)
          // Проверяем различные варианты названий полей
          if (fboPercent === 0 && fbsPercent === 0) {
            // Проверяем возможные варианты названий для FBO/FBW (Склад WB)
            const fboFields = ['paidStorageKgvp', 'paid_storage_kgvp', 'storageCommission', 
                              'fboCommission', 'fbo_commission', 'fbwCommission', 'fbw_commission'];
            for (const field of fboFields) {
              if (rawData[field] !== undefined && rawData[field] !== null) {
                fboPercent = parseFloat(rawData[field] || 0);
                console.log(`[Prices Service] Found FBO/FBW commission in field ${field}: ${fboPercent}%`);
                break;
              }
            }
            
            // Проверяем возможные варианты названий для FBS (Маркетплейс)
            const fbsFields = ['kgvpMarketplace', 'kgvp_marketplace', 'marketplaceCommission', 
                              'fbsCommission', 'fbs_commission', 'marketplace_percent'];
            for (const field of fbsFields) {
              if (rawData[field] !== undefined && rawData[field] !== null) {
                fbsPercent = parseFloat(rawData[field] || 0);
                console.log(`[Prices Service] Found FBS commission in field ${field}: ${fbsPercent}%`);
                break;
              }
            }
            
            // Если все еще не нашли, пробуем общие поля
            if (fboPercent === 0 && fbsPercent === 0) {
              if (rawData.commission !== undefined && rawData.commission !== null) {
                const commission = parseFloat(rawData.commission || 0);
                fboPercent = commission;
                fbsPercent = commission;
                console.log(`[Prices Service] Using commission from raw_data: ${commission}%`);
              } else if (rawData.commissionPercent !== undefined && rawData.commissionPercent !== null) {
                const commission = parseFloat(rawData.commissionPercent || 0);
                fboPercent = commission;
                fbsPercent = commission;
                console.log(`[Prices Service] Using commissionPercent from raw_data: ${commission}%`);
              }
            }
          }
        } catch (err) {
          console.warn('[Prices Service] Error parsing raw_data:', err);
        }
      }
      
      // ВАЖНО: Для WB НЕ используем commission_percent как fallback для FBS!
      // commission_percent может быть устаревшим или неправильным значением.
      // Используем ТОЛЬКО kgvpMarketplace из raw_data для FBS комиссии.
      if (fbsPercent === 0) {
        console.error(`[Prices Service] ✗ ERROR: FBS commission (kgvpMarketplace) not found in raw_data for category ${wbCategoryId}!`);
        console.error(`[Prices Service] This means the commission data is missing or incorrect.`);
        console.error(`[Prices Service] Available data:`, {
          has_raw_data: !!categoryCommission.raw_data,
          commission_percent: categoryCommission.commission_percent,
          category_id: categoryCommission.category_id
        });
        // НЕ используем commission_percent - он может быть неправильным!
        // Лучше вернуть ошибку или использовать 0, чем неправильное значение
      }
      
      // Если комиссия из кэша (старая структура для обратной совместимости)
      // ИСПРАВЛЕНО: kgvpMarketplace - это FBS, а не FBO!
      // ВАЖНО: Используем кэш ТОЛЬКО если не нашли в raw_data И category_id указан
      if (fbsPercent === 0 && categoryCommission && categoryCommission.kgvpMarketplace !== undefined && categoryCommission.kgvpMarketplace !== null) {
        // kgvpMarketplace - это FBS (Маркетплейс)
        fbsPercent = parseFloat(categoryCommission.kgvpMarketplace || 0);
        console.log(`[Prices Service] Using cached kgvpMarketplace (FBS) value: ${fbsPercent}%`);
      }
      if (fboPercent === 0 && categoryCommission && categoryCommission.kgvpSupplier !== undefined && categoryCommission.kgvpSupplier !== null) {
        // kgvpSupplier - это FBO/FBW (Склад WB)
        fboPercent = parseFloat(categoryCommission.kgvpSupplier || 0);
        console.log(`[Prices Service] Using cached kgvpSupplier (FBO) value: ${fboPercent}%`);
      }
      
      // ВАЖНО: НЕ используем commission_percent как fallback!
      // commission_percent может быть устаревшим или неправильным значением.
      // Для WB используем ТОЛЬКО kgvpMarketplace из raw_data или кэша для FBS комиссии.
      if (fbsPercent === 0) {
        console.error(`[Prices Service] ✗ ERROR: FBS commission (kgvpMarketplace) not found in raw_data or cache for category ${wbCategoryId}!`);
        console.error(`[Prices Service] This means the commission data is missing or incorrect.`);
        console.error(`[Prices Service] Available data:`, {
          has_raw_data: !!categoryCommission?.raw_data,
          commission_percent: categoryCommission?.commission_percent,
          kgvpMarketplace_from_cache: categoryCommission?.kgvpMarketplace,
          category_id: categoryCommission?.category_id,
          provided_category_id: category_id
        });
        console.error(`[Prices Service] Cannot calculate WB price correctly without FBS commission.`);
        // Возвращаем ошибку вместо использования неправильного commission_percent
        return {
          found: false,
          error: `Комиссия FBS (Маркетплейс) не найдена для категории ${wbCategoryId}. Пожалуйста, обновите категории и комиссии WB в настройках интеграции.`
        };
      }
      
      // Логируем финальные значения комиссий и источник данных
      console.log(`[Prices Service] ✓ Final commission percentages for category ${wbCategoryId}:`);
      console.log(`[Prices Service]   FBS (Маркетплейс, kgvpMarketplace): ${fbsPercent}%`);
      console.log(`[Prices Service]   FBO/FBW (Склад WB, paidStorageKgvp): ${fboPercent}%`);
      console.log(`[Prices Service]   Source: raw_data.kgvpMarketplace (NOT commission_percent)`);
      console.log(`[Prices Service]   commission_percent from DB: ${categoryCommission.commission_percent}% (NOT USED)`);
      
      // ВАЖНО: Логируем перед созданием calculatorData, чтобы убедиться, что используется правильная комиссия
      console.log(`[Prices Service] ========== CREATING CALCULATOR DATA FOR ${offer_id} ==========`);
      console.log(`[Prices Service] Commission values before creating calculatorData:`);
      console.log(`[Prices Service]   FBS percent (kgvpMarketplace): ${fbsPercent}%`);
      console.log(`[Prices Service]   FBO percent (paidStorageKgvp): ${fboPercent}%`);
      console.log(`[Prices Service]   Category ID: ${wbCategoryId}`);
      console.log(`[Prices Service]   Source: raw_data.kgvpMarketplace (NOT commission_percent)`);
      
      const calculatorData = {
        offer_id: offer_id,
        product_id: offer_id,
        price: productCost != null && productCost > 0 ? productCost : 0, // Используем себестоимость из БД, если она есть
        currency_code: 'RUB',
        commissions: {
          FBO: {
            percent: fboPercent,
            value: 0,
            delivery_amount: parseFloat(fboLogisticsFirstLiter),
            return_amount: parseFloat(returnDeliveryBase)
          },
          FBS: {
            percent: fbsPercent, // ВАЖНО: Для WB используется ТОЛЬКО эта комиссия (FBS из kgvpMarketplace)
            value: 0,
            delivery_amount: parseFloat(fbsLogisticsFirstLiter),
            return_amount: parseFloat(returnDeliveryExpr)
          }
        },
        fullCommissions: {},
        rawCommissions: {},
        boxTariffs: selectedBoxTariffs,
        returnTariffs: baseReturnTariffs,
        categoryCommission: categoryCommission,
        logistics_cost: logisticsCost,
        logistics_base: logisticsBase,
        logistics_liter: logisticsLiter,
        volume_weight: productVolume
      };
      
      calculatorData.fullCommissions = { ...calculatorData.commissions };
      calculatorData.rawCommissions = { ...calculatorData.commissions };
      
      console.log(`[Prices Service] ✓ Final calculatorData for ${offer_id}:`, {
        offer_id: calculatorData.offer_id,
        price: calculatorData.price,
        productCost: productCost,
        volume: calculatorData.volume_weight,
        logistics_cost: calculatorData.logistics_cost,
        fbs_commission: calculatorData.commissions.FBS?.percent,
        fbo_commission: calculatorData.commissions.FBO?.percent,
        note: 'For WB, only FBS commission should be used in calculations'
      });
      console.log(`[Prices Service] =================================================`);
      
      await this._tryUpsertMpCalculatorCacheFromOffer('wb', offer_id, calculatorData, 'live');

      return {
        found: true,
        calculator: calculatorData,
        fullCommissions: calculatorData.fullCommissions,
        rawCommissions: calculatorData.rawCommissions,
        boxTariffs: calculatorData.boxTariffs,
        returnTariffs: calculatorData.returnTariffs,
        categoryCommission: calculatorData.categoryCommission
      };
    } catch (error) {
      console.error('[Prices Service] Error getting WB prices:', error);
      return {
        found: false,
        error: error.message
      };
    }
  }

  /**
   * Получить расчёт цен для Yandex.Market через POST /tariffs/calculate (Калькулятор)
   * @param {string} offer_id — артикул/SKU товара
   * @param {string} [categoryId] — ID категории YM (из category_mappings или marketplace_mappings.ym)
   * @param {string} [userCategoryId] — ID user_category для fallback из marketplace_mappings
   */
  async getYMPrices(offer_id, categoryId = null, userCategoryId = null, options = {}) {
    logger.info(`[Prices Service] getYMPrices called\n  offer_id: ${offer_id}\n  categoryId: ${categoryId}\n  userCategoryId: ${userCategoryId}`);
    try {
      const source = options.source || 'live';
      if (source === 'cache') {
        const pid = await this._getProductIdByMarketplaceSku('ym', offer_id);
        if (!pid) {
          return { found: false, error: 'Товар с таким артикулом Yandex.Market не найден в каталоге' };
        }
        const cached = await this._getMpCalculatorCacheRow(pid, 'ym');
        if (cached?.calculator) {
          return { found: true, calculator: cached.calculator, fromCache: true };
        }
        return {
          found: false,
          error: 'Нет сохранённого калькулятора Yandex.Market. Запустите POST /api/product/prices/sync-calculator-cache (marketplaces: ["ym"]).'
        };
      }

      const integrations = await integrationsService.getAll();
      const ymIntegration = integrations.find(i => i.code === 'yandex');
      const api_key = ymIntegration?.config?.api_key;
      const campaign_id = ymIntegration?.config?.campaign_id;

      if (!api_key) {
        logger.warn('[Prices Service] getYMPrices: no API key for Yandex');
        return { found: false, error: 'Необходим API Key для подключения к Yandex.Market' };
      }

      // Разрешаем categoryId: из параметра, или из user_category.marketplace_mappings.ym
      let ymCategoryId = categoryId ? String(categoryId).replace(/[^\d]/g, '') || null : null;
      if ((!ymCategoryId || ymCategoryId === '0') && userCategoryId) {
        try {
          const catResult = await query(
            `SELECT marketplace_mappings FROM user_categories WHERE id = $1`,
            [userCategoryId]
          );
          const mm = catResult.rows?.[0]?.marketplace_mappings;
          if (mm && typeof mm === 'object' && (mm.ym || mm.yandex)) {
            ymCategoryId = String(mm.ym || mm.yandex || '').replace(/[^\d]/g, '') || null;
          }
        } catch (err) {
          logger.warn('[Prices Service] Error getting YM category from user_category:', err.message);
        }
      }
      if ((!ymCategoryId || ymCategoryId === '0') && !userCategoryId) {
        try {
          const productResult = await query(
            `SELECT p.user_category_id FROM products p
             LEFT JOIN product_skus ps_ym ON ps_ym.product_id = p.id AND ps_ym.marketplace = 'ym'
             WHERE (ps_ym.sku = $1 OR p.sku = $1) LIMIT 1`,
            [offer_id]
          );
          const uid = productResult.rows?.[0]?.user_category_id;
          if (uid) {
            const catResult = await query(`SELECT marketplace_mappings FROM user_categories WHERE id = $1`, [uid]);
            const mm = catResult.rows?.[0]?.marketplace_mappings;
            if (mm && typeof mm === 'object' && (mm.ym || mm.yandex)) {
              ymCategoryId = String(mm.ym || mm.yandex || '').replace(/[^\d]/g, '') || null;
            }
          }
        } catch (err) {
          logger.warn('[Prices Service] Error resolving YM category from product:', err.message);
        }
      }

      if (!ymCategoryId || ymCategoryId === '0') {
        logger.warn('[Prices Service] getYMPrices: no YM category', { offer_id });
        return {
          found: false,
          error: `Категория Yandex.Market не указана для товара ${offer_id}. Настройте сопоставление в разделе "Категории".`
        };
      }

      // Получаем товар: только значения из карточки, без дефолтов
      let productRow = null;
      try {
        const productResult = await query(
          `SELECT p.id, p.sku, p.cost, p.price, p.volume, p.weight, p.length, p.width, p.height
           FROM products p
           LEFT JOIN product_skus ps_ym ON ps_ym.product_id = p.id AND ps_ym.marketplace = 'ym'
           WHERE (ps_ym.sku = $1 OR p.sku = $1) LIMIT 1`,
          [offer_id]
        );
        productRow = productResult.rows?.[0] || null;
      } catch (err) {
        logger.warn('[Prices Service] Error getting product for YM:', err.message);
      }

      if (!productRow) {
        logger.warn('[Prices Service] getYMPrices: product not found', { offer_id });
        return {
          found: false,
          error: `Товар ${offer_id} не найден в базе`
        };
      }

      const basePrice = (productRow.cost ?? productRow.price) != null && Number(productRow.cost ?? productRow.price) > 0
        ? Number(productRow.cost ?? productRow.price)
        : null;
      if (basePrice == null) {
        logger.warn('[Prices Service] getYMPrices: no cost/price', { offer_id });
        return {
          found: false,
          error: `У товара ${offer_id} не указана себестоимость или цена в карточке`
        };
      }

      const length = productRow.length != null && Number(productRow.length) > 0 ? Number(productRow.length) : null;
      const width = productRow.width != null && Number(productRow.width) > 0 ? Number(productRow.width) : null;
      const height = productRow.height != null && Number(productRow.height) > 0 ? Number(productRow.height) : null;
      const weight = productRow.weight != null && Number(productRow.weight) > 0 ? Number(productRow.weight) : null;

      if (length == null || width == null || height == null) {
        logger.warn('[Prices Service] getYMPrices: missing dimensions', { offer_id });
        return {
          found: false,
          error: `У товара ${offer_id} не указаны габариты (длина, ширина, высота) в мм`
        };
      }
      if (weight == null) {
        logger.warn('[Prices Service] getYMPrices: missing weight', { offer_id });
        return {
          found: false,
          error: `У товара ${offer_id} не указан вес в кг`
        };
      }

      // YM API ожидает размеры в см, у нас в карточке — в мм
      const lengthCm = length / 10;
      const widthCm = width / 10;
      const heightCm = height / 10;

      const body = {
        offers: [{
          categoryId: parseInt(ymCategoryId, 10),
          price: Math.round(basePrice * 1.3),
          length: Math.round(lengthCm * 100) / 100,
          width: Math.round(widthCm * 100) / 100,
          height: Math.round(heightCm * 100) / 100,
          weight,
          quantity: 1
        }],
        parameters: {
          sellingProgram: 'FBS',
          currency: 'RUR',
          frequency: 'DAILY'
        }
      };

      logger.info(`[Prices Service] YM tariffs/calculate REQUEST\n${JSON.stringify({ url: 'https://api.partner.market.yandex.ru/v2/tariffs/calculate', body }, null, 2)}`);
      const response = await fetch('https://api.partner.market.yandex.ru/v2/tariffs/calculate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': api_key
        },
        body: JSON.stringify(body)
      });

      const responseText = await response.text();
      let responseParsed;
      try { responseParsed = JSON.parse(responseText); } catch { responseParsed = responseText; }
      logger.info(`[Prices Service] YM tariffs/calculate RESPONSE status=${response.status}\n${JSON.stringify(responseParsed, null, 2)}`);
      if (!response.ok) {
        let errBody = responseText;
        try { if (responseText?.startsWith('{')) errBody = JSON.stringify(JSON.parse(responseText), null, 2); } catch (_) {}
        logger.error(`[Prices Service] YM tariffs/calculate error ${response.status}\n${errBody}`);
        return {
          found: false,
          error: `Ошибка API Yandex.Market: ${responseText.substring(0, 150)}`
        };
      }

      const data = JSON.parse(responseText);

      if (data.status === 'ERROR' && data.errors?.length) {
        return {
          found: false,
          error: (data.errors[0]?.message || data.errors[0]?.code || JSON.stringify(data.errors)).substring(0, 200)
        };
      }

      const offers = data.result?.offers || [];
      if (!offers.length || !offers[0].tariffs?.length) {
        return {
          found: false,
          error: 'Yandex.Market не вернул тарифы для товара'
        };
      }

      const tariffs = offers[0].tariffs.filter(Boolean);
      const byType = (type) => tariffs.find(t => String(t?.type || '').trim().toUpperCase() === String(type).toUpperCase());
      // Тарифы YM: AGENCY_COMMISSION (приём платежа = эквайринг) + PAYMENT_TRANSFER (перевод платежа) = эквайринг в расчёте
      // FEE — комиссия Маркета, остальные — доставка/логистика/обработка
      const feeTariff = byType('FEE');
      const agencyTariff = byType('AGENCY_COMMISSION');
      const paymentTransferTariff = byType('PAYMENT_TRANSFER');
      const deliveryTariff = byType('DELIVERY_TO_CUSTOMER');
      const crossRegionalTariff = byType('CROSSREGIONAL_DELIVERY');
      const expressDeliveryTariff = byType('EXPRESS_DELIVERY');
      const sortingTariff = byType('SORTING');
      const middleMileTariff = byType('MIDDLE_MILE');

      const calcPrice = body.offers[0].price;
      const getParam = (t, name) => t?.parameters?.find(p => String(p?.name || '').toLowerCase() === String(name).toLowerCase())?.value;
      const getValueType = (t) => (getParam(t, 'valueType') || 'absolute').toLowerCase();
      const getValueNum = (t) => {
        const v = getParam(t, 'value');
        return v != null && v !== '' ? parseFloat(String(v).replace(',', '.')) : (Number(t?.amount) || 0);
      };

      let feePercent = 0;
      if (feeTariff) {
        const valueParam = feeTariff.parameters?.find(p => p.name === 'valueType');
        if (valueParam?.value === 'relative') {
          const v = feeTariff.parameters?.find(p => p.name === 'value');
          feePercent = v?.value ? parseFloat(String(v.value).replace(',', '.')) : (feeTariff.amount / calcPrice * 100);
        } else {
          feePercent = feeTariff.amount && calcPrice > 0 ? (feeTariff.amount / calcPrice * 100) : 0;
        }
      }
      // Эквайринг YM = приём платежа (AGENCY_COMMISSION) + перевод платежа (PAYMENT_TRANSFER)
      const agencyAmount = (Number(agencyTariff?.amount) || 0) + (Number(paymentTransferTariff?.amount) || 0);
      const acquiringPercent = calcPrice > 0 ? (agencyAmount / calcPrice * 100) : 0;
      logger.info(`[Prices Service] YM acquiring: AGENCY_COMMISSION=${agencyTariff?.amount ?? 0} + PAYMENT_TRANSFER=${paymentTransferTariff?.amount ?? 0} = ${agencyAmount} ₽ => ${acquiringPercent.toFixed(2)}%`);

      const agencyValueType = getValueType(agencyTariff);
      const agencyValueNum = getValueNum(agencyTariff);
      const paymentTransferValueType = getValueType(paymentTransferTariff);
      const paymentTransferValueNum = getValueNum(paymentTransferTariff);
      const deliveryAmount = (deliveryTariff?.amount ?? 0) + (crossRegionalTariff?.amount ?? 0) + (expressDeliveryTariff?.amount ?? 0);
      const processingCost = sortingTariff?.amount ?? 0;
      const logisticsCost = middleMileTariff?.amount ?? 0;

      const deliveryValueType = getValueType(deliveryTariff);
      const deliveryValueNum = getValueNum(deliveryTariff);
      const crossRegionalValueType = getValueType(crossRegionalTariff);
      const crossRegionalValueNum = getValueNum(crossRegionalTariff);
      const expressValueType = getValueType(expressDeliveryTariff);
      const expressValueNum = getValueNum(expressDeliveryTariff);

      const calculator = {
        offer_id,
        product_id: productRow?.id ?? offer_id,
        price: calcPrice,
        currency_code: 'RUB',
        commissions: {
          FBS: {
            percent: feePercent,
            value: feeTariff?.amount ?? 0,
            delivery_amount: deliveryAmount,
            return_amount: 0,
            return_processing_amount: 0
          }
        },
        acquiring: Math.round(acquiringPercent * 100) / 100,
        acquiring_amount_rub: agencyAmount,
        processing_cost: processingCost,
        logistics_cost: logisticsCost,
        volume_weight: productRow?.volume ? parseFloat(productRow.volume) : (length * width * height / 1e6),
        ymTariffs: {
          FEE: { name: 'Размещение товара на Маркете (комиссия)', percent: feePercent, amount: feeTariff?.amount ?? 0 },
          AGENCY_COMMISSION: { name: 'Приём платежа покупателя (эквайринг)', amount: Number(agencyTariff?.amount) || 0, valueType: agencyValueType, value: agencyValueNum },
          PAYMENT_TRANSFER: { name: 'Перевод платежа покупателя', amount: Number(paymentTransferTariff?.amount) || 0, valueType: paymentTransferValueType, value: paymentTransferValueNum },
          DELIVERY_TO_CUSTOMER: { name: 'Доставка покупателю', amount: Number(deliveryTariff?.amount) || 0, valueType: deliveryValueType, value: deliveryValueNum },
          CROSSREGIONAL_DELIVERY: { name: 'Доставка в регион/город/населённый пункт', amount: Number(crossRegionalTariff?.amount) || 0, valueType: crossRegionalValueType, value: crossRegionalValueNum },
          EXPRESS_DELIVERY: { name: 'Экспресс-доставка покупателю', amount: Number(expressDeliveryTariff?.amount) || 0, valueType: expressValueType, value: expressValueNum },
          SORTING: { name: 'Обработка заказа', amount: sortingTariff?.amount ?? 0 },
          MIDDLE_MILE: { name: 'Средняя миля', amount: middleMileTariff?.amount ?? 0 }
        },
        rawTariffs: tariffs.map(t => ({ type: t.type, amount: t.amount, currency: t.currency, parameters: t.parameters }))
      };

      logger.info(`[Prices Service] YM tariffs/calculate OK for ${offer_id}: fee=${feePercent}%, acquiring=${acquiringPercent}%`);

      await this._tryUpsertMpCalculatorCacheFromOffer('ym', offer_id, calculator, 'live');

      return {
        found: true,
        calculator
      };
    } catch (error) {
      logger.error('[Prices Service] Error getting YM prices:', error);
      return {
        found: false,
        error: error.message || 'Ошибка при расчёте цен Yandex.Market'
      };
    }
  }

  /**
   * Оставить только поля калькулятора, нужные для отображения в модалке (избегаем тяжёлых/циклических ссылок).
   * Для WB особенно важно: commissions, logistics_base, logistics_liter, volume_weight, logistics_cost.
   */
  _sanitizeCalculatorForStorage(calc, marketplace) {
    if (!calc || typeof calc !== 'object') return null;
    const out = {
      commissions: calc.commissions || null,
      processing_cost: calc.processing_cost,
      logistics_cost: calc.logistics_cost,
      logistics_base: calc.logistics_base,
      logistics_liter: calc.logistics_liter,
      volume_weight: calc.volume_weight,
      acquiring: calc.acquiring
    };
    if (calc.brand_promotion_percent != null && !isNaN(Number(calc.brand_promotion_percent))) {
      out.brand_promotion_percent = Number(calc.brand_promotion_percent);
    }
    if (marketplace === 'ym' && calc.ymTariffs) out.ymTariffs = calc.ymTariffs;
    if (!out.commissions || typeof out.commissions !== 'object') return null;
    return out;
  }

  /**
   * Сохранить пачку рассчитанных минимальных цен в БД (массив { productId, ozon?, wb?, ym? })
   */
  async saveBulkPrices(pricesList) {
    if (!Array.isArray(pricesList) || pricesList.length === 0) return;
    for (const item of pricesList) {
      const productId = item.productId ?? item.product_id;
      if (productId == null) continue;
      if (item.ozon != null && !isNaN(Number(item.ozon)) && Number(item.ozon) >= 0) {
        const raw = item.ozonDetails ?? item.ozon_details ?? null;
        const details = this._sanitizeCalculatorForStorage(raw, 'ozon') || raw;
        await this.saveProductMarketplacePrice(productId, 'ozon', Number(item.ozon), details);
      }
      if (item.wb != null && !isNaN(Number(item.wb)) && Number(item.wb) >= 0) {
        const raw = item.wbDetails ?? item.wb_details ?? null;
        const details = this._sanitizeCalculatorForStorage(raw, 'wb') || raw;
        await this.saveProductMarketplacePrice(productId, 'wb', Number(item.wb), details);
      }
      if (item.ym != null && !isNaN(Number(item.ym)) && Number(item.ym) >= 0) {
        const raw = item.ymDetails ?? item.ym_details ?? null;
        const details = this._sanitizeCalculatorForStorage(raw, 'ym') || raw;
        await this.saveProductMarketplacePrice(productId, 'ym', Number(item.ym), details);
      }
    }
    logger.info(`[Prices Service] Saved bulk prices for ${pricesList.length} products`);
  }

  /**
   * Сохранить рассчитанную минимальную цену и детали расчёта по маркетплейсу в БД
   * @param {object} [calculationDetails] - данные калькулятора (комиссии, логистика и т.д.) для отображения в модалке
   */
  async saveProductMarketplacePrice(productId, marketplace, minPrice, calculationDetails = null) {
    if (minPrice == null || isNaN(Number(minPrice)) || Number(minPrice) < 0) return;
    const num = Number(minPrice).toFixed(2);
    const toStore = calculationDetails != null && typeof calculationDetails === 'object'
      ? (this._sanitizeCalculatorForStorage(calculationDetails, marketplace) || calculationDetails)
      : null;
    const detailsJson = toStore != null ? JSON.stringify(toStore) : null;
    try {
      await query(
        `INSERT INTO product_marketplace_prices (product_id, marketplace, min_price, calculation_details, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (product_id, marketplace) DO UPDATE SET min_price = $3, calculation_details = $4::jsonb, updated_at = CURRENT_TIMESTAMP`,
        [productId, marketplace, num, detailsJson]
      );
    } catch (err) {
      if (err.message && err.message.includes('calculation_details')) {
        await query(
          `INSERT INTO product_marketplace_prices (product_id, marketplace, min_price, updated_at)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (product_id, marketplace) DO UPDATE SET min_price = $3, updated_at = CURRENT_TIMESTAMP`,
          [productId, marketplace, num]
        );
        logger.warn('[Prices Service] Column calculation_details missing — run migration 025. Saved min_price only.');
      } else {
        throw err;
      }
    }
  }

  /**
   * Получить сохранённые минимальные цены по списку product_id
   * @returns {Promise<Record<string, { ozon?: number, wb?: number, ym?: number }>>}
   */
  async getStoredPricesByProductIds(productIds) {
    if (!productIds?.length) return {};
    const ids = productIds.map(id => Number(id)).filter(n => !isNaN(n) && n > 0);
    if (!ids.length) return {};
    try {
      const result = await query(
        'SELECT product_id, marketplace, min_price FROM product_marketplace_prices WHERE product_id = ANY($1)',
        [ids]
      );
      const byProduct = {};
      result.rows.forEach(row => {
        const key = String(row.product_id);
        if (!byProduct[key]) byProduct[key] = {};
        const price = row.min_price != null ? parseFloat(row.min_price) : null;
        if (row.marketplace === 'ozon') byProduct[key].ozon = price;
        else if (row.marketplace === 'wb') byProduct[key].wb = price;
        else if (row.marketplace === 'ym') byProduct[key].ym = price;
      });
      return byProduct;
    } catch (err) {
      logger.warn('[Prices Service] getStoredPricesByProductIds failed (table may not exist):', err.message);
      return {};
    }
  }

  /**
   * Пересчитать и сохранить минимальные цены для одного товара.
   * Использовать в течение дня при изменении карточки (себестоимость, габариты, категория и т.д.):
   * по умолчанию запрашиваются актуальные данные MP (live); ночной массовый прогон строится на кэше после обновления комиссий.
   * @param {{ useCalculatorCache?: boolean }} [options] — true: только product_mp_calculator_cache (без HTTP к MP на этот вызов)
   */
  async recalculateAndSaveForProduct(productId, options = {}) {
    const errors = {};
    const productsRepo = repositoryFactory.getProductsRepository();
    const categoryMappingsRepo = repositoryFactory.getCategoryMappingsRepository();
    const product = await productsRepo.findById(productId);
    if (!product) return { errors: {} };

    const costPart = Number(product.cost ?? product.price ?? product.base_price ?? 0) || 0;
    const addExp = Number(product.additional_expenses ?? product.additionalExpenses ?? 0) || 0;
    const basePrice = costPart + addExp;
    const mpOpts = options.useCalculatorCache ? { source: 'cache' } : {};
    const minProfitRaw = (product.min_price != null && product.min_price !== '' && !isNaN(Number(product.min_price))) ? Number(product.min_price) : null;
    const minProfit = minProfitRaw != null ? minProfitRaw : 50;
    if (basePrice <= 0) {
      errors.wb = 'Нет себестоимости для расчёта минимальной цены WB.';
      return { errors };
    }

    let wbAcquiringPercent = null;
    let wbGemServicesPercent = null;
    try {
      const integrations = await integrationsService.getAll();
      const wb = integrations.find(i => i.code === 'wildberries' || i.code === 'wb');
      wbAcquiringPercent = wb?.config?.acquiring_percent != null ? Number(wb.config.acquiring_percent) : null;
      wbGemServicesPercent = wb?.config?.gem_services_percent != null ? Number(wb.config.gem_services_percent) : null;
    } catch (e) {
      logger.warn('[Prices Service] WB settings for recalc:', e.message);
    }

    const mappings = await categoryMappingsRepo.findAll({ productId });
    const skuOzon = product.sku_ozon || product.sku;
    const skuWb = product.sku_wb || product.sku;
    const skuYm = product.sku_ym || product.sku;
    const wbMapping = mappings.find(m => m.marketplace === 'wb' || m.marketplace === 'wildberries');
    const ymMapping = mappings.find(m => m.marketplace === 'ym' || m.marketplace === 'yandex');
    const wbCategoryId = wbMapping?.category_id ?? null;
    const ymCategoryId = ymMapping?.category_id ?? null;
    const ymUserCategoryId = !ymCategoryId && product.user_category_id ? product.user_category_id : null;

    let wbWarehouseName = null;
    try {
      const warehouses = await readData('warehouses') || [];
      const main = Array.isArray(warehouses) ? warehouses.find(w => w.type === 'warehouse' && w.wbWarehouseName) : null;
      wbWarehouseName = main?.wbWarehouseName || null;
      if (!wbWarehouseName) {
        const whRow = await query(
          `SELECT wb_warehouse_name FROM warehouses WHERE main_warehouse_id IS NULL AND type = 'warehouse' LIMIT 1`
        );
        const fromDb = whRow.rows[0]?.wb_warehouse_name;
        if (fromDb && String(fromDb).trim()) wbWarehouseName = String(fromDb).trim();
      }
    } catch (e) {}

    if (skuOzon) {
      try {
        const ozonResult = await this.getOzonPrices(skuOzon, mpOpts);
        const data = ozonResult?.data ?? ozonResult;
        if (data?.found && data?.calculator) {
          const price = calculateMinPrice(basePrice, data.calculator, 'ozon', minProfit, product);
          if (price != null) await this.saveProductMarketplacePrice(productId, 'ozon', price, data.calculator);
        } else if (data?.error) {
          errors.ozon = data.error;
          logger.warn(`[Prices Service] recalc Ozon for product ${productId}:`, data.error);
        }
      } catch (err) {
        errors.ozon = err.message || String(err);
        logger.warn(`[Prices Service] recalc Ozon for product ${productId}:`, err.message);
      }
    }

    // Логируем всегда (console.log), чтобы в консоли было видно путь для WB
    console.log(`[Prices Service] WB check product ${productId}: skuWb=${skuWb || 'null'}, wbCategoryId=${wbCategoryId ?? 'null'}, user_category_id=${product.user_category_id ?? 'null'}, willRunWB=${!!(skuWb && (wbCategoryId || product.user_category_id))}`);
    if (skuWb && (wbCategoryId || product.user_category_id)) {
      try {
        console.log(`[Prices Service] Calling getWBPrices for product ${productId} (${skuWb})...`);
        const wbResult = await this.getWBPrices(skuWb, wbCategoryId, wbWarehouseName, product.user_category_id || null, mpOpts);
        const data = wbResult?.data ?? wbResult;
        console.log(`[Prices Service] getWBPrices result product ${productId}: found=${!!data?.found}, hasCalculator=${!!data?.calculator}, error=${data?.error ? String(data.error).slice(0, 80) : 'none'}`);
        if (data?.found && data?.calculator) {
          const price = calculateMinPrice(basePrice, data.calculator, 'wb', minProfit, product, wbAcquiringPercent, wbGemServicesPercent);
          console.log(`[Prices Service] calculateMinPrice(WB) product ${productId}: price=${price}`);
          if (price != null) {
            await this.saveProductMarketplacePrice(productId, 'wb', price, data.calculator);
            console.log(`[Prices Service] *** Saved WB min price for product ${productId}: ${price} ₽ ***`);
          } else {
            console.log(`[Prices Service] WB price is NULL for product ${productId}, not saving`);
            errors.wb = 'Не удалось рассчитать минимальную цену WB (формула вернула пусто).';
          }
        } else {
          errors.wb = data?.error || data?.message || 'Не удалось рассчитать цену WB. Проверьте категорию, комиссии и привязку склада WB в настройках.';
          logger.warn(`[Prices Service] recalc WB for product ${productId}:`, errors.wb);
        }
      } catch (err) {
        errors.wb = err.message || String(err);
        console.log(`[Prices Service] getWBPrices threw for product ${productId}:`, err.message);
        logger.warn(`[Prices Service] recalc WB for product ${productId}:`, err.message);
      }
    } else if (skuWb) {
      errors.wb = 'Нет категории WB для расчёта. Укажите категорию товара или маппинг категории WB.';
      console.log(`[Prices Service] WB skipped product ${productId}: no category`);
    } else {
      errors.wb = 'Нет артикула WB для расчёта. Добавьте артикул WB в карточке товара или в разделе артикулов маркетплейсов.';
      console.log(`[Prices Service] WB skipped product ${productId}: no sku_wb`);
    }

    if (skuYm && (ymCategoryId || ymUserCategoryId)) {
      try {
        const ymResult = await this.getYMPrices(skuYm, ymCategoryId, ymUserCategoryId, mpOpts);
        const data = ymResult?.data ?? ymResult;
        if (data?.found && data?.calculator) {
          const price = calculateMinPrice(basePrice, data.calculator, 'ym', minProfit, product);
          if (price != null) await this.saveProductMarketplacePrice(productId, 'ym', price, data.calculator);
        } else if (data?.error) {
          errors.ym = data.error;
          logger.warn(`[Prices Service] recalc YM for product ${productId}:`, data.error);
        }
      } catch (err) {
        errors.ym = err.message || String(err);
        logger.warn(`[Prices Service] recalc YM for product ${productId}:`, err.message);
      }
    }

    logger.info(`[Prices Service] Recalculated and saved min prices for product ${productId}`);
    return { errors };
  }

  /**
   * Пересчитать и сохранить минимальные цены для всех товаров через live API на каждый SKU (медленно при больших каталогах).
   * Для ежесуточного полного прогона предпочтительны: sync калькулятора + {@link recalculateAndSaveAllFromCache}.
   */
  async recalculateAndSaveAll() {
    const productsRepo = repositoryFactory.getProductsRepository();
    const batchSize = 500;
    const delayMs = 800;
    let offset = 0;
    let totalProcessed = 0;

    while (true) {
      const products = await productsRepo.findAll({ limit: batchSize, offset });
      if (!products.length) break;

      for (let i = 0; i < products.length; i++) {
        await this.recalculateAndSaveForProduct(products[i].id);
        totalProcessed++;
        if (i < products.length - 1) await new Promise(r => setTimeout(r, delayMs));
      }
      logger.info(`[Prices Service] Recalculated batch: ${totalProcessed} products so far`);
      offset += batchSize;
    }

    logger.info(`[Prices Service] Recalculated and saved min prices for ${totalProcessed} products total`);
  }

  /**
   * Массовый пересчёт мин. цен только из кэша калькулятора (без HTTP к MP на каждый товар).
   * Сценарий раз в сутки: после обновления комиссий — sync кэша, затем этот метод (или ночной cron).
   */
  async recalculateAndSaveAllFromCache(opts = {}) {
    const productsRepo = repositoryFactory.getProductsRepository();
    const batchSize = opts.batchSize != null ? Number(opts.batchSize) : 500;
    let offset = 0;
    let totalProcessed = 0;

    while (true) {
      const products = await productsRepo.findAll({ limit: batchSize, offset });
      if (!products.length) break;

      for (let i = 0; i < products.length; i++) {
        await this.recalculateAndSaveForProduct(products[i].id, { useCalculatorCache: true });
        totalProcessed++;
      }
      logger.info(`[Prices Service] Recalculated from cache batch: ${totalProcessed} products so far`);
      offset += batchSize;
    }

    logger.info(`[Prices Service] Recalculated from cache for ${totalProcessed} products total`);
    return { totalProcessed };
  }
}

export default new PricesService();

