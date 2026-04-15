/**
 * Integrations Controller
 * HTTP контроллер для работы с настройками интеграций
 */

import integrationsService from '../services/integrations.service.js';
import logger from '../utils/logger.js';
import {
  isOzonSellerApiErrorMessage,
  parseOzonSellerApiHttpStatus
} from '../utils/ozon-api-error.js';

class IntegrationsController {
  /**
   * GET /api/integrations/marketplaces/:type
   * Получить настройки маркетплейса
   */
  async getMarketplace(req, res, next) {
    try {
      const { type } = req.params;
      const config = await integrationsService.getMarketplaceConfig(type, { profileId: req.user?.profileId ?? null });
      return res.status(200).json({ ok: true, data: config });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/integrations/marketplaces/:type
   * Сохранить настройки маркетплейса
   */
  async saveMarketplace(req, res, next) {
    try {
      const { type } = req.params;
      const result = await integrationsService.saveMarketplaceConfig(type, req.body);
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/suppliers/:type
   * Получить настройки поставщика
   */
  async getSupplier(req, res, next) {
    try {
      const { type } = req.params;
      const config = await integrationsService.getSupplierConfig(type);
      return res.status(200).json({ ok: true, data: config });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/integrations/suppliers/:type
   * Сохранить настройки поставщика
   */
  async saveSupplier(req, res, next) {
    try {
      const { type } = req.params;
      const result = await integrationsService.saveSupplierConfig(type, req.body);
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/all
   * Получить все настройки интеграций (только конфигурации)
   */
  async getAll(req, res, next) {
    try {
      const configs = await integrationsService.getAllConfigs({ profileId: req.user?.profileId ?? null });
      return res.status(200).json({ ok: true, data: configs });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations
   * Получить все интеграции (полный список с метаданными)
   */
  async getAllIntegrations(req, res, next) {
    try {
      const integrations = await integrationsService.getAll({ profileId: req.user?.profileId ?? null });
      return res.status(200).json({ ok: true, data: integrations });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/wildberries/tariffs
   * Получить тарифы на логистику Wildberries
   */
  async getWildberriesTariffs(req, res, next) {
    try {
      const { date } = req.query;
      const tariffs = await integrationsService.getWildberriesTariffs(date);
      return res.status(200).json({ ok: true, data: tariffs });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/ozon/warehouses
   */
  async getOzonWarehouses(req, res, next) {
    try {
      const data = await integrationsService.getOzonWarehouses();
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/yandex/campaigns
   */
  async getYandexCampaigns(req, res, next) {
    try {
      const data = await integrationsService.getYandexCampaigns();
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/wildberries/offices
   */
  async getWildberriesOffices(req, res, next) {
    try {
      const data = await integrationsService.getWildberriesOfficesForPass();
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/wildberries/warehouses
   */
  async getWildberriesSellerWarehouses(req, res, next) {
    try {
      const data = await integrationsService.getWildberriesSellerWarehouses();
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/integrations/marketplaces/wildberries/tariffs/update
   * Обновить тарифы Wildberries вручную
   */
  async updateWildberriesTariffs(req, res, next) {
    try {
      const result = await integrationsService.updateWildberriesTariffs();
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/wildberries/product-info
   * Получить карточку товара Wildberries по nm_id
   */
  async getWildberriesProductInfo(req, res, next) {
    try {
      const { nm_id } = req.query;
      const data = await integrationsService.getWildberriesProductInfo({ nm_id });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/:type/token-status
   * Проверить токен маркетплейса
   */
  async getMarketplaceTokenStatus(req, res, next) {
    try {
      const { type } = req.params;
      const data = await integrationsService.getMarketplaceTokenStatus(type, { profileId: req.user?.profileId ?? null });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/notifications
   * Уведомления по интеграциям (в т.ч. токены)
   */
  async getNotifications(req, res, next) {
    try {
      const { warn_days } = req.query;
      const data = await integrationsService.getTokenNotifications({
        warn_days,
        profileId: req.user?.profileId ?? null
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/wildberries/commissions
   * Получить комиссии Wildberries
   */
  async getWildberriesCommissions(req, res, next) {
    try {
      const { locale } = req.query;
      const commissions = await integrationsService.getWildberriesCommissions(locale || 'ru');
      return res.status(200).json({ ok: true, data: commissions });
    } catch (error) {
      logger.error('[Integrations Controller] Error getting WB commissions:', error);
      
      const errorMessage = error.message || '';
      
      // Если таблица не существует, возвращаем понятное сообщение
      if (errorMessage.includes('does not exist') || errorMessage.includes('relation') || error.code === '42P01') {
        return res.status(400).json({ 
          ok: false, 
          error: 'Таблица wb_commissions не существует в базе данных. Необходимо сначала обновить комиссии через кнопку "Обновить" или выполнить миграции.' 
        });
      }
      
      // Для остальных ошибок возвращаем 400
      return res.status(400).json({ 
        ok: false, 
        error: errorMessage || 'Ошибка при загрузке комиссий Wildberries. Проверьте подключение к базе данных.' 
      });
    }
  }

  /**
   * POST /api/integrations/marketplaces/wildberries/commissions/update
   * Обновить комиссии Wildberries вручную
   */
  async updateWildberriesCommissions(req, res, next) {
    try {
      const result = await integrationsService.updateWildberriesCommissions();
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      logger.error('[Integrations Controller] Error updating WB commissions:', error);
      
      const errorMessage = error.message || '';
      
      // Если таблица не существует, возвращаем понятное сообщение
      if (errorMessage.includes('does not exist') || errorMessage.includes('relation') || error.code === '42P01') {
        return res.status(400).json({ 
          ok: false, 
          error: 'Таблица wb_commissions не существует в базе данных. Необходимо выполнить миграции базы данных. Запустите команду: npm run migrate' 
        });
      }
      
      // Для всех остальных ошибок возвращаем 400 с понятным сообщением
      return res.status(400).json({ 
        ok: false, 
        error: errorMessage || 'Ошибка при обновлении комиссий Wildberries. Проверьте настройки интеграции и подключение к базе данных.' 
      });
    }
  }

  /**
   * GET /api/integrations/marketplaces/wildberries/categories
   * Получить категории Wildberries из комиссий
   */
  async getWildberriesCategories(req, res, next) {
    try {
      const categories = await integrationsService.getWildberriesCategories();
      // categories должен быть массивом (метод возвращает массив)
      return res.status(200).json({ ok: true, data: Array.isArray(categories) ? categories : [] });
    } catch (error) {
      logger.error('[Integrations Controller] Error getting WB categories:', error);
      
      const errorMessage = error.message || '';
      
      // Если таблица не существует или комиссий нет, возвращаем пустой массив
      if (errorMessage.includes('does not exist') || errorMessage.includes('relation') || error.code === '42P01') {
        logger.warn('[Integrations Controller] WB commissions table does not exist, returning empty categories');
        return res.status(200).json({ ok: true, data: [] });
      }
      
      // Для остальных ошибок возвращаем 400 с понятным сообщением
      return res.status(400).json({ 
        ok: false, 
        error: errorMessage || 'Ошибка при загрузке категорий Wildberries. Проверьте подключение к базе данных.' 
      });
    }
  }

  /**
   * POST /api/integrations/marketplaces/ozon/categories/update
   * Обновить категории Ozon вручную
   */
  async updateOzonCategories(req, res, next) {
    try {
      const result = await integrationsService.updateOzonCategories();
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      logger.error('[Integrations Controller] Error updating Ozon categories:', error);
      const errorMessage = error.message || '';
      
      // Если это ошибка конфигурации, возвращаем 400
      if (errorMessage.includes('Необходимы Client ID') || errorMessage.includes('настройте интеграцию')) {
        return res.status(400).json({ 
          ok: false, 
          error: errorMessage || 'Необходима настройка интеграции Ozon' 
        });
      }
      
      if (isOzonSellerApiErrorMessage(errorMessage)) {
        return res.status(400).json({
          ok: false,
          error: errorMessage || 'Ошибка при обращении к API Ozon'
        });
      }
      
      // Для остальных ошибок возвращаем 400
      return res.status(400).json({ 
        ok: false, 
        error: errorMessage || 'Ошибка при обновлении категорий Ozon' 
      });
    }
  }

  /**
   * GET /api/integrations/marketplaces/ozon/categories
   * Получить категории Ozon из БД или API.
   * ?force_refresh=1 — загружать из API Ozon.
   * ?db_only=1 — только из БД, без вызова внешнего API (быстрая загрузка для форм).
   */
  async getOzonCategories(req, res, next) {
    try {
      const forceRefresh = req.query.force_refresh === '1' || req.query.force_refresh === 'true';
      const dbOnly = req.query.db_only === '1' || req.query.db_only === 'true';
      const categories = await integrationsService.getOzonCategories({ forceRefresh, dbOnly });
      // categories должен быть массивом
      return res.status(200).json({ ok: true, data: Array.isArray(categories) ? categories : [] });
    } catch (error) {
      const errorMessage = error.message || '';
      const errorCode = error.code || '';
      
      logger.error('[Integrations Controller] Error getting Ozon categories:', {
        message: errorMessage,
        code: errorCode,
        stack: error.stack,
        includesOzon: errorMessage.includes('Ozon'),
        includesOzonAPI: errorMessage.includes('Ozon API error')
      });
      
      // Если таблица не существует, возвращаем понятное сообщение
      if (errorCode === '42P01' || errorMessage.includes('does not exist') || errorMessage.includes('relation')) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Таблица categories не существует в базе данных. Необходимо выполнить миграции базы данных. Запустите команду: npm run migrate'
        });
      }
      
      // Если это ошибка конфигурации, возвращаем 400 вместо 500
      if (errorMessage.includes('Необходимы Client ID') || 
          errorMessage.includes('настройте интеграцию') || 
          errorMessage.includes('настройке интеграцию') ||
          errorMessage.includes('Client ID или API Key не')) {
        return res.status(400).json({ 
          ok: false, 
          error: errorMessage || 'Необходима настройка интеграции Ozon' 
        });
      }
      
      if (isOzonSellerApiErrorMessage(errorMessage)) {
        const apiHttp = parseOzonSellerApiHttpStatus(errorMessage);
        const detail =
          errorMessage.length > 320 ? `${errorMessage.slice(0, 320)}…` : errorMessage;

        let userMessage = 'Ошибка при обращении к API Ozon';
        if (apiHttp === '404') {
          userMessage =
            'API Ozon вернул ошибку 404. Возможно, неправильный URL endpoint или неверные учетные данные. Проверьте Client ID и API Key в настройках интеграции. Убедитесь, что используете актуальные учетные данные из личного кабинета Ozon Seller.';
        } else if (apiHttp === '401' || apiHttp === '403') {
          userMessage =
            'Ошибка авторизации в API Ozon. Проверьте правильность Client ID и API Key в настройках интеграции.';
        } else if (apiHttp === '429') {
          userMessage = 'Превышен лимит запросов к API Ozon. Попробуйте позже.';
        } else if (apiHttp) {
          userMessage = `Ошибка API Ozon (HTTP ${apiHttp}). Проверьте настройки интеграции и ответ сервера.\n${detail}`;
        } else {
          userMessage = `Ошибка при обращении к Ozon. Детали:\n${detail}`;
        }

        logger.info('[Integrations Controller] Returning 400 for Ozon API error:', { apiHttp, userMessage });

        return res.status(400).json({
          ok: false,
          error: userMessage
        });
      }
      
      // Для всех остальных ошибок тоже возвращаем 400 с понятным сообщением
      // НЕ вызываем next(error), чтобы не попасть в errorHandler middleware
      logger.warn('[Integrations Controller] Unknown error type, returning 400:', {
        message: errorMessage,
        code: errorCode,
        fullError: error
      });
      
      // Если есть сообщение об ошибке, используем его, иначе общее
      const finalMessage = errorMessage || 'Ошибка при загрузке категорий Ozon. Проверьте настройки интеграции и подключение к базе данных.';
      
      return res.status(400).json({ 
        ok: false, 
        error: finalMessage
      });
    }
  }

  /**
   * GET /api/integrations/marketplaces/ozon/product-info
   * Данные товара из Ozon. Query: product_id (Ozon) или offer_id (артикул продавца).
   */
  async getOzonProductInfo(req, res, next) {
    try {
      const product_id = req.query.product_id ?? req.query.productId;
      const offer_id = req.query.offer_id ?? req.query.offerId;
      if ((product_id == null || product_id === '') && (offer_id == null || offer_id === '')) {
        return res.status(400).json({ ok: false, error: 'Укажите product_id (Ozon) или offer_id (артикул).' });
      }
      const item = await integrationsService.getOzonProductInfo({
        product_id: product_id != null && product_id !== '' ? Number(product_id) : undefined,
        offer_id: offer_id != null && offer_id !== '' ? String(offer_id).trim() : undefined
      });
      if (!item) {
        return res.status(404).json({ ok: false, error: 'Товар не найден в Ozon.' });
      }
      return res.status(200).json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/ozon/category-attributes
   * Характеристики категории Ozon. Query: description_category_id, type_id (опционально, по умолчанию 0).
   */
  async getOzonCategoryAttributes(req, res, next) {
    try {
      const description_category_id = req.query.description_category_id ?? req.query.descriptionCategoryId;
      const type_id = req.query.type_id ?? req.query.typeId ?? 0;
      const forceRefresh = req.query.force_refresh === '1' || req.query.force_refresh === 'true' || req.query.force === '1' || req.query.force === 'true';
      if (description_category_id == null || description_category_id === '') {
        return res.status(400).json({ ok: false, error: 'Укажите description_category_id' });
      }
      const list = await integrationsService.getOzonCategoryAttributes(description_category_id, type_id, { forceRefresh });
      return res.status(200).json({ ok: true, data: list });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/ozon/attribute-values
   * Справочник значений характеристики. Query: attribute_id, description_category_id, type_id, last_value_id?, limit?.
   */
  async getOzonAttributeValues(req, res, next) {
    try {
      const attribute_id = req.query.attribute_id ?? req.query.attributeId;
      const description_category_id = req.query.description_category_id ?? req.query.descriptionCategoryId;
      const type_id = req.query.type_id ?? req.query.typeId ?? 0;
      const last_value_id = req.query.last_value_id ?? req.query.lastValueId ?? 0;
      const limit = req.query.limit ?? 100;
      const forceRefresh = req.query.force_refresh === '1' || req.query.force_refresh === 'true' || req.query.force === '1' || req.query.force === 'true';
      if (attribute_id == null || attribute_id === '' || description_category_id == null || description_category_id === '') {
        return res.status(400).json({ ok: false, error: 'Укажите attribute_id и description_category_id' });
      }
      const result = await integrationsService.getOzonAttributeValues(
        attribute_id,
        description_category_id,
        type_id,
        { last_value_id, limit, forceRefresh }
      );
      return res.status(200).json({ ok: true, data: result.result, has_next: result.has_next });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/ozon/attribute-values/search
   * Поиск справочных значений по value. Query: attribute_id, description_category_id, type_id, value.
   */
  async searchOzonAttributeValues(req, res, next) {
    try {
      const attribute_id = req.query.attribute_id ?? req.query.attributeId;
      const description_category_id = req.query.description_category_id ?? req.query.descriptionCategoryId;
      const type_id = req.query.type_id ?? req.query.typeId ?? 0;
      const value = req.query.value ?? '';
      if (attribute_id == null || attribute_id === '' || description_category_id == null || description_category_id === '') {
        return res.status(400).json({ ok: false, error: 'Укажите attribute_id и description_category_id' });
      }
      const list = await integrationsService.searchOzonAttributeValues(
        attribute_id,
        description_category_id,
        type_id,
        value
      );
      return res.status(200).json({ ok: true, data: list });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/marketplaces/yandex/categories
   * Получить категории Яндекс.Маркета из БД или API
   * ?force_refresh=1 — загрузить из API
   * ?db_only=1 — только из БД, без вызова внешнего API
   */
  async getYandexCategories(req, res, next) {
    try {
      const forceRefresh = req.query.force_refresh === '1' || req.query.force_refresh === 'true';
      const dbOnly = req.query.db_only === '1' || req.query.db_only === 'true';
      const categories = await integrationsService.getYandexCategories({ forceRefresh, dbOnly });
      return res.status(200).json({ ok: true, data: Array.isArray(categories) ? categories : [] });
    } catch (error) {
      logger.error('[Integrations Controller] Error getting Yandex categories:', error);
      const errorMessage = error.message || '';
      if (errorMessage.includes('API Key') || errorMessage.includes('настройте')) {
        return res.status(400).json({ ok: false, error: errorMessage || 'Настройте интеграцию Яндекс.Маркета' });
      }
      return res.status(400).json({ ok: false, error: errorMessage || 'Ошибка при загрузке категорий Яндекс.Маркета' });
    }
  }

  /**
   * POST /api/integrations/marketplaces/yandex/categories/update
   * Обновить категории Яндекс.Маркета вручную
   */
  async updateYandexCategories(req, res, next) {
    try {
      const result = await integrationsService.updateYandexCategories();
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      logger.error('[Integrations Controller] Error updating Yandex categories:', error);
      const errorMessage = error.message || '';
      return res.status(400).json({ ok: false, error: errorMessage || 'Ошибка при обновлении категорий Яндекс.Маркета' });
    }
  }
}

export default new IntegrationsController();

