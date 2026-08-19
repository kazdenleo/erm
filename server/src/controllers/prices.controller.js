/**
 * Prices Controller
 * HTTP контроллер для расчета цен на маркетплейсах
 */

import pricesService from '../services/prices.service.js';
import logger from '../utils/logger.js';
import {
  pushForProduct,
  pushForAllProfiles,
  pushForOrganization,
} from '../services/marketplaceMinPricePush.service.js';
import { isMarketplacePricePushEnabledForOrg } from '../utils/organizationMarketplacePricePushPolicy.js';

function formatPushSkipReason(reason) {
  switch (reason) {
    case 'disabled':
      return 'Отправка цен на маркетплейсы отключена на сервере';
    case 'in_progress':
      return 'Уже выполняется другая отправка цен. Подождите и попробуйте снова';
    case 'org_price_push_disabled':
      return 'У организации выключена «Автоматически отправлять цены на маркетплейсы». Включите в настройках организации.';
    case 'no_organization':
      return 'У товара не указана организация';
    case 'no_stored_min_prices':
      return 'Нет сохранённых минимальных цен — сначала пересчитайте цены';
    case 'product_not_found':
      return 'Товар не найден';
    case 'invalid_organization':
      return 'Некорректная организация';
    default:
      return reason ? `Пропущено: ${reason}` : 'Отправка пропущена';
  }
}

function summarizeProductPush(result) {
  if (!result) return { ok: false, message: 'Пустой ответ' };
  if (result.skipped && result.reason && !result.results) {
    return { ok: false, skipped: true, reason: result.reason, message: formatPushSkipReason(result.reason) };
  }
  const results = Array.isArray(result.results) ? result.results : [];
  const okMp = results.filter((r) => r.ok).map((r) => r.marketplace);
  const failMp = results.filter((r) => r.ok === false);
  const skipMp = results.filter((r) => r.skipped);
  if (failMp.length && !okMp.length) {
    return {
      ok: false,
      message: failMp.map((r) => `${r.marketplace}: ${r.error || 'ошибка'}`).join('; '),
      data: result,
    };
  }
  const parts = [];
  if (okMp.length) parts.push(`обновлено: ${okMp.join(', ').toUpperCase()}`);
  if (skipMp.length) {
    parts.push(
      `без изменений: ${skipMp.map((r) => `${String(r.marketplace).toUpperCase()} (${r.reason || 'ok'})`).join(', ')}`
    );
  }
  if (failMp.length) {
    parts.push(`ошибки: ${failMp.map((r) => `${r.marketplace}: ${r.error}`).join('; ')}`);
  }
  return {
    ok: true,
    message: parts.length ? parts.join('. ') : 'Цены на маркетплейсах актуальны',
    data: result,
  };
}

