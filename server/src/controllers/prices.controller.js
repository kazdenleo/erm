/**
 * Prices Controller
 * HTTP контроллер для расчета цен на маркетплейсах
 */

import pricesService from '../services/prices.service.js';
import logger from '../utils/logger.js';

class PricesController {
  async getOzonPrices(req, res, next) {
    try {
      const { offer_id } = req.query;
      if (!offer_id) {
        return res.status(400).json({ ok: false, message: 'Необходим параметр offer_id' });
      }
      
      console.log(`[Prices Controller] Getting Ozon prices for offer_id: ${offer_id}`);
      const source = req.query.source === 'cache' ? 'cache' : 'live';
      const result = await pricesService.getOzonPrices(offer_id, { source });
      console.log(`[Prices Controller] Ozon prices result:`, result.found ? 'found' : 'not found');
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      console.error(`[Prices Controller] Error getting Ozon prices:`, error);
      next(error);
    }
  }

  async getWBPrices(req, res, next) {
    try {
      const { offer_id, category_id, wb_warehouse_name, user_category_id } = req.query;
      if (!offer_id) {
        return res.status(400).json({ ok: false, message: 'Необходим параметр offer_id' });
      }
      
      const result = await pricesService.getWBPrices(offer_id, category_id, wb_warehouse_name || null, user_category_id || null);
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getOzonActions(req, res, next) {
    try {
      const result = await pricesService.getOzonActions();
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
      }
      return res.status(200).json({ ok: true, data: result.result });
    } catch (error) {
      console.error('[Prices Controller] Error getting Ozon actions:', error);
      next(error);
    }
  }

  async getWBActions(req, res, next) {
    try {
      const result = await pricesService.getWBActions();
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
      }
      return res.status(200).json({ ok: true, data: result.data, lastUpdate: result.lastUpdate });
    } catch (error) {
      console.error('[Prices Controller] Error getting WB actions:', error);
      next(error);
    }
  }

  async getWBPromotionDetails(req, res, next) {
    try {
      const promotionId = req.params.promotionId;
      const result = await pricesService.getWBPromotionDetails(promotionId);
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
      }
      return res.status(200).json({ ok: true, data: result.promotion });
    } catch (error) {
      console.error('[Prices Controller] Error getting WB promotion details:', error);
      next(error);
    }
  }

  async getWBPromotionNomenclatures(req, res, next) {
    try {
      const promotionId = req.params.promotionId;
      const inAction = req.query.inAction === 'true';
      const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 1000));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const result = await pricesService.getWBPromotionNomenclatures(promotionId, inAction, limit, offset);
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error });
      }
      return res.status(200).json({
        ok: true,
        data: result.nomenclatures || [],
        total: result.total,
        notApplicable: result.notApplicable === true
      });
    } catch (error) {
      console.error('[Prices Controller] Error getting WB promotion nomenclatures:', error);
      next(error);
    }
  }

  async getOzonActionProducts(req, res, next) {
    try {
      const actionId = req.params.actionId || req.query.action_id || '';
      const result = await pricesService.getOzonActionProducts(actionId);
      // Минимальная цена берётся из БД при каждом запросе — не кэшировать ответ (иначе 304 отдаёт старые данные без min_price_ozon)
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('ETag', '');
      return res.status(200).json({
        ok: true,
        data: result.products || [],
        total: result.total ?? 0
      });
    } catch (error) {
      console.error('[Prices Controller] Error getting Ozon action products:', error);
      return res.status(200).json({ ok: true, data: [], total: 0 });
    }
  }

  async getOzonActionCandidates(req, res, next) {
    try {
      const actionId = req.params.actionId || req.query.action_id || '';
      const result = await pricesService.getOzonActionCandidates(actionId);
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('ETag', '');
      return res.status(200).json({
        ok: true,
        data: result.products || [],
        total: result.total ?? 0,
        ...(result.error && { error: result.error })
      });
    } catch (error) {
      console.error('[Prices Controller] Error getting Ozon action candidates:', error);
      return res.status(200).json({ ok: true, data: [], total: 0 });
    }
  }

  async getYMPrices(req, res, next) {
    try {
      const { offer_id, category_id, user_category_id } = req.query;
      console.log('[Prices Controller] getYMPrices request', { offer_id, category_id, user_category_id });
      if (!offer_id) {
        return res.status(400).json({ ok: false, message: 'Необходим параметр offer_id' });
      }
      
      const source = req.query.source === 'cache' ? 'cache' : 'live';
      const result = await pricesService.getYMPrices(offer_id, category_id || null, user_category_id || null, { source });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/product/prices/recalculate-all — запустить пересчёт всех минимальных цен в фоне (для 10k+ товаров) */
  async recalculateAll(req, res, next) {
    try {
      pricesService.recalculateAndSaveAll().catch(err => {
        console.error('[Prices Controller] Background recalculateAll failed:', err);
      });
      return res.status(202).json({
        ok: true,
        message: 'Пересчёт минимальных цен запущен в фоне. Обновите страницу через несколько минут.',
      });
    } catch (error) {
      console.error('[Prices Controller] recalculateAll error:', error);
      next(error);
    }
  }

  /** POST /api/product/prices/recalculate-all-from-cache — пересчёт из БД-кэша калькулятора без HTTP к MP на каждый SKU */
  async recalculateAllFromCache(req, res, next) {
    try {
      const body = req.body || {};
      pricesService.recalculateAndSaveAllFromCache({
        batchSize: body.batchSize
      }).catch(err => {
        console.error('[Prices Controller] Background recalculateAllFromCache failed:', err);
      });
      return res.status(202).json({
        ok: true,
        message: 'Пересчёт из кэша калькулятора запущен в фоне. Убедитесь, что sync-calculator-cache выполнялся недавно.',
      });
    } catch (error) {
      console.error('[Prices Controller] recalculateAllFromCache error:', error);
      next(error);
    }
  }

  /**
   * POST /api/product/prices/sync-calculator-cache — заполнить product_mp_calculator_cache из API.
   * По умолчанию фон (202): большие каталоги не упираются в таймаут HTTP.
   * Синхронный ответ: body.wait: true или query ?wait=1
   */
  async syncCalculatorCache(req, res, next) {
    try {
      const body = req.body || {};
      const payload = {
        marketplaces: body.marketplaces,
        limit: body.limit,
        delayMs: body.delayMs
      };
      const wait = body.wait === true || String(req.query.wait || '') === '1';
      if (!wait) {
        pricesService
          .syncCalculatorCacheFromApi(payload)
          .then((data) => {
            logger.info('[Prices Controller] sync-calculator-cache (фон) завершён', {
              ozon: data?.ozon?.updated,
              wb: data?.wb?.updated,
              ym: data?.ym?.updated
            });
          })
          .catch((err) => {
            logger.error('[Prices Controller] sync-calculator-cache (фон) ошибка:', err);
          });
        return res.status(202).json({
          ok: true,
          message:
            'Синхронизация кэша калькулятора запущена в фоне. Результат в логах сервера. Для синхронного ответа передайте wait: true или ?wait=1.',
        });
      }
      const result = await pricesService.syncCalculatorCacheFromApi(payload);
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      console.error('[Prices Controller] syncCalculatorCache error:', error);
      next(error);
    }
  }

  /** POST /api/product/prices/recalculate-one — точечный пересчёт при изменении данных по товару (по умолчанию live MP; body.useCalculatorCache=true — только из ночного кэша) */
  async recalculateForProduct(req, res, next) {
    try {
      const productId = req.params.productId ?? req.body?.productId;
      const id = parseInt(productId, 10);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ ok: false, message: 'Некорректный ID товара (передайте productId в теле запроса)' });
      }
      const useCalculatorCache = req.body?.useCalculatorCache === true;
      const result = await pricesService.recalculateAndSaveForProduct(id, { useCalculatorCache });
      return res.status(200).json({
        ok: true,
        message: 'Минимальные цены пересчитаны и сохранены',
        errors: result?.errors ?? {}
      });
    } catch (error) {
      console.error('[Prices Controller] recalculateForProduct error:', error);
      next(error);
    }
  }

  /** POST /api/product/prices/save-bulk — сохранить переданные рассчитанные цены в БД */
  async saveBulk(req, res, next) {
    try {
      const { prices: pricesList } = req.body || {};
      if (!Array.isArray(pricesList)) {
        return res.status(400).json({ ok: false, message: 'Необходим массив prices' });
      }
      await pricesService.saveBulkPrices(pricesList);
      return res.status(200).json({ ok: true, message: `Сохранено цен для ${pricesList.length} товаров` });
    } catch (error) {
      console.error('[Prices Controller] saveBulk error:', error);
      next(error);
    }
  }
}

export default new PricesController();