class PricesController {
  async getOzonPrices(req, res, next) {
    try {
      const { offer_id } = req.query;
      if (!offer_id) {
        return res.status(400).json({ ok: false, message: 'Необходим параметр offer_id' });
      }
      
      console.log(`[Prices Controller] Getting Ozon prices for offer_id: ${offer_id}`);
      const source = req.query.source === 'cache' ? 'cache' : 'live';
      const integrationScope = {
        profileId: req.user?.profileId ?? null,
        organizationId: req.headers['x-organization-id'] ?? req.query.organizationId ?? null,
      };
      const result = await pricesService.getOzonPrices(offer_id, { source, integrationScope });
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
      
      const integrationScope = {
        profileId: req.user?.profileId ?? null,
        organizationId: req.headers['x-organization-id'] ?? req.query.organizationId ?? null,
      };
      const result = await pricesService.getWBPrices(
        offer_id,
        category_id,
        wb_warehouse_name || null,
        user_category_id || null,
        { integrationScope }
      );
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  _integrationScopeFromReq(req) {
    return {
      profileId: req.user?.profileId ?? null,
      organizationId: req.headers['x-organization-id'] ?? req.query.organizationId ?? null,
    };
  }

  async getOzonActions(req, res, next) {
    try {
      const result = await pricesService.getOzonActions({
        integrationScope: this._integrationScopeFromReq(req),
      });
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
      const result = await pricesService.getWBActions({
        integrationScope: this._integrationScopeFromReq(req),
      });
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
      const result = await pricesService.getWBPromotionDetails(promotionId, {
        integrationScope: this._integrationScopeFromReq(req),
      });
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
      const result = await pricesService.getWBPromotionNomenclatures(
        promotionId,
        inAction,
        limit,
        offset,
        { integrationScope: this._integrationScopeFromReq(req) }
      );
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
      const result = await pricesService.getOzonActionProducts(actionId, {
        integrationScope: this._integrationScopeFromReq(req),
      });
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
      const result = await pricesService.getOzonActionCandidates(actionId, {
        integrationScope: this._integrationScopeFromReq(req),
      });
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
      const integrationScope = {
        profileId: req.user?.profileId ?? null,
        organizationId: req.headers['x-organization-id'] ?? req.query.organizationId ?? null,
      };
      const result = await pricesService.getYMPrices(offer_id, category_id || null, user_category_id || null, {
        source,
        integrationScope,
      });
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
      const integrationScope = {
        profileId: req.user?.profileId ?? null,
        organizationId: req.headers['x-organization-id'] ?? null,
      };
      const result = await pricesService.recalculateAndSaveForProduct(id, {
        useCalculatorCache,
        integrationScope,
      });
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

  /**
   * POST /api/product/prices/save-commercial
   * Body: { items: [{ productId, marketplace, sellingPrice?, priceBeforeDiscount?, discountPercent?, maxPrice? }] }
   */
  async saveCommercial(req, res, next) {
    try {
      const { items } = req.body || {};
      if (!Array.isArray(items)) {
        return res.status(400).json({ ok: false, message: 'Необходим массив items' });
      }
      const result = await pricesService.saveCommercialPrices(items);
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      console.error('[Prices Controller] saveCommercial error:', error);
      next(error);
    }
  }

  /**
   * POST /api/product/prices/push-one — отправить сохранённые мин. цены товара на МП.
   * Body: { productId }
   */
  async pushOne(req, res, next) {
    try {
      const productId = req.params.productId ?? req.body?.productId;
      const id = parseInt(productId, 10);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ ok: false, message: 'Некорректный ID товара (передайте productId)' });
      }
      const result = await pushForProduct(id);
      const summary = summarizeProductPush(result);
      if (!summary.ok) {
        const status = summary.reason === 'product_not_found' ? 404 : 400;
        return res.status(status).json({ ok: false, message: summary.message, reason: summary.reason, data: result });
      }
      return res.status(200).json({ ok: true, message: summary.message, data: result });
    } catch (error) {
      logger.error('[Prices Controller] pushOne error:', error);
      next(error);
    }
  }

  /**
   * POST /api/product/prices/push-all — отправить мин. цены на МП (фон).
   * Body: { organizationId? } — если указан, только эта организация (нужен флаг auto_push).
   */
  async pushAll(req, res, next) {
    try {
      const rawOrg = req.body?.organizationId ?? req.query?.organizationId ?? null;
      const organizationId =
        rawOrg != null && String(rawOrg).trim() !== '' ? parseInt(rawOrg, 10) : null;

      if (organizationId != null) {
        if (isNaN(organizationId) || organizationId <= 0) {
          return res.status(400).json({ ok: false, message: 'Некорректный organizationId' });
        }
        const allowed = await isMarketplacePricePushEnabledForOrg(organizationId);
        if (!allowed) {
          return res.status(400).json({
            ok: false,
            message: formatPushSkipReason('org_price_push_disabled'),
            reason: 'org_price_push_disabled',
          });
        }
        pushForOrganization(organizationId)
          .then((data) => {
            logger.info('[Prices Controller] push-all (org) завершён', data);
          })
          .catch((err) => {
            logger.error('[Prices Controller] push-all (org) ошибка:', err);
          });
        return res.status(202).json({
          ok: true,
          message:
            'Отправка цен на маркетплейсы запущена в фоне для выбранной организации. Обычно занимает несколько минут.',
        });
      }

      pushForAllProfiles()
        .then((data) => {
          logger.info('[Prices Controller] push-all завершён', data);
        })
        .catch((err) => {
          logger.error('[Prices Controller] push-all ошибка:', err);
        });
      return res.status(202).json({
        ok: true,
        message:
          'Отправка цен на маркетплейсы запущена в фоне (организации с включённой автоотправкой). Обычно занимает несколько минут.',
      });
    } catch (error) {
      logger.error('[Prices Controller] pushAll error:', error);
      next(error);
    }
  }

  /** POST /api/product/prices/ozon/block-auto-promotions/enforce */
  async enforceOzonBlockAutoPromotions(req, res, next) {
    try {
      const integrationScope = {
        profileId: req.user?.profileId ?? null,
        organizationId: req.headers['x-organization-id'] ?? req.query.organizationId ?? null,
      };
      const result = await pricesService.enforceOzonAutoPromotionsForScope({ integrationScope });
      if (!result?.ok && result?.error) {
        return res.status(400).json({ ok: false, error: result.error, ...result });
      }
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      logger.error('[Prices Controller] enforceOzonBlockAutoPromotions error:', error);
      next(error);
    }
  }

  /** POST /api/product/prices/ozon/ads-stats/sync — выгрузить ДРР из Performance API */
  async syncOzonAdsStats(req, res, next) {
    try {
      const ozonPerformanceAdsService = (await import('../services/ozonPerformanceAds.service.js'))
        .default;
      const integrationScope = {
        profileId: req.user?.profileId ?? null,
        organizationId: req.headers['x-organization-id'] ?? req.query.organizationId ?? null,
      };
      const days = req.body?.days != null ? Number(req.body.days) : 14;
      const result = await ozonPerformanceAdsService.syncAdsStats(integrationScope, { days });
      if (result?.skipped) {
        return res.status(400).json({
          ok: false,
          error:
            'Не заданы Performance Client ID / Secret в настройках интеграции Ozon (рекламный кабинет).',
          ...result,
        });
      }
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      logger.error('[Prices Controller] syncOzonAdsStats error:', error);
      next(error);
    }
  }
}

export default new PricesController();

